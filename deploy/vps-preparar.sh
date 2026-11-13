#!/usr/bin/env bash
# Instala ou atualiza o APPET numa VPS Linux (Ubuntu/Debian), atrás de proxy reverso com HTTPS.
# Uso (root ou sudo), na pasta do app (/opt/appet):
#   bash deploy/vps-preparar.sh --dominio appet.m3d.pro [--email voce@exemplo.com] [--porta 3100] [--env /tmp/appet.env]
# É o que o GitHub Actions roda a cada push na main. Pode rodar quantas vezes quiser:
#   1. instala Node.js 20 se faltar;
#   2. escolhe uma porta livre acima de 1000 (só na 1ª vez; fica gravada em server/.env) e prende o app em 127.0.0.1;
#   3. aplica as chaves (--env), instala dependências e (re)inicia o serviço systemd "appet";
#   4. configura o proxy reverso do domínio (nginx existente, Caddy existente ou instala nginx) e o HTTPS;
#   5. confere se o app responde pela porta local e pelo domínio.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exec sudo -E bash "$0" "$@"; fi
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
APP_USER="appet"

DOMINIO=""; EMAIL=""; PORTA_PEDIDA=""; ENV_NOVO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dominio) DOMINIO="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --porta) PORTA_PEDIDA="${2:-}"; shift 2 ;;
    --env) ENV_NOVO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMINIO" ] || { echo "Informe --dominio (ex.: --dominio appet.m3d.pro)" >&2; exit 2; }
URL="https://$DOMINIO"

