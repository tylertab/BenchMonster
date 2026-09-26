"""Execute a run over every (model, input) pair.

Modes:
- realtime: one streaming request per input (measures per-input latency/TTFT).
- batch: batched prompting. batch_size inputs are packed into one request
  whose answer must be a JSON array (one element per input); elements are
  split out and scored individually. Tokens and cost are shared equally across
  the batch, and latency is amortized per item.

Requests run concurrently, capped per model, with retries on 429/5xx/network
errors. Each result row is written as soon as it finishes, so the UI can poll
progress and the SQL console sees partial results.
"""

import asyncio
import json
import logging
import random
from decimal import Decimal

from . import db, exports, providers, scoring

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
               tokens_per_sec, cost_usd, error, attempts, processed_output)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)""",
        run_id, inp["id"], model["id"], r.output, r.reasoning or None, s.score, s.passed,
        s.rationale, r.latency_ms, r.ttft_ms, r.tokens_in, r.tokens_out, r.reasoning_tokens,
        r.tokens_per_sec, r.cost_usd, error, attempts, s.processed,
    )


BATCH_INSTRUCTIONS = """You will receive {n} separate inputs, each under a "### Input k" heading. Handle each one independently, exactly as its own instructions say, as if it were the only input.

Return ONLY a JSON array with exactly {n} elements, in input order: element k is your complete answer to Input k. If an input asks for a JSON object, that element is the object itself; otherwise it is a string. No prose outside the array."""


def build_batch_messages(run, prompts: list[str]) -> list[dict]:
    body = BATCH_INSTRUCTIONS.format(n=len(prompts)) + "\n\n" + "\n\n".join(
        f"### Input {k}\n{p}" for k, p in enumerate(prompts, 1)
    )
    return build_messages(run, body)


def split_batch(output: str, n: int) -> list[str] | None:
    """The batch answer as n per-input outputs, or None if it isn't a JSON array of n."""
    try:
        data = scoring._parse_json(output)
    except (json.JSONDecodeError, ValueError):
        return None
    if isinstance(data, dict):  # tolerate {"answers": [...]}
        lists = [v for v in data.values() if isinstance(v, list)]
        data = lists[0] if len(lists) == 1 else None
    if not isinstance(data, list) or len(data) != n:
        return None
    return [x if isinstance(x, str) else json.dumps(x) for x in data]


def _shares(total: int | None, n: int) -> list[int | None]:
    if total is None:
        return [None] * n
    base, extra = divmod(total, n)
    return [base + (1 if k < extra else 0) for k in range(n)]


async def _run_batch(run_id: int, run, model, batch_no: int, chunk, params, sem: asyncio.Semaphore) -> None:
    ep = providers.ModelEndpoint.from_row(model)
    n = len(chunk)
    # One request answers n inputs, so give it room for n answers.
    batch_params = {**params, "max_tokens": min(32768, params["max_tokens"] * n)}
    async with sem:
        try:
            r, attempts = await _call_with_retries(ep, build_batch_messages(run, [i["prompt"] for i in chunk]), batch_params)
        except providers.ProviderError as e:
            await db.pool().executemany(
                """insert into results (run_id, input_id, model_id, score, passed, error, attempts, batch_no)
                   values ($1, $2, $3, 0, false, $4, $5, $6)""",
                [(run_id, i["id"], model["id"], str(e)[:1000], getattr(e, "attempts", 1), batch_no) for i in chunk],
            )
            return

    parts = split_batch(r.output, n)
    if parts is None:
        batch_error = (
            f"hit max_tokens before finishing the batch ({r.tokens_out} tokens)" if r.finish_reason == "length"
            else f"batch answer was not a JSON array of {n} elements"
        )
    tok_in, tok_out, tok_reason = _shares(r.tokens_in, n), _shares(r.tokens_out, n), _shares(r.reasoning_tokens, n)
    cost = (r.cost_usd / n) if r.cost_usd is not None else Decimal(0)
    rows = []
    for k, inp in enumerate(chunk):
        if parts is None:
            out, s, error = (r.output if k == 0 else None), scoring.Score(0.0, False, None), batch_error
        else:
            out, error = parts[k].strip(), None
            try:
                s = await scoring.score(run["scoring_method"], run["scoring_config"], inp["prompt"], inp["expected"], out)
            except Exception as e:
                s = scoring.Score(0.0, False, f"scoring failed: {e}")
        rows.append((
            run_id, inp["id"], model["id"], out, (r.reasoning or None) if k == 0 else None, s.score, s.passed,
            s.rationale, r.latency_ms / n, None, tok_in[k], tok_out[k], tok_reason[k], r.tokens_per_sec,
            cost, error, attempts, batch_no, s.processed,
        ))
    await db.pool().executemany(
        """insert into results (run_id, input_id, model_id, output, reasoning, score, passed,
               judge_rationale, latency_ms, ttft_ms, tokens_in, tokens_out, reasoning_tokens,
               tokens_per_sec, cost_usd, error, attempts, batch_no, processed_output)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)""",
        rows,
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
        params = {"max_tokens": 4096, "temperature": 0.0, "concurrency": 8, "mode": "realtime", "batch_size": 10,
                  **run["params"]}
        await pool.execute("update runs set status = 'running', started_at = coalesce(started_at, now()) where id = $1", run_id)

        if run["stream_state"] is not None:
            from . import streaming  # streamed from a connection's table, chunk by chunk

            await streaming.execute(run, models, params)
            await pool.execute("update runs set status = 'completed', finished_at = now() where id = $1", run_id)
            await exports.auto_export(run_id)
            return

        jobs = []
        size = params["batch_size"]
        chunks = [inputs[k:k + size] for k in range(0, len(inputs), size)]
        for model in models:
            sem = asyncio.Semaphore(params["concurrency"])  # per-model cap
            if params["mode"] == "batch":
                jobs += [_run_batch(run_id, run, model, b, c, params, sem) for b, c in enumerate(chunks)]
            else:
                jobs += [_run_input(run_id, run, model, i, params, sem) for i in inputs]
        await asyncio.gather(*jobs)

        await pool.execute("update runs set status = 'completed', finished_at = now() where id = $1", run_id)
        await exports.auto_export(run_id)
    except Exception as e:
        log.exception("run %s failed", run_id)
        await pool.execute(
            "update runs set status = 'failed', error = $2, finished_at = now() where id = $1", run_id, str(e)
        )


async def fail_orphaned_runs() -> None:
    """Runs execute in-process; any left 'running' after a restart are dead, except streamed
    runs, which saved their position after every chunk and pick up from there."""
    await db.pool().execute(
        """update runs set status = 'failed', error = 'server restarted mid-run', finished_at = now()
           where status in ('queued', 'running') and stream_state is null"""
    )
    for r in await db.pool().fetch("select id from runs where status in ('queued', 'running') and stream_state is not null"):
        log.info("resuming streamed run %s", r["id"])
        start(r["id"])
