# Backend

FastAPI service: benchmark runner, SQL console, AI analyst.

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/migrate.py        # apply migrations to DATABASE_URL
.venv/bin/uvicorn app.main:app --reload     # http://localhost:8000/docs
```

Config is read from the repo-root `.env` (see `.env.example`).
