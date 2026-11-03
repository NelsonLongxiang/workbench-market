# LayerFS off-host backup and recovery (generic template)

Use stopped, consistent data only. Replace all paths with approved local paths. Never publish host identifiers, container/volume names, deployment history, image digests, operator paths, or credentials. SHA256 sidecars detect accidental damage but do not authenticate a sender.

## Send an encrypted archive

Required variables: RECIPIENT_FPR (independently verified key fingerprint), STAGE (consistent snapshot), ARCHIVE (temporary plaintext archive), OUT (new encrypted output), and GPG_HOME (protected keyring). Keep outputs outside STAGE.

```bash
set -euo pipefail
: "${RECIPIENT_FPR:?verified recipient fingerprint required}"
: "${STAGE:?consistent stopped/staged snapshot required}"
: "${ARCHIVE:?absolute plaintext archive path required}"
: "${OUT:?absolute encrypted output path required}"
: "${GPG_HOME:?private GPG home required}"
[[ "$RECIPIENT_FPR" =~ ^([A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$ ]]
[[ "$STAGE" = /* && "$ARCHIVE" = /* && "$OUT" = /* && "$GPG_HOME" = /* ]]
[[ "$(basename "$OUT")" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
test -d "$STAGE" && test -d "$GPG_HOME" && test ! -e "$ARCHIVE" && test ! -L "$ARCHIVE" && test ! -e "$OUT" && test ! -L "$OUT" && test ! -e "$OUT.sha256" && test ! -L "$OUT.sha256"
STAGE_REAL="$(realpath -e "$STAGE")"
for candidate in "$ARCHIVE" "$OUT" "$OUT.sha256"; do
  CANDIDATE_REAL="$(realpath -m "$candidate")"
  case "$CANDIDATE_REAL" in "$STAGE_REAL"|"$STAGE_REAL"/*) echo 'archive/output must be outside stage' >&2; exit 2;; esac
done
umask 077
install -d -m 0700 "$(dirname "$ARCHIVE")" "$(dirname "$OUT")"
tar --numeric-owner --xattrs --acls -C "$STAGE" -czf "$ARCHIVE" .
chmod 0600 "$ARCHIVE"
tmp="$(mktemp "$(dirname "$OUT")/.layerfs-encrypted.XXXXXX")"
sumtmp="$(mktemp "$(dirname "$OUT")/.layerfs-sha256.XXXXXX")"
trap 'rm -f -- "$ARCHIVE" "$tmp" "$sumtmp"' EXIT
gpg --homedir "$GPG_HOME" --batch --yes --status-fd 2 --recipient "$RECIPIENT_FPR!" --encrypt --output "$tmp" "$ARCHIVE"
chmod 0600 "$tmp"
test -s "$tmp"
digest="$(sha256sum "$tmp" | awk '{print $1}')"
printf '%s  %s\n' "$digest" "$(basename "$OUT")" > "$sumtmp"
chmod 0600 "$sumtmp"
# Atomic no-overwrite publication; both links fail if either destination already exists.
ln "$tmp" "$OUT"
if ! ln "$sumtmp" "$OUT.sha256"; then rm -f -- "$OUT"; exit 1; fi
```

## Receive and validate

Use a dedicated restore host and trusted private key; never restore over an existing target. This validation applies compressed-size, expanded-size, member-count and time limits, rejecting traversal, duplicate paths, links and special files before extraction.

```bash
set -euo pipefail
: "${GPG_HOME:?private key home required}"
: "${CIPHER:?encrypted archive required}"
: "${RESTORE_DIR:?empty isolated restore directory required}"
[[ "$CIPHER" = /* && "$RESTORE_DIR" = /* && "$GPG_HOME" = /* ]]
test -s "$CIPHER" && test -f "$CIPHER.sha256" && test ! -L "$CIPHER" && test ! -L "$CIPHER.sha256" && test -d "$GPG_HOME"
# Reject unexpectedly large encrypted inputs before invoking the decryptor.
MAX_CIPHER_BYTES=$((2 * 1024 * 1024 * 1024))
CIPHER_BYTES=$(stat -c %s -- "$CIPHER")
(( CIPHER_BYTES <= MAX_CIPHER_BYTES )) || { echo "ciphertext exceeds size limit" >&2; exit 1; }
(cd "$(dirname "$CIPHER")" && sha256sum -c "$(basename "$CIPHER").sha256")
test ! -e "$RESTORE_DIR" && test ! -L "$RESTORE_DIR"
install -d -m 0700 "$(dirname "$RESTORE_DIR")"
plain="$(mktemp "$(dirname "$RESTORE_DIR")/.restore-plain.XXXXXX")"
trap 'rm -f -- "$plain"' EXIT
gpg --homedir "$GPG_HOME" --batch --yes --status-fd 2 --output "$plain" --decrypt "$CIPHER"
# Reject absolute/traversal paths and links/devices before extraction. This intentionally
# trades symlink preservation for a simpler, fail-closed recovery staging tree.
python3 - "$plain" <<'PY'
import pathlib, sys, tarfile, time
MAX_MEMBERS = 100_000
MAX_EXPANDED_BYTES = 20 * 1024**3
MAX_COMPRESSED_BYTES = 2 * 1024**3
MAX_SECONDS = 120
archive_path = pathlib.Path(sys.argv[1])
if archive_path.stat().st_size > MAX_COMPRESSED_BYTES:
    raise SystemExit("compressed archive exceeds size limit")
started = time.monotonic()
with tarfile.open(archive_path, "r|gz") as archive:
    seen = set()
    count = total = 0
    for member in archive:
        if time.monotonic() - started > MAX_SECONDS:
            raise SystemExit("archive validation exceeded wall-clock limit")
        count += 1
        total += member.size
        path = pathlib.PurePosixPath(member.name)
        normalized = str(path)
        if (count > MAX_MEMBERS or total > MAX_EXPANDED_BYTES or member.size < 0
                or path.is_absolute() or ".." in path.parts or normalized in seen
                or not (member.isfile() or member.isdir())):
            raise SystemExit("unsafe or oversized archive refused")
        seen.add(normalized)
PY
# Only create the destination after GPG integrity and all archive members validate.
install -d -m 0700 "$RESTORE_DIR"
tar --numeric-owner --xattrs --acls --no-same-owner --no-same-permissions -xzf "$plain" -C "$RESTORE_DIR"
rm -f -- "$plain"
```

## Mandatory post-extraction verification

Before any recovery, produce a canonical manifest over relative path, file type, size and SHA256 from the isolated extracted tree. Verify its detached signature against a pre-pinned trusted public key, then compare every manifest entry exactly with the independently signed expected manifest. If the archive process does not provide that signature and expected manifest, STOP: a checksum file alone is not authenticity. Next validate LayerFS project manifests and SQLite integrity, confirm no target project/volume exists, then boot an isolated copy and verify API cold reads. Never start production directly from an unvalidated archive.
