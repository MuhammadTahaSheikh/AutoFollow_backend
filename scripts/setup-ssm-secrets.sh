#!/usr/bin/env bash
# Store backend secrets in AWS SSM Parameter Store (SecureString).
# Run once before first ECS deploy.
#
# Usage:
#   export AWS_REGION=eu-north-1
#   cp .env .env.production   # fill production values
#   ./scripts/setup-ssm-secrets.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
AWS_REGION="${AWS_REGION:?Set AWS_REGION}"
PREFIX="/autofollow"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  echo "Copy .env.example to .env.production and fill in production values."
  exit 1
fi

put_param() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')"
  if [[ -z "$value" ]]; then
    echo "Skipping empty $key"
    return
  fi
  echo "Setting ${PREFIX}/${key}"
  aws ssm put-parameter \
    --name "${PREFIX}/${key}" \
    --type SecureString \
    --value "$value" \
    --overwrite \
    --region "$AWS_REGION" \
    >/dev/null
}

for key in DB_HOST DB_USER DB_PASSWORD DB_NAME JWT_SECRET GEMINI_API_KEY RESEND_API_KEY N8N_WEBHOOK_SECRET OPENAI_API_KEY; do
  put_param "$key"
done

echo "SSM parameters stored under ${PREFIX}/* in ${AWS_REGION}"