ok()  { printf '\033[32m✔\033[0m %s\n' "$*"; }
av()  { printf '\033[33m!\033[0m %s\n' "$*"; }
erro(){ printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
titulo(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive
apt_instalar(){ command -v apt-get >/dev/null 2>&1 || { erro "Sem apt-get: instale manualmente: $*"; return 1; }; apt-get update -qq >/dev/null; apt-get install -y -qq "$@" >/dev/null; }

# ---------- 0) DNS ----------
titulo "DNS de $DOMINIO"
IP_VPS="$(curl -fsS4 --max-time 6 https://api.ipify.org 2>/dev/null || { hostname -I 2>/dev/null || true; } | awk '{print $1}')"
IP_DNS="$( { getent ahostsv4 "$DOMINIO" 2>/dev/null || true; } | awk 'NR==1{print $1}')"
DNS_OK=0
if [ -z "$IP_DNS" ]; then av "$DOMINIO ainda não resolve. Crie um registro A: $DOMINIO -> $IP_VPS (o HTTPS fica para a próxima execução)."
elif [ "$IP_DNS" != "$IP_VPS" ]; then av "$DOMINIO aponta para $IP_DNS, mas esta VPS é $IP_VPS (Cloudflare com proxy laranja também causa isso)."
else DNS_OK=1; ok "$DOMINIO -> $IP_VPS"; fi

# ---------- 1) Node.js ----------
titulo "Node.js"
command -v ss >/dev/null 2>&1 || apt_instalar iproute2
command -v curl >/dev/null 2>&1 || apt_instalar curl ca-certificates
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  av "Instalando Node.js 20…"; curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null; apt_instalar nodejs
fi
ok "Node $(node -v) · npm $(npm -v)"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

# ---------- 2) porta (só escolhe na primeira vez) e chaves ----------
titulo "Porta e chaves"
ENVC="$APP_DIR/server/.env"
[ -f "$ENVC" ] || { cp "$APP_DIR/server/.env.example" "$ENVC"; sed -i '/^PORT=/d' "$ENVC"; }
lerenv(){ { grep -E "^$1=" "$ENVC" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }
gravar(){ if grep -qE "^$1=" "$ENVC"; then sed -i "s|^$1=.*|$1=$2|" "$ENVC"; else echo "$1=$2" >> "$ENVC"; fi; }
ocupada(){ ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
livre_a_partir(){ local p="$1"; while ocupada "$p"; do p=$((p+1)); done; echo "$p"; }

if [ -n "$ENV_NOVO" ] && [ -f "$ENV_NOVO" ]; then
  PORTA_ATUAL="$(lerenv PORT)"
  { grep -vE '^(PORT|PUBLIC_URL|HOST)=' "$ENV_NOVO" | tr -d '\r'; [ -n "$PORTA_ATUAL" ] && echo "PORT=$PORTA_ATUAL" || true; } > "$ENVC.novo"
  mv "$ENVC.novo" "$ENVC"; rm -f "$ENV_NOVO"; ok "Chaves atualizadas a partir do segredo APPET_ENV"
fi
if [ -z "$(lerenv PORT)" ]; then
  if [ -n "$PORTA_PEDIDA" ]; then
    [ "$PORTA_PEDIDA" -gt 1000 ] 2>/dev/null || { erro "--porta deve ser maior que 1000"; exit 2; }
    ocupada "$PORTA_PEDIDA" && { erro "A porta $PORTA_PEDIDA já está em uso."; exit 1; }
    gravar PORT "$PORTA_PEDIDA"
  else gravar PORT "$(livre_a_partir 3100)"; fi
fi
PORTA="$(lerenv PORT)"
gravar PUBLIC_URL "$URL"
gravar HOST "127.0.0.1"
chmod 600 "$ENVC"
ok "Porta interna: $PORTA (somente 127.0.0.1)"

# ---------- 3) dependências e serviço ----------
titulo "Serviço"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/server' && npm install --omit=dev --no-audit --no-fund --loglevel=error" >/dev/null
sed -e "s#__DIR__#$APP_DIR#g" -e "s#__USER__#$APP_USER#g" "$APP_DIR/deploy/appet.service" > /etc/systemd/system/appet.service
systemctl daemon-reload
systemctl enable appet >/dev/null 2>&1
systemctl restart appet
sleep 3
systemctl is-active --quiet appet && ok "Serviço appet ativo" || { erro "O serviço não subiu: journalctl -u appet -n 50"; journalctl -u appet -n 30 --no-pager || true; exit 1; }

# ---------- 4) proxy reverso + HTTPS ----------
titulo "Proxy reverso $DOMINIO -> 127.0.0.1:$PORTA"
ativo(){ systemctl is-active --quiet "$1" 2>/dev/null; }
dono_porta(){ ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2; }
MODO=""
if ativo nginx; then MODO=nginx
elif ativo caddy; then MODO=caddy
else
  D80="$(dono_porta 80)"; D443="$(dono_porta 443)"
  if [ -n "$D80$D443" ]; then
    erro "As portas 80/443 estão com outro programa (${D80:-?}/${D443:-?}), que não é nginx nem Caddy."
    echo "   Configure nele: $DOMINIO -> http://127.0.0.1:$PORTA"; exit 1
  fi
  av "Nenhum proxy encontrado: instalando o nginx…"; apt_instalar nginx; systemctl enable --now nginx >/dev/null 2>&1; MODO=nginx
fi
if [ "$MODO" = nginx ]; then
  if [ -d /etc/nginx/sites-available ]; then CONF="/etc/nginx/sites-available/$DOMINIO.conf"; LINK="/etc/nginx/sites-enabled/$DOMINIO.conf"
  else CONF="/etc/nginx/conf.d/$DOMINIO.conf"; LINK=""; fi
  CERT="/etc/letsencrypt/live/$DOMINIO"
  bloco_proxy="    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:$PORTA;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$appet_conexao;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }"
  escrever_conf(){
    {
      echo "# APPET — gerado por deploy/vps-preparar.sh (é regravado a cada atualização)"
      echo "map \$http_upgrade \$appet_conexao { default upgrade; '' close; }"
      if [ -f "$CERT/fullchain.pem" ]; then
        echo "server { listen 80; listen [::]:80; server_name $DOMINIO;"
        echo "    location /.well-known/acme-challenge/ { root /var/www/html; }"
        echo "    location / { return 301 https://\$host\$request_uri; } }"
        echo "server { listen 443 ssl; listen [::]:443 ssl; http2 on; server_name $DOMINIO;"
        echo "    ssl_certificate $CERT/fullchain.pem; ssl_certificate_key $CERT/privkey.pem;"
        [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && echo "    include /etc/letsencrypt/options-ssl-nginx.conf;"
        echo "$bloco_proxy"; echo "}"
      else
        echo "server { listen 80; listen [::]:80; server_name $DOMINIO;"
        echo "    location /.well-known/acme-challenge/ { root /var/www/html; }"
        echo "$bloco_proxy"; echo "}"
      fi
    } > "$CONF"
    [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
    rm -f "/etc/nginx/sites-enabled/$DOMINIO" 2>/dev/null || true   # versão antiga deste script
    if ! nginx -t >/dev/null 2>&1; then
      sed -i 's/listen 443 ssl; listen \[::\]:443 ssl; http2 on;/listen 443 ssl http2; listen [::]:443 ssl http2;/' "$CONF"
    fi
    nginx -t 2>&1 | tail -2; systemctl reload nginx
  }
  mkdir -p /var/www/html
  escrever_conf
  ok "nginx: $CONF"
  if [ ! -f "$CERT/fullchain.pem" ]; then
    if [ "$DNS_OK" -eq 1 ]; then
      command -v certbot >/dev/null 2>&1 || apt_instalar certbot
      if [ -n "$EMAIL" ]; then CB_MAIL=(-m "$EMAIL"); else CB_MAIL=(--register-unsafely-without-email); fi
      if certbot certonly --webroot -w /var/www/html -d "$DOMINIO" --non-interactive --agree-tos "${CB_MAIL[@]}" >/dev/null 2>&1; then
        escrever_conf; ok "HTTPS ativo (Let's Encrypt; renovação automática pelo certbot)"
      else av "Não consegui o certificado agora (o DNS propagou? a porta 80 está aberta?). Roda de novo no próximo push."; fi
    else av "Sem HTTPS por enquanto: o DNS de $DOMINIO ainda não aponta para esta VPS."; fi
  else ok "Certificado HTTPS já existente"; fi
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy 2>/dev/null && printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx.sh && chmod +x /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx.sh || true
else
  CF=/etc/caddy/Caddyfile; touch "$CF"
  sed -i '/# appet-inicio/,/# appet-fim/d' "$CF"
  printf '# appet-inicio (gerado por deploy/vps-preparar.sh)\n%s {\n    reverse_proxy 127.0.0.1:%s\n}\n# appet-fim\n' "$DOMINIO" "$PORTA" >> "$CF"
  caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy
  ok "Caddy: $DOMINIO -> 127.0.0.1:$PORTA (o Caddy cuida do HTTPS sozinho)"
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ok "Firewall (ufw): 80 e 443 liberadas"; fi

# ---------- 5) conferência ----------
titulo "Conferência"
falhou=0
curl -fsS --max-time 10 "http://127.0.0.1:$PORTA/" >/dev/null && ok "app responde em 127.0.0.1:$PORTA" || { erro "app não responde em 127.0.0.1:$PORTA"; falhou=1; }
curl -fsS --max-time 10 "http://127.0.0.1:$PORTA/api/health" && echo || { erro "API não responde (journalctl -u appet)"; falhou=1; }
if curl -fsS --max-time 15 "$URL/api/health" >/dev/null 2>&1; then ok "$URL no ar"
elif curl -fsS --max-time 15 -H "Host: $DOMINIO" "http://127.0.0.1/api/health" >/dev/null 2>&1; then av "O proxy funciona, mas $URL ainda não abre de fora (DNS/HTTPS)."
else av "$URL ainda não responde."; fi
[ "$falhou" -eq 0 ] || exit 1
ok "Pronto: $URL"
