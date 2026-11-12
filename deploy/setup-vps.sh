#!/usr/bin/env bash
# Instalação única do APPET na VPS (Ubuntu/Debian), como root:
#   curl -fsSL https://raw.githubusercontent.com/LACibermedicina/appet/main/deploy/setup-vps.sh | sudo bash
# Variáveis opcionais: APPET_DOMAIN, APPET_PORT, CERTBOT_EMAIL, APPET_REPO, APPET_DIR
set -euo pipefail

DOMAIN="${APPET_DOMAIN:-appet.m3d.pro}"
REPO="${APPET_REPO:-https://github.com/LACibermedicina/appet.git}"
DIR="${APPET_DIR:-/opt/appet}"
APP_USER="appet"
EMAIL="${CERTBOT_EMAIL:-}"

log(){ printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Rode como root (sudo)."; exit 1; }

log "Pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git nginx curl ca-certificates iproute2 certbot python3-certbot-nginx

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

log "Código em $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
chown -R "$APP_USER:$APP_USER" "$DIR"

ENV_FILE="$DIR/server/.env"
NEW_ENV=0
[ -f "$ENV_FILE" ] || { cp "$DIR/server/.env.example" "$ENV_FILE"; NEW_ENV=1; }

# Porta: a do .env (se já houver), a de APPET_PORT, ou a primeira livre a partir de 3100 (sempre > 1000)
if [ -n "${APPET_PORT:-}" ]; then PORT="$APPET_PORT"; elif [ "$NEW_ENV" = 1 ]; then PORT=""; else PORT="$(grep -E '^PORT=[0-9]+' "$ENV_FILE" | cut -d= -f2 || true)"; fi
port_free(){ ! ss -ltnH "( sport = :$1 )" | grep -q .; }
if [ -z "$PORT" ] || [ "$PORT" -le 1000 ] || { ! port_free "$PORT" && ! systemctl is-active --quiet appet; }; then
  PORT=""
  for p in $(seq 3100 3999); do if port_free "$p"; then PORT="$p"; break; fi; done
  [ -n "$PORT" ] || { echo "Nenhuma porta livre entre 3100 e 3999."; exit 1; }
fi
sed -i "s#^PORT=.*#PORT=$PORT#; s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$ENV_FILE"
grep -q '^PORT=' "$ENV_FILE" || echo "PORT=$PORT" >> "$ENV_FILE"
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
log "Porta interna escolhida: $PORT"

log "Dependências"
sudo -u "$APP_USER" bash -c "cd '$DIR/server' && npm install --omit=dev --no-audit --no-fund"

log "Serviço systemd"
sed -e "s#__DIR__#$DIR#g" -e "s#__USER__#$APP_USER#g" "$DIR/deploy/appet.service" > /etc/systemd/system/appet.service
systemctl daemon-reload
systemctl enable --now appet
systemctl restart appet

log "Nginx ($DOMAIN → 127.0.0.1:$PORT)"
sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__PORT__#$PORT#g" "$DIR/deploy/nginx-appet.conf" > "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t && systemctl reload nginx

# sudo sem senha só para reiniciar o serviço (usado pelo deploy automático)
echo "$APP_USER ALL=(root) NOPASSWD: /bin/systemctl restart appet, /usr/bin/systemctl restart appet" > /etc/sudoers.d/appet
chmod 440 /etc/sudoers.d/appet

log "HTTPS (Let's Encrypt)"
if getent hosts "$DOMAIN" >/dev/null; then
  if [ -n "$EMAIL" ]; then certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || echo "⚠️ certbot falhou; rode de novo depois que o DNS propagar."
  else certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || echo "⚠️ certbot falhou; rode de novo depois que o DNS propagar."; fi
else
  echo "⚠️ $DOMAIN ainda não resolve. Crie o registro DNS A → IP desta VPS e rode: certbot --nginx -d $DOMAIN"
fi

sleep 2
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo
log "Pronto: https://$DOMAIN  (porta interna $PORT)"
echo "Edite as chaves em $ENV_FILE e rode: systemctl restart appet"
