#!/usr/bin/env bash
# Configuração completa em UM comando, rodado no SEU computador (macOS, Linux ou WSL/Git Bash):
#
#   bash deploy/bootstrap.sh root@159.223.22.82
#
# Requisitos locais: ssh, scp, ssh-keygen e GitHub CLI logado (gh auth login).
# Faz tudo:
#   1. cria uma chave SSH só para publicação e instala na VPS (pede a senha da VPS uma vez)
#   2. instala o app na VPS (setup-vps.sh): Node, nginx, porta livre > 1000, HTTPS
#   3. envia suas chaves (server/.env) para a VPS e reinicia o app
#   4. cadastra no GitHub: secrets VPS_HOST, VPS_USER, VPS_SSH_KEY, APPET_ENV e a variável VPS_DEPLOY_ENABLED=true
#   5. dispara a primeira publicação automática
set -euo pipefail

TARGET="${1:-root@159.223.22.82}"
VPS_USER="${TARGET%@*}"; VPS_HOST="${TARGET#*@}"
if [ "$VPS_USER" = "$TARGET" ]; then VPS_USER="root"; fi
REPO="${APPET_GH_REPO:-LACibermedicina/appet}"
ENV_LOCAL="${ENV_FILE:-server/.env}"
KEY="${APPET_DEPLOY_KEY:-$HOME/.ssh/appet_deploy}"
SSH_PORT="${VPS_SSH_PORT:-22}"
SSH=(ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new)
SCP=(scp -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new)

say(){ printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
cd "$(dirname "$0")/.."

for c in ssh scp ssh-keygen gh; do command -v "$c" >/dev/null || { echo "Falta o comando: $c"; exit 1; }; done
gh auth status >/dev/null 2>&1 || { echo "Faça login no GitHub CLI: gh auth login"; exit 1; }

if [ ! -f "$ENV_LOCAL" ]; then
  cp server/.env.example "$ENV_LOCAL"
  echo "Criei $ENV_LOCAL a partir do modelo. Preencha suas chaves NOVAS e rode este comando de novo."
  exit 1
fi
grep -qE '^(ANTHROPIC_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY)=.+' "$ENV_LOCAL" || echo "⚠️  Nenhuma chave de IA preenchida em $ENV_LOCAL: o app vai usar o modo local."

say "1/5 Chave SSH de publicação"
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N "" -C "appet-deploy" -f "$KEY" >/dev/null
PUB="$(cat "$KEY.pub")"
"${SSH[@]}" "$TARGET" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys)"
SSHK=("${SSH[@]}" -i "$KEY"); SCPK=("${SCP[@]}" -i "$KEY")
"${SSHK[@]}" "$TARGET" true && echo "✓ Acesso por chave funcionando"

SUDO=""; [ "$VPS_USER" != "root" ] && SUDO="sudo"

say "2/5 Instalação na VPS"
"${SSHK[@]}" "$TARGET" "curl -fsSL https://raw.githubusercontent.com/$REPO/main/deploy/setup-vps.sh -o /tmp/setup-vps.sh && $SUDO env CERTBOT_EMAIL='${CERTBOT_EMAIL:-}' APPET_PORT='${APPET_PORT:-}' bash /tmp/setup-vps.sh"

say "3/5 Chaves do app"
"${SCPK[@]}" "$ENV_LOCAL" "$TARGET:/tmp/appet.env"
"${SSHK[@]}" "$TARGET" "$SUDO bash /opt/appet/deploy/apply-env.sh /tmp/appet.env; rm -f /tmp/appet.env"

say "4/5 Secrets e variável no GitHub ($REPO)"
gh secret set VPS_HOST    -R "$REPO" --body "$VPS_HOST"
gh secret set VPS_USER    -R "$REPO" --body "$VPS_USER"
gh secret set VPS_SSH_KEY -R "$REPO" < "$KEY"
if [ "$SSH_PORT" != "22" ]; then gh secret set VPS_SSH_PORT -R "$REPO" --body "$SSH_PORT"; fi
gh secret set APPET_ENV   -R "$REPO" < "$ENV_LOCAL"
gh variable set VPS_DEPLOY_ENABLED -R "$REPO" --body "true"

say "5/5 Primeira publicação automática"
gh workflow run deploy.yml -R "$REPO" --ref main && echo "Acompanhe em: gh run watch -R $REPO"

say "Pronto! https://${APPET_DOMAIN:-appet.m3d.pro}"
echo "Para trocar chaves depois: edite $ENV_LOCAL e rode  bash deploy/set-keys.sh"
