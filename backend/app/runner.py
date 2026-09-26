"""Execute a run: every (model, input) pair as a real-time streaming call.

Requests run concurrently, capped per model, with retries on 429/5xx/network
errors. Each result row is written as soon as it finishes, so the UI can poll
progress and the SQL console sees partial results.
"""

import asyncio
import logging
import random

from . import db, providers, scoring

log = logging.getLogger("uvicorn.error")

MAX_ATTEMPTS = 3
_tasks: set[asyncio.Task] = set()


def start(run_id: int) -> None:
    task = asyncio.create_task(execute(run_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def build_messages(run, prompt: str) -> list[dict]:
    """Inputs were rendered from the template when the run was created."""
    msgs = []
    if run["system_prompt"]:
        msgs.append({"role": "system", "content": run["system_prompt"]})
    msgs.append({"role": "user", "content": prompt})
    return msgs


async def _call_with_retries(ep, messages, params) -> tuple[providers.ChatResult, int]:
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            result = await providers.stream_chat(
                ep, messages, max_tokens=params["max_tokens"], temperature=params["temperature"]
            )
            return result, attempt
        except providers.ProviderError as e:
            if not e.retryable or attempt == MAX_ATTEMPTS:
                e.attempts = attempt
                raise
            await asyncio.sleep(2 ** (attempt - 1) + random.random())
    raise AssertionError("unreachable")


async def _run_input(run_id: int, run, model, inp, params, sem: asyncio.Semaphore) -> None:
    ep = providers.ModelEndpoint.from_row(model)
    async with sem:
        try:
            r, attempts = await _call_with_retries(ep, build_messages(run, inp["prompt"]), params)
        except providers.ProviderError as e:
            await db.pool().execute(
                """insert into results (run_id, input_id, model_id, score, passed, error, attempts)
                   values ($1, $2, $3, 0, false, $4, $5)""",
                run_id, inp["id"], model["id"], str(e)[:1000], getattr(e, "attempts", 1),
            )
            return

    error = None
    if not r.output and r.finish_reason == "length":
        error = f"hit max_tokens before answering ({r.reasoning_tokens} reasoning tokens)"
    try:
        s = await scoring.score(
            run["scoring_method"], run["scoring_config"], inp["prompt"], inp["expected"], r.output
        )
    except Exception as e:  # a judge failure shouldn't lose the model's output
        s = scoring.Score(0.0, False, f"scoring failed: {e}")

    await db.pool().execute(
        """insert into results (run_id, input_id, model_id, output, reasoning, score, passed,
               judge_rationale, latency_ms, ttft_ms, tokens_in, tokens_out, reasoning_tokens,
               tokens_per_sec, cost_usd, error, attempts)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)""",
        run_id, inp["id"], model["id"], r.output, r.reasoning or None, s.score, s.passed,
        s.rationale, r.latency_ms, r.ttft_ms, r.tokens_in, r.tokens_out, r.reasoning_tokens,
        r.tokens_per_sec, r.cost_usd, error, attempts,
    )


async def execute(run_id: int) -> None:
    pool = db.pool()
    try:
        run = await pool.fetchrow("select * from runs where id = $1", run_id)
        inputs = await pool.fetch(
            "select id, prompt, expected from run_inputs where run_id = $1 order by dataset_position, row_idx",
            run_id,
        )
        models = await pool.fetch(
            "select m.* from models m join run_models rm on rm.model_id = m.id where rm.run_id = $1", run_id
        )
        params = {"max_tokens": 4096, "temperature": 0.0, "concurrency": 8, **run["params"]}
        await pool.execute("update runs set status = 'running', started_at = now() where id = $1", run_id)

        jobs = []
        for model in models:
            sem = asyncio.Semaphore(params["concurrency"])  # per-model cap
            jobs += [_run_input(run_id, run, model, i, params, sem) for i in inputs]
        await asyncio.gather(*jobs)

        await pool.execute("update runs set status = 'completed', finished_at = now() where id = $1", run_id)
    except Exception as e:
        log.exception("run %s failed", run_id)
        await pool.execute(
            "update runs set status = 'failed', error = $2, finished_at = now() where id = $1", run_id, str(e)
        )


async def fail_orphaned_runs() -> None:
    """Runs execute in-process; any left 'running' after a restart are dead."""
    await db.pool().execute(
        """update runs set status = 'failed', error = 'server restarted mid-run', finished_at = now()
           where status in ('queued', 'running')"""
    )
