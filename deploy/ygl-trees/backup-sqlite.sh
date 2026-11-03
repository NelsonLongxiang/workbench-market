#!/bin/sh
set -eu
: "${1:?usage: backup-sqlite.sh DESTINATION.tar.gz}"
archive=$1
project=${COMPOSE_PROJECT_NAME:-ygl-trees-candidate}
volume=${YGL_HOME_VOLUME:-${project}_home}
service=${YGL_WORKSPACE_SERVICE:-ygl-workspace}
expected_volume=${YGL_HOME_VOLUME:-${project}_home}
[ "$volume" = "$expected_volume" ] || { echo "refusing unexpected volume $volume (expected $expected_volume)" >&2; exit 2; }
case "$archive" in /*) ;; *) archive="$(pwd)/$archive" ;; esac
[ ! -e "$archive" ] && [ ! -L "$archive" ] && [ ! -e "$archive.sha256" ] && [ ! -L "$archive.sha256" ] || { echo "refusing to overwrite archive or checksum" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }
# Fail closed if any container still uses this volume.
# Caller must stop the candidate workspace and any other volume users.
running=$(docker ps --filter "volume=$volume" --format '{{.ID}}')
[ -z "$running" ] || { echo "refusing SQLite backup: running container still mounts volume $volume" >&2; exit 3; }
# Also reject a running workspace even if a compose override changed its mount.
service_running=$(docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
[ -z "$service_running" ] || { echo "refusing SQLite backup: stop $project/$service first" >&2; exit 3; }
parent=$(dirname "$archive")
mkdir -p "$parent"
tmp=$(mktemp "$parent/.ygl-sqlite-backup.XXXXXX")
sumtmp=$(mktemp "$parent/.ygl-sqlite-checksum.XXXXXX")
trap 'rm -f -- "$tmp" "$sumtmp"' EXIT HUP INT TERM
echo "Creating offline snapshot from stopped volume $volume." >&2
# With the writer container stopped and volume mounted read/write, checkpoint and
# integrity-check every SQLite database before producing the read-only archive.
image=${YGL_IMAGE:-local/ygl-trees:0.119.0}
docker run --rm --network none --mount "type=volume,src=$volume,dst=/data" --entrypoint node "$image" /usr/local/bin/ygl-checkpoint-sqlite.mjs /data
docker run --rm --network none --mount "type=volume,src=$volume,dst=/data,readonly" alpine:3.20 tar -C /data -czf - . > "$tmp"
test -s "$tmp"
gzip -t "$tmp"
sha256sum "$tmp" | awk -v name="$(basename "$archive")" '{print $1 "  " name}' > "$sumtmp"
chmod 0600 "$tmp" "$sumtmp"
ln "$tmp" "$archive"
if ! ln "$sumtmp" "$archive.sha256"; then rm -f -- "$archive"; exit 1; fi
printf 'backup=%s\nsha256=' "$archive"
sha256sum "$archive" | cut -d ' ' -f1
