#!/bin/sh
set -eu
: "${1:?usage: restore-postgres.sh SOURCE.dump NEW_DATABASE}"
archive=$1
db=${2:?provide a new target database name}
[ -f "$archive" ] || { echo "backup not found: $archive" >&2; exit 1; }
case "$db" in *[!a-zA-Z0-9_]*|'') echo 'invalid target database name' >&2; exit 2 ;; esac
[ "$db" != ygl ] || { echo 'restore must target a new database name, never the live ygl database' >&2; exit 2; }
: "${YGL_PG_PASSWORD_FILE:?set protected secret file path}"
[ -f "$archive.sha256" ] && [ ! -L "$archive.sha256" ] || { echo "required checksum sidecar missing or unsafe" >&2; exit 1; }
(cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")
compose() { docker compose --profile pg-mirror --profile pg-sync -f docker-compose.yml -f docker-compose.pg.yml "$@"; }
compose exec -T ygl-pg sh -c 'export PGPASSWORD="$(cat /run/secrets/ygl_pg_password)"; exec pg_restore --list' < "$archive" >/dev/null
compose exec -T -e YGL_RESTORE_DB="$db" ygl-pg sh -c 'export PGPASSWORD="$(cat /run/secrets/ygl_pg_password)"; exec createdb -h 127.0.0.1 -U ygl "$YGL_RESTORE_DB"'
if ! compose exec -T -e YGL_RESTORE_DB="$db" ygl-pg sh -c 'export PGPASSWORD="$(cat /run/secrets/ygl_pg_password)"; exec pg_restore --exit-on-error -h 127.0.0.1 -U ygl -d "$YGL_RESTORE_DB"' < "$archive"; then
  compose exec -T -e YGL_RESTORE_DB="$db" ygl-pg sh -c 'export PGPASSWORD="$(cat /run/secrets/ygl_pg_password)"; exec dropdb -h 127.0.0.1 -U ygl "$YGL_RESTORE_DB"' >/dev/null 2>&1 || true
  exit 1
fi
compose exec -T -e YGL_RESTORE_DB="$db" ygl-pg sh -c 'export PGPASSWORD="$(cat /run/secrets/ygl_pg_password)"; exec psql -h 127.0.0.1 -U ygl -d "$YGL_RESTORE_DB" -Atc "select count(*) from information_schema.tables where table_schema = current_schema()"'
echo "restored into new database: $db; verify row counts before promotion"
