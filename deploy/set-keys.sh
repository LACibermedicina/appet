#!/usr/bin/env bash
# Atualiza as chaves do app: envia server/.env para o segredo APPET_ENV e republica (requer gh auth login).
#   bash deploy/set-keys.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${APPET_GH_REPO:-LACibermedicina/appet}"
ENV_LOCAL="${ENV_FILE:-server/.env}"
[ -f "$ENV_LOCAL" ] || { echo "Arquivo $ENV_LOCAL não encontrado."; exit 1; }
gh secret set APPET_ENV -R "$REPO" < "$ENV_LOCAL"
gh workflow run deploy.yml -R "$REPO" --ref main
echo "✓ Chaves enviadas. Publicação em andamento: gh run watch -R $REPO"
