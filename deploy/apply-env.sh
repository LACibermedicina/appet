#!/usr/bin/env bash
# Aplica um arquivo de chaves na VPS, preservando PORT e PUBLIC_URL definidos na instalação.
# Uso (root): bash /opt/appet/deploy/apply-env.sh /caminho/novo.env
set -euo pipefail
SRC="${1:?informe o arquivo .env}"
DIR="${APPET_DIR:-/opt/appet}"
DST="$DIR/server/.env"
[ -f "$SRC" ] || { echo "Arquivo $SRC não encontrado"; exit 1; }
PORT="$(grep -E '^PORT=' "$DST" 2>/dev/null | cut -d= -f2 || true)"
PUB="$(grep -E '^PUBLIC_URL=' "$DST" 2>/dev/null | cut -d= -f2- || true)"
umask 077
{ grep -vE '^(PORT|PUBLIC_URL)=' "$SRC" | tr -d '\r'
  if [ -n "$PORT" ]; then echo "PORT=$PORT"; fi
  if [ -n "$PUB" ]; then echo "PUBLIC_URL=$PUB"; fi
} > "$DST.new"
mv "$DST.new" "$DST"
chown appet:appet "$DST"; chmod 600 "$DST"
systemctl restart appet
echo "✓ Chaves aplicadas e serviço reiniciado (porta ${PORT:-?})"
