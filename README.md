# BenchMonster

Benchmark LLMs — hosted or your own — on your data. Upload a dataset, describe the expected outputs, pick models, and compare performance, accuracy, and cost. Then dig into the results with SQL or by talking to an AI analyst.

## How it works

1. **Prompts**: reusable templates with `{{variable}}` placeholders (plus an optional system prompt).
2. **Datasets**: upload CSV / JSONL / JSON input files; each row becomes one input.
3. **Runs**: pick a prompt and one or more input files, map each template variable to a column
   (and optionally an expected-output column), choose scoring (exact, contains, regex, numeric,
   JSON schema, LLM judge) and models, and name the output predictions file. Every (model, input)
   pair is a real-time streaming call, run concurrently with retries; each result records latency,
   time to first token, throughput, tokens (incl. reasoning), and cost.
4. **Runs list**: the home dashboard shows every run with its prompt template, input files, output
   file, models, and headline metrics, newest first, with search and filters.
5. **Run page**: charts, per-input results, predictions CSV download, and clone & edit.
6. **Review**: a read-only SQL console (per-org views, saved queries) plus an AI analyst (text or
   voice) that writes its own SQL and remembers findings per organization.

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
