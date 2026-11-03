#!/bin/sh
set -eu
: "${1:?usage: backup-sqlite.sh DESTINATION.tar.gz}"
archive=$1
volume=${YGL_HOME_VOLUME:-ygl-trees-home-local}
case "$archive" in /*) ;; *) archive="$(pwd)/$archive" ;; esac
[ ! -e "$archive" ] && [ ! -L "$archive" ] && [ ! -e "$archive.sha256" ] && [ ! -L "$archive.sha256" ] || { echo "refusing to overwrite archive or checksum" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }
parent=$(dirname "$archive")
mkdir -p "$parent"
tmp=$(mktemp "$parent/.ygl-sqlite-backup.XXXXXX")
sumtmp=$(mktemp "$parent/.ygl-sqlite-checksum.XXXXXX")
trap 'rm -f -- "$tmp" "$sumtmp"' EXIT HUP INT TERM
echo 'Quiesce MCP/CLI writers before backup.' >&2
docker run --rm --network none --mount "type=volume,src=$volume,dst=/data,readonly" alpine:3.20 tar -C /data -czf - . > "$tmp"
test -s "$tmp"
gzip -t "$tmp"
sha256sum "$tmp" | awk -v name="$(basename "$archive")" '{print $1 "  " name}' > "$sumtmp"
chmod 0600 "$tmp" "$sumtmp"
ln "$tmp" "$archive"
if ! ln "$sumtmp" "$archive.sha256"; then rm -f -- "$archive"; exit 1; fi
printf 'backup=%s\nsha256=' "$archive"
sha256sum "$archive" | cut -d ' ' -f1
