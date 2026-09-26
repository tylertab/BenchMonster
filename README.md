# BenchMonster

Benchmark LLMs — hosted or your own — on your data. Upload a dataset, describe the expected outputs, pick models, and compare performance, accuracy, and cost. Then dig into the results with SQL or by talking to an AI analyst.

## Stack

| Piece | Tech |
|---|---|
| Frontend | Next.js (App Router, TypeScript, Tailwind) |
| Backend | FastAPI (Python, asyncio) |
| Database | Tiger Data (managed Postgres / TimescaleDB) |
| Models | Vultr Serverless Inference + any OpenAI-compatible endpoint |
| Assistant memory | Backboard.io memory API |
| Voice | ElevenLabs Conversational AI |
| Hosting | Vultr VM, Docker Compose, Caddy (benchmonster.tech) |

## Layout

```
backend/    FastAPI app, benchmark runner, SQL console, assistant
frontend/   Next.js app
deploy/     Docker Compose + Caddy config
```

## Setup

```bash
cp .env.example .env   # fill in keys
```

See `backend/README.md` and `frontend/README.md` for running each piece.
