#!/bin/sh
set -eu
: "${YGL_SESSION:?set a per-agent YGL_SESSION value}"
: "${YGL_HOME_NAME:=${YGL_HOME_VOLUME:-ygl-trees-home-local}}"
exec docker run --rm -i \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=volume,src=${YGL_HOME_NAME},dst=/var/lib/ygl" \
  --user 1000:1000 \
  --env YGL_HOME=/var/lib/ygl \
  --env "YGL_SESSION=${YGL_SESSION}" \
  ${YGL_IMAGE:-local/ygl-trees:0.119.0} \
  mcp
