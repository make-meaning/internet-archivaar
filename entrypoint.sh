#!/bin/sh
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"
PORT="${PORT:-8000}"

umask "$UMASK"

# Align the 'abc' user/group with the host ids Unraid passes in.
if [ "$(id -u abc 2>/dev/null)" != "$PUID" ]; then
  usermod -o -u "$PUID" abc 2>/dev/null || true
fi
if [ "$(id -g abc 2>/dev/null)" != "$PGID" ]; then
  groupmod -o -g "$PGID" abc 2>/dev/null || true
fi

mkdir -p "${CONFIG_DIR:-/config}" "${DOWNLOAD_DIR:-/downloads}"
chown abc:abc "${CONFIG_DIR:-/config}" 2>/dev/null || true
chown abc:abc "${DOWNLOAD_DIR:-/downloads}" 2>/dev/null || true

echo "Internet Archive Video Downloader"
echo "  user  : abc ($PUID:$PGID)"
echo "  config: ${CONFIG_DIR:-/config}"
echo "  output: ${DOWNLOAD_DIR:-/downloads}"
echo "  http  : 0.0.0.0:$PORT"

exec gosu abc python -m uvicorn app.main:app \
  --host 0.0.0.0 --port "$PORT" --proxy-headers --forwarded-allow-ips='*'
