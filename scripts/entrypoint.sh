#!/bin/sh
set -eu

# Ensure core utils are reachable even when PATH is minimal/empty in some runtimes.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

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
if [ ! -f /config/shared-user-settings.json ] && [ -f /config.default/shared-user-settings.json ]; then
  cp /config.default/shared-user-settings.json /config/shared-user-settings.json
fi
if [ ! -f /config/managed-mcp.json ] && [ -f /config.default/managed-mcp.json ]; then
  cp /config.default/managed-mcp.json /config/managed-mcp.json
fi

mkdir -p /config/sessions /opt/shared-extensions /opt/shared-machine-settings \
         /opt/shared-claude-settings /opt/shared-qwen-settings \
         /opt/shared-user-settings /users
# Allow users to list /users so the file browser can reach their home dir.
# Individual home dirs are protected by chmod 700 (only the owner can enter).
chmod 755 /users
chmod 755 /opt/shared-extensions
chmod 755 /opt/shared-machine-settings
chmod 755 /opt/shared-claude-settings
chmod 755 /opt/shared-qwen-settings
chmod 755 /opt/shared-user-settings

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


# Разворачиваем системный managed-mcp.json для общих MCP-серверов Claude Code.
# Linux path по документации Claude Code: /etc/claude-code/managed-mcp.json
if [ -f /config/managed-mcp.json ]; then
  mkdir -p /etc/claude-code
  node -e "
const src = JSON.parse(require('fs').readFileSync('/config/managed-mcp.json', 'utf8'));
delete src['_comment'];
require('fs').writeFileSync('/etc/claude-code/managed-mcp.json', JSON.stringify(src, null, 2));
"
  chmod 644 /etc/claude-code/managed-mcp.json
  echo "[entrypoint] managed MCP config deployed to /etc/claude-code/managed-mcp.json"
fi

# Разворачиваем дефолтные пользовательские настройки VS Code для новых пользователей.
# instances.js копирует этот файл в {userDataDir}/User/settings.json при первом старте.
# Перезаписываем при каждом запуске контейнера, чтобы изменения в /config вступали в силу.
if [ -f /config/shared-user-settings.json ]; then
  node -e "
const src = JSON.parse(require('fs').readFileSync('/config/shared-user-settings.json', 'utf8'));
delete src['_comment'];
require('fs').writeFileSync('/opt/shared-user-settings/settings.json', JSON.stringify(src, null, 2));
"
  echo "[entrypoint] shared user settings deployed to /opt/shared-user-settings/settings.json"
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

# ----- TLS: self-signed certificate -----
# crypto.subtle (WebCrypto) is only available in a "secure context" — HTTPS or localhost.
# Without HTTPS, VS Code webviews (including Claude Code) show a blank window when accessed
# from other machines on the LAN via HTTP.  We generate a self-signed cert once and store
# it in /config/ssl/ so it survives container restarts.
#
# To include your server's LAN IP in the certificate's SAN, set SSL_SAN_IP in docker-compose:
#   SSL_SAN_IP: "192.168.0.51"
# If not set, the script tries to detect the IP automatically.
# Users will see a browser warning about the self-signed cert on first visit — just click
# "Advanced → Accept" once per browser.
mkdir -p /config/ssl
if [ ! -f /config/ssl/cert.pem ] || [ ! -f /config/ssl/key.pem ]; then
  # Prefer explicit env var; fall back to auto-detection
  _san_ip="${SSL_SAN_IP:-}"
  if [ -z "$_san_ip" ]; then
    _san_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{print $NF; exit}' || true)"
    if [ -z "$_san_ip" ]; then
      _san_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
  fi

  _san="IP:127.0.0.1,DNS:localhost"
  _cn="codeserver-local"
  if [ -n "$_san_ip" ]; then
    _san="IP:${_san_ip},${_san}"
    _cn="${_san_ip}"
  fi

  if openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
      -keyout /config/ssl/key.pem \
      -out /config/ssl/cert.pem \
      -subj "/CN=${_cn}" \
      -addext "subjectAltName=${_san}" \
      2>/dev/null; then
    chmod 600 /config/ssl/key.pem
    echo "[entrypoint] SSL certificate generated (CN=${_cn}, SAN=${_san})"
    echo "[entrypoint] Access via: https://${_cn}:PORT  (accept the browser self-signed cert warning once)"
  else
    echo "[entrypoint] WARNING: SSL certificate generation failed — server will start in plain HTTP mode"
    rm -f /config/ssl/cert.pem /config/ssl/key.pem
  fi
fi

exec node /app/server.js
