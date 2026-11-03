#!/bin/sh
set -eu
: "${1:?usage: restore-sqlite.sh SOURCE.tar.gz NEW_EMPTY_VOLUME}"
archive=$1
volume=${2:?provide a NEW empty volume name}
[ -f "$archive" ] || { echo "backup not found: $archive" >&2; exit 1; }
case "$volume" in *[!a-zA-Z0-9_.-]*|'') echo 'invalid Docker volume name' >&2; exit 2 ;; esac
if docker volume inspect "$volume" >/dev/null 2>&1; then echo "refusing to restore into existing volume: $volume" >&2; exit 2; fi
[ -f "$archive.sha256" ] && [ ! -L "$archive.sha256" ] || { echo "required checksum sidecar missing or unsafe" >&2; exit 1; }
(cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")
gzip -t "$archive"
# Fail closed on traversal, duplicate paths, links/devices, and oversized archives before creating a volume.
python3 - "$archive" <<'PY'
import pathlib,sys,tarfile
count=total=0; seen=set()
with tarfile.open(sys.argv[1],"r:gz") as archive:
 for member in archive:
  count+=1; total+=member.size; path=pathlib.PurePosixPath(member.name); norm=str(path)
  if count>100000 or total>20*1024**3 or member.size<0 or path.is_absolute() or ".." in path.parts or norm in seen or not (member.isfile() or member.isdir()):
   raise SystemExit("unsafe or oversized SQLite archive refused")
  seen.add(norm)
PY
# Recheck target just before creation, then remove the newly created volume if extraction fails.
if docker volume inspect "$volume" >/dev/null 2>&1; then echo "volume appeared before restore: $volume" >&2; exit 2; fi
docker volume create "$volume" >/dev/null
if ! docker run --rm -i --network none --mount "type=volume,src=$volume,dst=/data" alpine:3.20 tar -C /data -xzf - < "$archive"; then
  docker volume rm "$volume" >/dev/null 2>&1 || true
  exit 1
fi
echo "restored into new volume: $volume; run ygl-trees doctor before use"
