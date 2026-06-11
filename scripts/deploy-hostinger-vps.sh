#!/usr/bin/env bash
# Deploy or update the AutoFollow API on a Hostinger VPS.
#
# First-time server setup (run once on the VPS as root or with sudo):
#   apt update && apt install -y curl git nginx certbot python3-certbot-nginx
#   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
#   apt install -y nodejs
#   npm install -g pm2
#   ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
#
# Usage on VPS:
#   export APP_DIR=/var/www/autofollow-api
#   export REPO_URL=https://github.com/YOUR_ORG/YOUR_REPO.git
#   ./scripts/deploy-hostinger-vps.sh
#
# Requires .env in $APP_DIR/backend/.env (never commit this file).

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/autofollow-api}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"

if [[ -z "$REPO_URL" ]]; then
  echo "Set REPO_URL to your git remote, e.g.:"
  echo "  export REPO_URL=https://github.com/you/autofollow.git"
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull origin "$BRANCH"

cd backend

if [[ ! -f .env ]]; then
  echo "Missing $APP_DIR/backend/.env"
  echo "Copy .env.example to .env and fill production values before deploying."
  exit 1
fi

npm ci --omit=dev
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "Deployed. Health check:"
curl -fsS "http://127.0.0.1:5000/api/health" || true
echo ""
echo "If nginx + SSL are configured, also test:"
echo "  curl -fsS https://api.bestechvision.com/api/health"
