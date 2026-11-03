#!/usr/bin/env python3
"""Exercise the documented off-host GPG send/restore snippets on disposable synthetic data."""
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOC = (ROOT / "docs/layerfs-offhost-backup-recovery.md").read_text()
BLOCKS = re.findall(r"\x60{3}bash\n(.*?)\n\x60{3}", DOC, re.S)
if len(BLOCKS) != 2:
    raise SystemExit(f"expected two documented bash blocks, found {len(BLOCKS)}")
for block in BLOCKS:
    subprocess.run(["bash", "-n"], input=block, text=True, check=True)
print("PASS documented bash blocks parse")

with tempfile.TemporaryDirectory(prefix="layerfs-gpg-runbook-") as temp:
    base = pathlib.Path(temp)
    home, stage, outdir, restore_parent = (base / n for n in ("gnupg", "stage", "out", "restore"))
    for p in (home, stage, outdir, restore_parent):
        p.mkdir(mode=0o700)
    os.chmod(home, 0o700)
    (stage / "marker.txt").write_bytes(b"synthetic LayerFS snapshot\x00" + os.urandom(64))
    (stage / "tree").mkdir()
    (stage / "tree" / "file.bin").write_bytes(os.urandom(512))
    subprocess.run(["gpg", "--homedir", str(home), "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Disposable LayerFS Runbook <runbook@example.invalid>", "rsa2048", "encr", "1d"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    listing = subprocess.run(["gpg", "--homedir", str(home), "--batch", "--with-colons", "--list-keys"], check=True, text=True, capture_output=True).stdout
    fprs = [line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:")]
    if not fprs:
        raise SystemExit("temporary test key did not produce a fingerprint")
    env = os.environ.copy()
    env.update({"RECIPIENT_FPR": fprs[0], "STAGE": str(stage), "ARCHIVE": str(base / "plain.tar.gz"), "OUT": str(outdir / "backup.gpg"), "GPG_HOME": str(home)})
    subprocess.run(["bash", "-euo", "pipefail", "-c", BLOCKS[0]], env=env, check=True, cwd=ROOT)
    cipher = pathlib.Path(env["OUT"])
    if not cipher.is_file() or not pathlib.Path(str(cipher) + ".sha256").is_file() or pathlib.Path(env["ARCHIVE"]).exists():
        raise SystemExit("sender did not atomically publish ciphertext/checksum and remove plaintext")
    restore = restore_parent / "restored"
    receiver_env = {**env, "CIPHER": str(cipher), "RESTORE_DIR": str(restore)}
    subprocess.run(["bash", "-euo", "pipefail", "-c", BLOCKS[1]], env=receiver_env, check=True, cwd=ROOT)
    if (restore / "marker.txt").read_bytes() != (stage / "marker.txt").read_bytes() or (restore / "tree/file.bin").read_bytes() != (stage / "tree/file.bin").read_bytes():
        raise SystemExit("round-trip bytes differ")
    print("PASS exact runbook GPG round-trip and checksum")

    def sender_refused(env_override, label, preserve=None):
        candidate = {**env, **env_override}
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", BLOCKS[0]], env=candidate, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode == 0:
            raise SystemExit(f"sender unexpectedly accepted {label}")
        if preserve is not None and preserve.read_bytes() != b"owner data":
            raise SystemExit(f"sender modified pre-existing destination for {label}")
        print(f"PASS sender refuses {label}")

    invalid_archive = base / "invalid-fpr.tar.gz"
    sender_refused({"RECIPIENT_FPR": "not-a-fingerprint", "ARCHIVE": str(invalid_archive), "OUT": str(outdir / "invalid.gpg")}, "invalid recipient fingerprint")
    if invalid_archive.exists():
        raise SystemExit("invalid fingerprint generated plaintext archive")
    overlap_output = stage / "inside.gpg"
    sender_refused({"ARCHIVE": str(base / "overlap.tar.gz"), "OUT": str(overlap_output)}, "output inside staged tree")
    if overlap_output.exists():
        raise SystemExit("sender published into the staged tree")
    occupied = outdir / "occupied.gpg"
    occupied.write_bytes(b"owner data")
    sender_refused({"ARCHIVE": str(base / "occupied.tar.gz"), "OUT": str(occupied)}, "pre-existing output", occupied)
    if (base / "occupied.tar.gz").exists():
        raise SystemExit("sender generated plaintext before refusing existing output")

    tampered = outdir / "tampered.gpg"
    content = bytearray(cipher.read_bytes())
    content[len(content) // 2] ^= 0x01
    tampered.write_bytes(content)
    digest = subprocess.run(["sha256sum", str(tampered)], check=True, text=True, capture_output=True).stdout.split()[0]
    (outdir / "tampered.gpg.sha256").write_text(f"{digest}  tampered.gpg\n")
    tamper_dest = restore_parent / "tampered"
    failed = subprocess.run(["bash", "-euo", "pipefail", "-c", BLOCKS[1]], env={**env, "CIPHER": str(tampered), "RESTORE_DIR": str(tamper_dest)}, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if failed.returncode == 0 or tamper_dest.exists():
        raise SystemExit("tampered ciphertext accepted or destination created")
    print("PASS ciphertext bit-flip rejected before destination creation")

    malicious = base / "traversal.tar.gz"
    with tarfile.open(malicious, "w:gz") as archive:
        info = tarfile.TarInfo("../../escaped.txt")
        info.size = 4
        import io
        archive.addfile(info, io.BytesIO(b"evil"))
    malicious_cipher = outdir / "traversal.gpg"
    subprocess.run(["gpg", "--homedir", str(home), "--batch", "--recipient", fprs[0] + "!", "--encrypt", "--output", str(malicious_cipher), str(malicious)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    digest = subprocess.run(["sha256sum", str(malicious_cipher)], check=True, text=True, capture_output=True).stdout.split()[0]
    (outdir / "traversal.gpg.sha256").write_text(f"{digest}  traversal.gpg\n")
    traversal_dest = restore_parent / "traversal"
    failed = subprocess.run(["bash", "-euo", "pipefail", "-c", BLOCKS[1]], env={**env, "CIPHER": str(malicious_cipher), "RESTORE_DIR": str(traversal_dest)}, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if failed.returncode == 0 or traversal_dest.exists() or (base / "escaped.txt").exists():
        raise SystemExit("unsafe archive accepted, destination created, or traversal escaped")
    print("PASS traversal archive rejected before destination creation")

print("LayerFS GPG runbook: 7 checks passed; disposable key and archive removed")
