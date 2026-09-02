#!/bin/sh
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"
PORT="${PORT:-8000}"

umask "$UMASK"

# Align the 'abc' user/group with the host ids Unraid (or compose) passes in.
if ! getent group "$PGID" >/dev/null 2>&1; then
  groupadd -o -g "$PGID" abcgrp 2>/dev/null || true
fi
usermod -o -u "$PUID" -g "$PGID" abc 2>/dev/null || true

mkdir -p "${CONFIG_DIR:-/config}" "${DOWNLOAD_DIR:-/downloads}"
chown "$PUID:$PGID" "${CONFIG_DIR:-/config}" 2>/dev/null || true
chown "$PUID:$PGID" "${DOWNLOAD_DIR:-/downloads}" 2>/dev/null || true

echo "Internet Archivaar"
echo "  user  : abc ($PUID:$PGID)"
echo "  config: ${CONFIG_DIR:-/config}"
echo "  output: ${DOWNLOAD_DIR:-/downloads}"
echo "  http  : 0.0.0.0:$PORT"

exec gosu abc python -m uvicorn app.main:app \
  --host 0.0.0.0 --port "$PORT" --proxy-headers --forwarded-allow-ips='*'
