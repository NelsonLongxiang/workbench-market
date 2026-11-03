#!/bin/sh
set -eu
: "${1:?usage: backup-postgres.sh DESTINATION.dump}"
archive=$1
[ ! -e "$archive" ] && [ ! -L "$archive" ] || { echo "refusing to overwrite existing archive: $archive" >&2; exit 2; }
: "${YGL_PG_PASSWORD_FILE:?set protected secret file path}"
parent=$(dirname "$archive")
mkdir -p "$parent"
tmp=$(mktemp "$parent/.pg-backup.XXXXXX")
sumtmp=$(mktemp "$parent/.pg-backup-sha256.XXXXXX")
trap 'rm -f -- "$tmp" "$sumtmp"' EXIT HUP INT TERM
compose() { docker compose --profile pg-mirror --profile pg-sync -f docker-compose.yml -f docker-compose.pg.yml "$@"; }
compose exec -T ygl-pg sh -c 'export PGPASSWORD="$(cat /run/secrets/ygl_pg_password)"; exec pg_dump -h 127.0.0.1 -U ygl -d ygl -Fc' > "$tmp"
test -s "$tmp"
compose exec -T ygl-pg sh -c 'export PGPASSWORD="$(cat /run/secrets/ygl_pg_password)"; exec pg_restore --list' < "$tmp" >/dev/null
sha256sum "$tmp" | awk -v name="$(basename "$archive")" '{print $1 "  " name}' > "$sumtmp"
chmod 0600 "$tmp" "$sumtmp"
# No-overwrite hard links publish the verified archive and checksum atomically per file.
ln "$tmp" "$archive"
if ! ln "$sumtmp" "$archive.sha256"; then rm -f -- "$archive"; exit 1; fi
printf 'PostgreSQL archive verified: %s\n' "$archive"
