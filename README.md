# BenchMonster

Benchmark LLMs — hosted or your own — on your data. Upload a dataset, describe the expected outputs, pick models, and compare performance, accuracy, and cost. Then dig into the results with SQL or by talking to an AI analyst.

## How it works

1. **Create a benchmark**: upload CSV/JSONL/JSON, map input + expected columns, pick a scoring method
   (exact, contains, regex, numeric, JSON schema, or LLM judge), and select models.
2. **Run**: every (model, case) pair is a real-time streaming call, run concurrently per model with
   retries. Each result records latency, time to first token, throughput, tokens (incl. reasoning), and cost.
3. **Dashboard**: leaderboard tiles, per-metric charts, accuracy-vs-cost, and a per-case explorer.
4. **Review**: a read-only SQL console over the results, plus an AI analyst (text or voice) that
   writes its own SQL and remembers findings across sessions.

## Stack

| Piece | Tech |
|---|---|
| Frontend | Next.js 16 (App Router, TypeScript, Tailwind) |
| Backend | FastAPI (Python, asyncio) |
| Database | Tiger Data (Postgres + TimescaleDB; `results` is a hypertable) |
| Models | Vultr Serverless Inference (catalog + live prices synced) and any OpenAI-compatible endpoint |
| Analyst | Vultr model with tool calling (`run_sql`, `save_finding`) |
| Memory | Backboard.io memory API |
| Voice | ElevenLabs Scribe (speech-to-text) + Flash v2.5 (text-to-speech) |
| Hosting | Vultr VM, Docker Compose, Caddy (benchmonster.tech) |

## Layout

```
backend/    FastAPI app: providers, runner, scoring, SQL console, analyst, voice
frontend/   Next.js app
deploy/     Dockerfiles live with each app; compose + Caddy + deploy script here
samples/    Demo datasets
```

## Local development

```bash
cp .env.example .env                      # fill in keys

cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python scripts/migrate.py       # schema, views, read-only role
.venv/bin/uvicorn app.main:app --reload   # :8000, docs at /docs

cd ../frontend
npm install && npm run dev                # :3000, proxies /api to :8000
```

Tests: `cd backend && .venv/bin/python -m pytest`.

## Deploy

See [deploy/README.md](deploy/README.md): `./deploy/deploy.sh root@<vm-ip>`.
