#!/bin/sh
set -eu
: "${1:?usage: backup-sqlite.sh DESTINATION.tar.gz}"
archive=$1
project=${COMPOSE_PROJECT_NAME:-ygl-trees-candidate}
: "${YGL_HOME_VOLUME:?set the exact disposable candidate volume name explicitly}"
volume=$YGL_HOME_VOLUME
service=${YGL_WORKSPACE_SERVICE:-ygl-workspace}
[ "$volume" != ygl-trees-home-local ] || { echo "refusing shared/default candidate volume; use a uniquely named disposable volume" >&2; exit 2; }
case "$archive" in /*) ;; *) archive="$(pwd)/$archive" ;; esac
[ ! -e "$archive" ] && [ ! -L "$archive" ] && [ ! -e "$archive.sha256" ] && [ ! -L "$archive.sha256" ] || { echo "refusing to overwrite archive or checksum" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }
# Fail closed if any container still uses this volume.
# Caller must stop the candidate workspace and any other volume users.
running=$(docker ps --filter "volume=$volume" --format '{{.ID}}')
[ -z "$running" ] || { echo "refusing SQLite backup: stop every existing container mounting volume $volume before locking" >&2; exit 3; }
# Also reject a running workspace even if a compose override changed its mount.
service_running=$(docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
[ -z "$service_running" ] || { echo "refusing SQLite backup: stop $project/$service first" >&2; exit 3; }
parent=$(dirname "$archive")
mkdir -p "$parent"
tmp=$(mktemp "$parent/.ygl-sqlite-backup.XXXXXX")
sumtmp=$(mktemp "$parent/.ygl-sqlite-checksum.XXXXXX")
trap 'rm -f -- "$tmp" "$sumtmp"' EXIT HUP INT TERM
echo "Creating offline snapshot from stopped volume $volume." >&2
# The candidate entrypoint holds a shared flock for each live workspace command.
# This single helper holds the matching exclusive lock across checkpoint AND tar,
# closing the check-then-use gap for all cooperating candidate writers.
image=${YGL_IMAGE:-local/ygl-trees:0.119.0}
docker run --rm --network none --mount "type=volume,src=$volume,dst=/data" --entrypoint /bin/sh "$image" -ec 'flock --exclusive --nonblock /data/.sqlite-backup.lock /bin/sh -ec "node /usr/local/bin/ygl-checkpoint-sqlite.mjs /data && tar -C /data --exclude=./.sqlite-backup.lock -czf - ."' > "$tmp"
test -s "$tmp"
gzip -t "$tmp"
sha256sum "$tmp" | awk -v name="$(basename "$archive")" '{print $1 "  " name}' > "$sumtmp"
chmod 0600 "$tmp" "$sumtmp"
ln "$tmp" "$archive"
if ! ln "$sumtmp" "$archive.sha256"; then rm -f -- "$archive"; exit 1; fi
printf 'backup=%s\nsha256=' "$archive"
sha256sum "$archive" | cut -d ' ' -f1
