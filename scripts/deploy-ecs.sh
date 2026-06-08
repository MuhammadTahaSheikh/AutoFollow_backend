#!/usr/bin/env bash
# One-time AWS setup + deploy script for AutoFollow API on ECS Fargate.
# Requires: aws cli, docker, jq
#
# Usage:
#   export AWS_REGION=eu-north-1
#   export AWS_ACCOUNT_ID=123456789012
#   ./scripts/deploy-ecs.sh
#
# Optional overrides:
#   ECS_CLUSTER=autofollow-cluster
#   ECS_SERVICE=autofollow-api
#   ECR_REPO=autofollow-backend

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_REGION="${AWS_REGION:?Set AWS_REGION}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
ECS_CLUSTER="${ECS_CLUSTER:-autofollow-cluster}"
ECS_SERVICE="${ECS_SERVICE:-autofollow-api}"
ECR_REPO="${ECR_REPO:-autofollow-backend}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

echo "==> Ensuring ECR repository exists"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION"

echo "==> Logging in to ECR"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "==> Building Docker image"
docker build -t "$ECR_REPO:$IMAGE_TAG" "$ROOT_DIR"
docker tag "$ECR_REPO:$IMAGE_TAG" "$IMAGE_URI"

echo "==> Pushing image to ECR"
docker push "$IMAGE_URI"

echo "==> Registering ECS task definition"
TASK_DEF_FILE="$ROOT_DIR/ecs/task-definition.json"
RENDERED_TASK_DEF="$(mktemp)"
sed \
  -e "s/YOUR_ACCOUNT_ID/${AWS_ACCOUNT_ID}/g" \
  -e "s/YOUR_AWS_REGION/${AWS_REGION}/g" \
  "$TASK_DEF_FILE" \
  | jq --arg image "$IMAGE_URI" '.containerDefinitions[0].image = $image' \
  > "$RENDERED_TASK_DEF"

TASK_ARN="$(aws ecs register-task-definition \
  --cli-input-json "file://${RENDERED_TASK_DEF}" \
  --region "$AWS_REGION" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"
rm -f "$RENDERED_TASK_DEF"

echo "Registered task definition: $TASK_ARN"

if aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region "$AWS_REGION" \
  --query 'services[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
  echo "==> Updating ECS service"
  aws ecs update-service \
    --cluster "$ECS_CLUSTER" \
    --service "$ECS_SERVICE" \
    --task-definition "$TASK_ARN" \
    --force-new-deployment \
    --region "$AWS_REGION" \
    >/dev/null
  echo "Service update started. Check ECS console for rollout status."
else
  echo ""
  echo "ECS service '$ECS_SERVICE' not found in cluster '$ECS_CLUSTER'."
  echo "Create it once in AWS Console (or CLI) with:"
  echo "  - Launch type: FARGATE"
  echo "  - Task definition: autofollow-api"
  echo "  - ALB target group -> container port 5000"
  echo "  - Public subnets + security group allowing ALB -> 5000"
  echo ""
  echo "After the service exists, re-run this script to deploy updates."
fi

echo "Done. Image: $IMAGE_URI"
