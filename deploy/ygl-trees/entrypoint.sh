#!/bin/sh
set -eu
if [ -n "${YGL_PG_PASSWORD_FILE:-}" ]; then
  if [ ! -r "${YGL_PG_PASSWORD_FILE}" ]; then
    echo "ygl sync: PG password file is not readable" >&2
    exit 78
  fi
  password=$(cat "${YGL_PG_PASSWORD_FILE}")
  encoded=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$password")
  export YGL_PG_URL="postgres://${YGL_PG_USER:-ygl}:${encoded}@${YGL_PG_HOST:-ygl-pg}:${YGL_PG_PORT:-5432}/${YGL_PG_DATABASE:-ygl}"
fi
if [ ! -s "${YGL_HOME}/ygl-trees.db" ]; then
  echo "ygl sync: SQLite workspace is missing; initialize it with the MCP workspace service first" >&2
  exit 78
fi
if [ "$(id -u)" = 0 ]; then
  exec su -p -s /bin/sh node -c 'exec /opt/ygl/node_modules/.bin/ygl-trees db sync pg --json'
fi
exec /opt/ygl/node_modules/.bin/ygl-trees db sync pg --json
