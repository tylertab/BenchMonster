# Backend

FastAPI service: prompts, datasets, the run executor, SQL console, AI analyst, voice.

## Local development (separate dev database)

`.env` holds **production** values (it's what `deploy/deploy.sh` ships). For local work,
run a TimescaleDB container and override the database in a gitignored `.env.local`:

```bash
docker compose -f deploy/docker-compose.dev.yml up -d      # localhost:5433

cat > .env.local <<'X'
DATABASE_URL=postgres://tsdbadmin:devpassword@localhost:5433/tsdb?sslmode=disable
PUBLIC_URL=http://localhost:3000
X

cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python scripts/migrate.py        # schema, views, per-org reader roles
.venv/bin/uvicorn app.main:app --reload     # http://localhost:8000/docs
.venv/bin/python -m pytest                  # unit tests
```

Why not a second database on the Tiger service: Postgres roles are cluster-wide, and each
org's SQL console role is named `org_<id>_reader`, so a dev database in the same service would
overwrite production's reader passwords.
