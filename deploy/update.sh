#!/usr/bin/env bash
# Atualiza o APPET na VPS (usado pelo GitHub Actions; também pode rodar à mão).
set -euo pipefail
DIR="${APPET_DIR:-/opt/appet}"
as_app(){ if [ "$(id -u)" -eq 0 ]; then sudo -u appet "$@"; else "$@"; fi; }
as_app git -C "$DIR" fetch --quiet origin main
as_app git -C "$DIR" reset --hard origin/main
as_app bash -c "cd '$DIR/server' && npm install --omit=dev --no-audit --no-fund"
if [ "$(id -u)" -eq 0 ]; then systemctl restart appet; else sudo /bin/systemctl restart appet; fi
sleep 2
PORT="$(grep -E '^PORT=' "$DIR/server/.env" | cut -d= -f2)"
curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo " ✓ APPET atualizado"
