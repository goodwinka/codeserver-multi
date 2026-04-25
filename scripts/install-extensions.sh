#!/usr/bin/env bash
# Устанавливает список общих расширений code-server.
# Вход: JSON-файл вида {"extensions":["publisher.name", "publisher.name@1.2.3", ...]}
set -eu

FILE="${1:-/config/extensions.json}"
EXT_DIR="${SHARED_EXT_DIR:-/opt/shared-extensions}"

# Use VS Code Marketplace — both anthropic.claude-code and qwenlm.qwen-code-vscode-ide-companion
# are not published on Open VSX (code-server's default registry).
export EXTENSIONS_GALLERY='{"serviceUrl":"https://marketplace.visualstudio.com/_apis/public/gallery","cacheUrl":"https://vscode.blob.core.windows.net/gallery/index","itemUrl":"https://marketplace.visualstudio.com/items"}'

if [ ! -f "$FILE" ]; then
  echo "[install-extensions] no file $FILE, nothing to do"
  exit 0
fi

mkdir -p "$EXT_DIR"

# Извлекаем массив extensions через node (гарантированно в образе)
IDS="$(node -e "
const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
(d.extensions || []).forEach(x => { if (typeof x === 'string' && x.trim()) console.log(x.trim()); });
" "$FILE")"

if [ -z "$IDS" ]; then
  echo "[install-extensions] list is empty"
  exit 0
fi

rc=0
while IFS= read -r id; do
  [ -z "$id" ] && continue
  echo "[install-extensions] installing: $id"
  if ! code-server --install-extension "$id" --force --extensions-dir "$EXT_DIR"; then
    echo "[install-extensions] FAILED: $id" >&2
    rc=1
  fi
done <<EOF
$IDS
EOF

exit $rc
