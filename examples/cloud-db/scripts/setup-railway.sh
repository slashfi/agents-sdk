#!/usr/bin/env bash
#
# Railway Infrastructure Setup for cloud-db example
#
# Prerequisites:
#   - Railway CLI installed (npm i -g @railway/cli)
#   - Railway API token set: export RAILWAY_TOKEN=...
#   - COCKROACH_PASSWORD env var set
#
# This script creates:
#   1. A Railway project with two services
#   2. CockroachDB single-node (secure mode, persistent volume, TCP proxy)
#   3. cloud-db app service (connected to GitHub repo)
#
# Usage: COCKROACH_PASSWORD=$(openssl rand -base64 32) ./scripts/setup-railway.sh

set -euo pipefail

API="https://backboard.railway.app/graphql/v2"

if [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "ERROR: RAILWAY_TOKEN is required"
  exit 1
fi

if [ -z "${COCKROACH_PASSWORD:-}" ]; then
  echo "ERROR: COCKROACH_PASSWORD is required"
  exit 1
fi

gql() {
  curl -s -X POST "$API" \
    -H "Authorization: Bearer $RAILWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1"
}

extract() {
  echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin)$2)"
}

echo "==> Creating project..."
RESULT=$(gql '{"query": "mutation { projectCreate(input: { name: \"agents-sdk-cloud-db\" }) { id } }"}')
PROJECT_ID=$(extract "$RESULT" "['data']['projectCreate']['id']")
echo "    Project: $PROJECT_ID"

# Get default environment
RESULT=$(gql "{\"query\": \"query { project(id: \\\"$PROJECT_ID\\\") { environments { edges { node { id name } } } } }\"}") 
ENV_ID=$(extract "$RESULT" "['data']['project']['environments']['edges'][0]['node']['id']")
echo "    Environment: $ENV_ID"

# --- CockroachDB Service ---
echo "==> Creating CockroachDB service..."
RESULT=$(gql "{\"query\": \"mutation { serviceCreate(input: { name: \\\"cockroachdb\\\", projectId: \\\"$PROJECT_ID\\\" }) { id } }\"}") 
CRDB_ID=$(extract "$RESULT" "['data']['serviceCreate']['id']")
echo "    Service: $CRDB_ID"

# Set image + start command (base64-encoded init script)
INIT_B64=$(cat << 'INITSCRIPT' | base64 -w0
#!/bin/sh
C=/cockroach/cockroach
D=/data/certs
mkdir -p $D /data/store
test -f $D/ca.crt || (
  $C cert create-ca --certs-dir=$D --ca-key=$D/ca.key
  $C cert create-node localhost 0.0.0.0 cockroachdb.railway.internal --certs-dir=$D --ca-key=$D/ca.key
  $C cert create-client root --certs-dir=$D --ca-key=$D/ca.key
)
$C start-single-node --certs-dir=$D --accept-sql-without-tls --store=/data/store --listen-addr=0.0.0.0:26257 --http-addr=0.0.0.0:8080 --background
sleep 5
$C sql --certs-dir=$D -e "CREATE USER IF NOT EXISTS app WITH PASSWORD '$COCKROACH_PASSWORD'; GRANT admin TO app;"
exec tail -f /data/store/logs/cockroach.log
INITSCRIPT
)

START_CMD="sh -c 'echo $INIT_B64 | base64 -d > /tmp/init.sh && sh /tmp/init.sh'"

gql "{\"query\": \"mutation { serviceInstanceUpdate(serviceId: \\\"$CRDB_ID\\\", environmentId: \\\"$ENV_ID\\\", input: { source: { image: \\\"cockroachdb/cockroach:latest\\\" }, startCommand: \\\"$START_CMD\\\" }) }\"}" > /dev/null

# Add persistent volume
echo "==> Adding volume..."
gql "{\"query\": \"mutation { volumeCreate(input: { projectId: \\\"$PROJECT_ID\\\", environmentId: \\\"$ENV_ID\\\", serviceId: \\\"$CRDB_ID\\\", mountPath: \\\"/data\\\" }) { id } }\"}" > /dev/null

