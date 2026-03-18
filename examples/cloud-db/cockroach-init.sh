#!/bin/sh
set -e

CERTS_DIR=/data/certs
DATA_DIR=/data/cockroach
CRDB=/cockroach/cockroach

# Generate certs on first boot
if [ ! -f "$CERTS_DIR/ca.crt" ]; then
  echo "[init] Generating certificates..."
  mkdir -p "$CERTS_DIR"
  $CRDB cert create-ca --certs-dir="$CERTS_DIR" --ca-key="$CERTS_DIR/ca.key"
  $CRDB cert create-node localhost 0.0.0.0 cockroachdb.railway.internal --certs-dir="$CERTS_DIR" --ca-key="$CERTS_DIR/ca.key"
  $CRDB cert create-client root --certs-dir="$CERTS_DIR" --ca-key="$CERTS_DIR/ca.key"
  echo "[init] Certificates generated."
fi

# Start cockroach in background
echo "[init] Starting CockroachDB..."
$CRDB start-single-node \
  --certs-dir="$CERTS_DIR" \
  --accept-sql-without-tls \
  --store="$DATA_DIR" \
  --listen-addr=0.0.0.0:26257 \
  --http-addr=0.0.0.0:8080 &
CRPID=$!

# Wait for ready
echo "[init] Waiting for CockroachDB to be ready..."
for i in $(seq 1 30); do
  if $CRDB sql --certs-dir="$CERTS_DIR" -e "SELECT 1" > /dev/null 2>&1; then
    echo "[init] CockroachDB is ready."
    break
  fi
  sleep 1
done

# Create app user with password (idempotent)
if [ -n "$COCKROACH_PASSWORD" ]; then
  echo "[init] Creating app user..."
  $CRDB sql --certs-dir="$CERTS_DIR" -e "
    CREATE USER IF NOT EXISTS app WITH PASSWORD '$COCKROACH_PASSWORD';
    GRANT admin TO app;
  "
  echo "[init] App user ready."
fi

# Foreground
wait $CRPID
