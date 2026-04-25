#!/usr/bin/env bash
set -euo pipefail

# Если /config пуст (свежий том) — копируем дефолты
if [ ! -f /config/users.json ] && [ -f /config.default/users.json ]; then
  cp /config.default/users.json /config/users.json
fi
if [ ! -f /config/extensions.json ] && [ -f /config.default/extensions.json ]; then
  cp /config.default/extensions.json /config/extensions.json
fi
if [ ! -f /config/shared-machine-settings.json ] && [ -f /config.default/shared-machine-settings.json ]; then
  cp /config.default/shared-machine-settings.json /config/shared-machine-settings.json
fi
if [ ! -f /config/claude-settings.json ] && [ -f /config.default/claude-settings.json ]; then
  cp /config.default/claude-settings.json /config/claude-settings.json
fi
if [ ! -f /config/qwen-settings.json ] && [ -f /config.default/qwen-settings.json ]; then
  cp /config.default/qwen-settings.json /config/qwen-settings.json
fi

mkdir -p /config/sessions /opt/shared-extensions /opt/shared-machine-settings \
         /opt/shared-claude-settings /opt/shared-qwen-settings /users
# Prevent users from listing each other's home directories.
# Individual home dirs get chmod 700 when they are created or first accessed.
chmod 711 /users
chmod 755 /opt/shared-extensions
chmod 755 /opt/shared-machine-settings
chmod 755 /opt/shared-claude-settings
chmod 755 /opt/shared-qwen-settings

# Синхронизируем машинные настройки VS Code из /config в /opt/shared-machine-settings/.
# Файл /opt/shared-machine-settings/settings.json — общий для всех пользователей;
# каждый пользовательский {dataDir}/Machine/settings.json — симлинк на него.
# Перезаписываем при каждом запуске, чтобы изменения в /config сразу вступали в силу.
if [ -f /config/shared-machine-settings.json ]; then
  # Убираем служебный ключ _comment перед записью, чтобы VS Code не ругался
  node -e "
const src = JSON.parse(require('fs').readFileSync('/config/shared-machine-settings.json', 'utf8'));
delete src['_comment'];
require('fs').writeFileSync('/opt/shared-machine-settings/settings.json', JSON.stringify(src, null, 2));
"
  echo "[entrypoint] shared machine settings deployed to /opt/shared-machine-settings/settings.json"
fi

# Разворачиваем настройки Claude Code CLI (~/.claude/settings.json).
# Убираем _comment, чтобы Claude Code не ругался.
if [ -f /config/claude-settings.json ]; then
  node -e "
const src = JSON.parse(require('fs').readFileSync('/config/claude-settings.json', 'utf8'));
delete src['_comment'];
require('fs').writeFileSync('/opt/shared-claude-settings/settings.json', JSON.stringify(src, null, 2));
"
  echo "[entrypoint] shared Claude Code settings deployed to /opt/shared-claude-settings/settings.json"
fi

# Разворачиваем настройки Qwen Code CLI (~/.qwen/settings.json).
if [ -f /config/qwen-settings.json ]; then
  node -e "
const src = JSON.parse(require('fs').readFileSync('/config/qwen-settings.json', 'utf8'));
delete src['_comment'];
require('fs').writeFileSync('/opt/shared-qwen-settings/settings.json', JSON.stringify(src, null, 2));
"
  echo "[entrypoint] shared Qwen Code settings deployed to /opt/shared-qwen-settings/settings.json"
fi

# Если в /config/extensions.json есть список и общий каталог расширений ещё пуст —
# установим их (удобно для первичного bootstrap).
if [ -z "$(ls -A /opt/shared-extensions 2>/dev/null || true)" ] && [ -f /config/extensions.json ]; then
  echo "[entrypoint] bootstrapping shared extensions…"
  /scripts/install-extensions.sh /config/extensions.json || echo "[entrypoint] extension bootstrap had errors (non-fatal)"
fi

exec node /app/server.js
