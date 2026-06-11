#!/usr/bin/env bash
# Run this ONCE on the Hostinger VPS as root after SSH:
#   bash vps-first-time-setup.sh
#
# Before running: upload backend files to /var/www/autofollow-api/backend
# and create /var/www/autofollow-api/backend/.env with production values.

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing system packages..."
apt update
apt install -y curl git nginx certbot python3-certbot-nginx ufw

echo "==> Installing Node.js 20..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "==> Installing PM2..."
npm install -g pm2

echo "==> Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

APP_DIR="/var/www/autofollow-api/backend"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo ""
  echo "ERROR: Missing $APP_DIR/.env"
  echo "Upload your backend folder and create .env before continuing."
  exit 1
fi

echo "==> Installing npm dependencies..."
cd "$APP_DIR"
npm ci --omit=dev

echo "==> Starting API with PM2..."
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "==> Configuring Nginx..."
cat > /etc/nginx/sites-available/autofollow-api <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/autofollow-api /etc/nginx/sites-enabled/autofollow-api
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo ""
echo "==> Health check..."
sleep 2
curl -fsS http://127.0.0.1:5000/api/health
echo ""
curl -fsS http://127.0.0.1/api/health
echo ""
echo "Done. API should be reachable at http://187.124.52.234/api/health"
echo "Next: add VPS IP to Hostinger Remote MySQL, redeploy Vercel frontend, update Stripe/n8n webhooks."
echo "Optional SSL: certbot --nginx -d api.bestechvision.com  (after DNS A record points here)"
