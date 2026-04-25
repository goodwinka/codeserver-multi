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

# Если в /config/extensions.json есть список и общий каталог расширений ещё пуст —
# установим их (удобно для первичного bootstrap).
if [ -z "$(ls -A /opt/shared-extensions 2>/dev/null || true)" ] && [ -f /config/extensions.json ]; then
  echo "[entrypoint] bootstrapping shared extensions…"
  /scripts/install-extensions.sh /config/extensions.json || echo "[entrypoint] extension bootstrap had errors (non-fatal)"
fi

exec node /app/server.js
