#!/usr/bin/env bash
set -euo pipefail

# Если /config пуст (свежий том) — копируем дефолты
if [ ! -f /config/users.json ] && [ -f /config.default/users.json ]; then
  cp /config.default/users.json /config/users.json
fi
if [ ! -f /config/extensions.json ] && [ -f /config.default/extensions.json ]; then
  cp /config.default/extensions.json /config/extensions.json
fi

mkdir -p /config/sessions /opt/shared-extensions /users
# Prevent users from listing each other's home directories.
# Individual home dirs get chmod 700 when they are created or first accessed.
chmod 711 /users
chmod 755 /opt/shared-extensions

# Если в /config/extensions.json есть список и общий каталог расширений ещё пуст —
# установим их (удобно для первичного bootstrap).
if [ -z "$(ls -A /opt/shared-extensions 2>/dev/null || true)" ] && [ -f /config/extensions.json ]; then
  echo "[entrypoint] bootstrapping shared extensions…"
  /scripts/install-extensions.sh /config/extensions.json || echo "[entrypoint] extension bootstrap had errors (non-fatal)"
fi

exec node /app/server.js
