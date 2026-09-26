#!/usr/bin/env bash
# Deploy BenchMonster to a fresh Ubuntu VM: ./deploy/deploy.sh root@<vm-ip>
# Syncs the repo + .env, installs Docker if needed, and (re)starts the stack.
set -euo pipefail

HOST="${1:?usage: deploy/deploy.sh user@host}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/benchmonster

[ -f "$ROOT/.env" ] || { echo "missing $ROOT/.env"; exit 1; }

echo "==> syncing code to $HOST:$DEST"
ssh "$HOST" "mkdir -p $DEST"
rsync -az --delete \
  --exclude .git --exclude .env --exclude .env.local --exclude node_modules --exclude .next \
  --exclude .venv --exclude __pycache__ --exclude .DS_Store \
  "$ROOT/" "$HOST:$DEST/"

# The server never needs the Vultr account (root) key; only the inference key.
grep -v '^VULTR_API_KEY=' "$ROOT/.env" | ssh "$HOST" "umask 077 && cat > $DEST/.env"

echo "==> installing docker (if needed) and starting the stack"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
if command -v ufw >/dev/null; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi
cd $DEST/deploy
docker compose --env-file ../.env up -d --build
docker compose --env-file ../.env ps
REMOTE

DOMAIN=$(grep '^APP_DOMAIN=' "$ROOT/.env" | cut -d= -f2)
echo "==> done: https://$DOMAIN (Caddy fetches the TLS cert on first request once DNS points here)"
