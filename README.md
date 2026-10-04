# BenchMonster

Benchmark LLMs — hosted or your own — on your data. Upload a dataset, describe the expected outputs, pick models, and compare performance, accuracy, and cost. Then dig into the results with SQL or by talking to an AI analyst.

**Live:** [benchmonster.tech](https://benchmonster.tech) · **Devpost:** [MonsterBench](https://devpost.com/software/monsterbench) · Built at **HackGT 2026**

## Highlights

- Runs versioned benchmark profiles across **15 open-weight models** on Vultr Serverless Inference, scoring each answer with one of seven methods (including regex extraction and LLM-as-judge) and reporting accuracy, p50/p95 latency, and cost per correct answer.
- A production run scored **30,000 predictions** (7,500 records across 4 models) for about **$10**. The streaming runner pages through Postgres in keyset order and checkpoints after every chunk, so a run resumes after a restart.
- On a 43,744-row personality survey, the results surfaced a reversed scale in the data. Iterating prompts through immutable, versioned profiles raised exact-type accuracy from **7% to 75%**.

## How it works

1. **Prompts**: reusable templates with `{{variable}}` placeholders (plus an optional system prompt).
2. **Datasets**: upload CSV / JSONL / JSON input files; each row becomes one input.
3. **Runs**: pick a prompt and one or more input files, map each template variable to a column
   (and optionally an expected-output column), choose scoring (exact, contains, regex, numeric,
   JSON schema, JSON fields, LLM judge) and models, and name the output predictions file. Every (model, input)
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

## Security

BenchMonster runs SQL that users and an LLM write, against data that can belong to several organizations, so isolation is enforced by the database rather than by trusting the query:

- **Per-organization schemas and roles.** Each org gets an `org_<id>` schema of views filtered to its own rows and an `org_<id>_reader` login role that can read only that schema, with `default_transaction_read_only` on and a 5 second statement timeout (`backend/app/orgs.py`).
- **One source per query.** Before the AI analyst's SQL runs, a server-side check rejects any query that references tables from two separate databases (`backend/app/assistant.py`).
- **Encrypted credentials.** Saved connection secrets are encrypted at rest with Fernet and never returned to the browser (`backend/app/connections.py`).
- **No internal hosts.** User-supplied connection hosts that resolve to private, loopback, link-local, or reserved addresses are refused, and plain `http` is blocked outside development.

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
