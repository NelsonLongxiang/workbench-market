#!/bin/sh
set -eu
if [ ! -d "$YGL_HOME" ]; then
  echo "ygl MCP: YGL_HOME is missing" >&2
  exit 78
fi
# Every workspace process holds a shared advisory lock for its whole lifetime.
# The offline backup helper obtains the matching exclusive lock on this file.
exec flock --shared "$YGL_HOME/.sqlite-backup.lock" /bin/sh -ec '
  if [ ! -s "$YGL_HOME/ygl-trees.db" ]; then ygl-trees db init --json; fi
  if [ "${1:-}" = mcp ] || [ "${1:-}" = db ] || [ "${1:-}" = doctor ]; then
    exec /opt/ygl/node_modules/.bin/ygl-trees "$@"
  fi
  exec "$@"
' sh "$@"
