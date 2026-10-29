#!/usr/bin/env bash
# Exact-commit, shallow object context; never copy source .git/config or untracked files.
# Usage: build-layerfs.sh SOURCE NEW_CONTEXT [--prepare-only]
# Then: LAYERFS_CONTEXT=NEW_CONTEXT docker compose -f deploy/docker-compose.yml --profile layerfs build layerfs
set -euo pipefail
PIN=9f97a7ec95b662e9cb288704afa165feff132cfa
SRC="${1:?source checkout required}"
DEST="${2:?new context directory required}"
MODE="${3:---build}"
[ "$MODE" = --prepare-only ] || [ "$MODE" = --build ] || { echo 'invalid mode' >&2; exit 2; }
[ "${LAYERFS_COMMIT:-$PIN}" = "$PIN" ] || { echo 'only exact approved pin allowed' >&2; exit 3; }
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$SRC" && pwd -P)"
[ "$(git -C "$SRC" rev-parse "$PIN^{commit}")" = "$PIN" ] || exit 3
[ ! -e "$DEST" ] || { echo 'context must not exist' >&2; exit 2; }
mkdir -p "$(dirname "$DEST")"
DEST_PARENT="$(cd "$(dirname "$DEST")" && pwd -P)"
DEST="$DEST_PARENT/$(basename "$DEST")"
case "$DEST/" in "$SRC/"*) echo 'context must be outside source' >&2; exit 2;; esac
mkdir "$DEST"
# Review exact commit filenames, not current checkout or history; no links/gitlinks/secrets.
git -C "$SRC" ls-tree -r --name-only -z "$PIN" > "$DEST/tracked-paths.nul"
if git -C "$SRC" ls-tree -r "$PIN" | awk '$1 == "120000" || $1 == "160000" { found=1 } END { exit !found }'; then
  echo 'links/submodules require separate reviewed context policy' >&2; exit 4
fi
if LC_ALL=C grep -zE '(^|/)([.]env([.]|$)|[.]credentials|id_rsa|id_ed25519|credentials[.](json|ya?ml)$)|[.](pem|p12|pfx|key)$' "$DEST/tracked-paths.nul" >/dev/null; then
  echo 'credential-shaped tracked path: stop, do not copy' >&2; exit 4
fi
mkdir "$DEST/src"
git -C "$SRC" archive "$PIN" | tar -x -C "$DEST/src"
# One commit + its tree/blob closure only: no history, refs, remotes, hooks or source config.
git -c init.defaultBranch=context init --quiet --template= "$DEST/src"
git -C "$DEST/src" config core.autocrlf false
mkdir -p "$DEST/src/.git/info"
printf '%s\n' "$PIN" > "$DEST/src/.git/shallow"
{ printf '%s\n' "$PIN"; git -C "$SRC" rev-list --objects "$PIN^{tree}" | cut -d' ' -f1; }  | git -C "$SRC" pack-objects --stdout > "$DEST/pinned-transfer.pack"
git -C "$DEST/src" index-pack --stdin < "$DEST/pinned-transfer.pack" >/dev/null
# Transfer pack stays outside src/; Dockerfile copies only src/.
git -C "$DEST/src" read-tree "$PIN"
git -C "$DEST/src" checkout --quiet --detach "$PIN"
[ "$(git -C "$DEST/src" rev-parse HEAD)" = "$PIN" ] || exit 3
[ -z "$(git -C "$DEST/src" status --porcelain --untracked-files=all)" ] || { echo 'context differs from pin' >&2; exit 4; }
# Context root deliberately has no .dockerignore; original src/.dockerignore is unchanged.
node - "$DEST" "$PIN" "$(git -C "$SRC" rev-parse "$PIN^{tree}")" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [root,commit,tree]=process.argv.slice(2),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files=fs.readFileSync(path.join(root,'tracked-paths.nul'),'utf8').split('\0').filter(Boolean).map(p=>({path:p,bytes:fs.statSync(path.join(root,'src',p)).size,sha256:hash(path.join(root,'src',p))}));
fs.writeFileSync(path.join(root,'source-manifest.json'),JSON.stringify({commit,tree,source:'git archive exact commit; one shallow commit object closure; source config/untracked/history excluded',files},null,2));
console.log(JSON.stringify({context:root,commit,tree,files:files.length,manifest_sha256:hash(path.join(root,'source-manifest.json'))}));
NODE
if [ "$MODE" = --build ]; then
  LAYERFS_CONTEXT="$DEST" docker compose -f "$DIR/docker-compose.yml" --profile layerfs build layerfs
fi
