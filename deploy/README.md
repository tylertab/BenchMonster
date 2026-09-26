# Deploying to Vultr

Stack: `backend` (FastAPI) + `frontend` (Next.js standalone) behind **Caddy**, which
routes `/api/*` to the backend, everything else to the frontend, and gets TLS
certificates for `APP_DOMAIN` automatically. The database is Tiger Data (managed),
so the VM holds no state except Caddy's certificates.

## 1. Create the VM

Vultr Console → Deploy → Cloud Compute, **Atlanta** region (the inference models
run in Atlanta, so latency numbers stay clean), Ubuntu 24.04, 2 vCPU / 4 GB is plenty.
Add your SSH key.

## 2. Point DNS at it

At your .tech registrar, add A records for `@` and `www` → the VM's IPv4.
Check with `dig +short benchmonster.tech`.

## 3. Deploy

```bash
./deploy/deploy.sh root@<vm-ip>
```

This rsyncs the repo, copies `.env` (without `VULTR_API_KEY`), installs Docker,
and runs `docker compose up -d --build`. Re-run it to ship changes.

## Useful commands (on the VM)

```bash
cd /opt/benchmonster/deploy
docker compose --env-file ../.env logs -f backend
docker compose --env-file ../.env restart backend
```

## Local test of the production stack

```bash
cd deploy
APP_DOMAIN=localhost docker compose --env-file ../.env up -d --build   # https://localhost
docker compose --env-file ../.env down
```

Note: the backend runs a single worker on purpose. Benchmark runs execute
in-process, and a restart marks in-flight runs as failed.