# Set COCKROACH_PASSWORD env var
gql "{\"query\": \"mutation { variableUpsert(input: { projectId: \\\"$PROJECT_ID\\\", environmentId: \\\"$ENV_ID\\\", serviceId: \\\"$CRDB_ID\\\", name: \\\"COCKROACH_PASSWORD\\\", value: \\\"$COCKROACH_PASSWORD\\\" }) }\"}" > /dev/null

# TCP proxy for external access
echo "==> Creating TCP proxy..."
RESULT=$(gql "{\"query\": \"mutation { tcpProxyCreate(input: { serviceId: \\\"$CRDB_ID\\\", environmentId: \\\"$ENV_ID\\\", applicationPort: 26257 }) { domain proxyPort } }\"}") 
PROXY_DOMAIN=$(extract "$RESULT" "['data']['tcpProxyCreate']['domain']")
PROXY_PORT=$(extract "$RESULT" "['data']['tcpProxyCreate']['proxyPort']")
echo "    TCP Proxy: $PROXY_DOMAIN:$PROXY_PORT"

# Deploy cockroach
echo "==> Deploying CockroachDB..."
gql "{\"query\": \"mutation { serviceInstanceDeploy(serviceId: \\\"$CRDB_ID\\\", environmentId: \\\"$ENV_ID\\\") }\"}" > /dev/null

# --- Cloud DB App Service ---
echo "==> Creating cloud-db app service..."
RESULT=$(gql "{\"query\": \"mutation { serviceCreate(input: { name: \\\"cloud-db\\\", projectId: \\\"$PROJECT_ID\\\" }) { id } }\"}") 
APP_ID=$(extract "$RESULT" "['data']['serviceCreate']['id']")
echo "    Service: $APP_ID"

# Connect to GitHub repo
gql "{\"query\": \"mutation { serviceConnect(id: \\\"$APP_ID\\\", input: { repo: \\\"slashfi/agents-sdk\\\", branch: \\\"main\\\" }) { id } }\"}" > /dev/null
gql "{\"query\": \"mutation { serviceInstanceUpdate(serviceId: \\\"$APP_ID\\\", environmentId: \\\"$ENV_ID\\\", input: { rootDirectory: \\\"examples/cloud-db\\\" }) }\"}" > /dev/null

# Set env vars
gql "{\"query\": \"mutation { variableUpsert(input: { projectId: \\\"$PROJECT_ID\\\", environmentId: \\\"$ENV_ID\\\", serviceId: \\\"$APP_ID\\\", name: \\\"DATABASE_URL\\\", value: \\\"postgresql://app:$COCKROACH_PASSWORD@cockroachdb.railway.internal:26257/defaultdb?sslmode=disable\\\" }) }\"}" > /dev/null
gql "{\"query\": \"mutation { variableUpsert(input: { projectId: \\\"$PROJECT_ID\\\", environmentId: \\\"$ENV_ID\\\", serviceId: \\\"$APP_ID\\\", name: \\\"ROOT_KEY\\\", value: \\\"$(openssl rand -base64 32 | tr -d '=/+' | head -c 40)\\\" }) }\"}" > /dev/null
gql "{\"query\": \"mutation { variableUpsert(input: { projectId: \\\"$PROJECT_ID\\\", environmentId: \\\"$ENV_ID\\\", serviceId: \\\"$APP_ID\\\", name: \\\"PORT\\\", value: \\\"3000\\\" }) }\"}" > /dev/null

echo ""
echo "=== Setup Complete ==="
echo "Project:    https://railway.com/project/$PROJECT_ID"
echo "CockroachDB TCP: $PROXY_DOMAIN:$PROXY_PORT"
echo "Connection: postgresql://app:***@$PROXY_DOMAIN:$PROXY_PORT/defaultdb"
echo ""
echo "Wait for CockroachDB to be healthy, then deploy the app:"
echo "  railway service $APP_ID deploy"
