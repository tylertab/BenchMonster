"""The review analyst: an LLM (on Vultr) with SQL and memory tools, scoped to a run.

Each turn: recall related findings from Backboard, give the model the analytics
schema + this run's summary, then loop on tool calls (run_sql, save_finding)
until it answers. The final reply and the tool calls are stored per run.
"""

import json
from decimal import Decimal

from . import db, memory, providers, sqlconsole
from .config import settings

MAX_TOOL_ROUNDS = 6
HISTORY_TURNS = 12
ROWS_FOR_MODEL = 50

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_sql",
            "description": (
                "Run one read-only PostgreSQL SELECT against the results views. "
                "Always filter by the current run_id unless comparing runs. Returns up to 50 rows."
            ),
            "parameters": {
                "type": "object",
                "properties": {"sql": {"type": "string", "description": "A single SELECT statement"}},
                "required": ["sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_finding",
            "description": (
                "Save a durable, specific insight about this run to long-term memory so it can be "
                "recalled in future sessions (e.g. 'On run 4, GLM 5.3 failed all JSON cases by "
                "wrapping output in prose'). Only save concrete conclusions, not questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {"finding": {"type": "string"}},
                "required": ["finding"],
            },
        },
    },
]

SYSTEM = """You are BenchMonster's benchmark analyst. You help the user understand results of an LLM benchmark run by querying the data with SQL.

## Current run
run_id = {run_id}; benchmark "{benchmark}" (scoring: {scoring_method}); status {status}; {total_cases} cases per model.

Per-model summary (from model_summary):
{summary}

## Schema (PostgreSQL views; they are on the search_path, so don't schema-qualify them)
{schema}

Notes: score is 0..1, passed is boolean; latency/ttft in ms; cost_usd in USD; tokens_per_sec is end-to-end throughput.

## Things you remember from earlier sessions
{memories}

## How to work
- Use run_sql to get facts; never invent numbers. Keep queries small and filtered by run_id = {run_id}.
- If a query errors, read the error and fix the query.
- Answer concisely in plain language with the key numbers. You may be read aloud, so avoid big tables unless asked.
- When you reach a notable, durable conclusion, call save_finding.
"""


def _fmt(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, float):
        return round(v, 4)
    return v if isinstance(v, (int, str, bool)) or v is None else str(v)


def _summary_text(rows) -> str:
    if not rows:
        return "(no results yet)"
    keys = ["model", "cases", "errors", "accuracy", "pass_rate", "p50_latency_ms", "avg_ttft_ms",
            "avg_tokens_per_sec", "total_cost_usd", "reasoning_tokens"]
    return "\n".join(json.dumps({k: _fmt(r[k]) for k in keys}) for r in rows)


async def _system_prompt(org_id: int, run_id: int, user_message: str) -> str:
    pool = db.pool()
    run = await pool.fetchrow(
        """select r.id, r.status, r.total_cases, b.name, b.scoring_method
           from runs r join benchmarks b on b.id = r.benchmark_id where r.id = $1""",
        run_id,
    )
    if not run:
        raise LookupError("run not found")
    summary = await pool.fetch("select * from analytics.model_summary where run_id = $1", run_id)
    memories = await memory.search(org_id, f"run {run_id} {run['name']}: {user_message}")
    return SYSTEM.format(
        run_id=run_id,
        benchmark=run["name"],
        scoring_method=run["scoring_method"],
        status=run["status"],
        total_cases=run["total_cases"],
        summary=_summary_text(summary),
        schema=sqlconsole.schema_as_text(await sqlconsole.schema(org_id)),
        memories="\n".join(f"- {m}" for m in memories) or "(nothing yet)",
    )


async def _run_tool(org_id: int, run_id: int, name: str, args: dict) -> tuple[str, dict]:
    """Returns (text for the model, record for the UI)."""
    if name == "run_sql":
        sql = args.get("sql", "")
        try:
            res = await sqlconsole.run(org_id, sql, max_rows=ROWS_FOR_MODEL)
        except sqlconsole.QueryError as e:
            return f"ERROR: {e}", {"tool": name, "sql": sql, "error": str(e)}
        cols = [c["name"] for c in res["columns"]]
        rows = [[_fmt(v) for v in r] for r in res["rows"]]
        text = json.dumps({"columns": cols, "rows": rows, "truncated": res["truncated"]})
        return text, {"tool": name, "sql": sql, "columns": cols, "rows": rows, "truncated": res["truncated"]}
    if name == "save_finding":
        finding = args.get("finding", "").strip()
        ok = await memory.add(org_id, f"[run {run_id}] {finding}", {"run_id": run_id}) if finding else False
        return ("saved" if ok else "memory unavailable"), {"tool": name, "finding": finding, "saved": ok}
    return f"ERROR: unknown tool {name}", {"tool": name, "error": "unknown tool"}


async def history(run_id: int) -> list[dict]:
    rows = await db.pool().fetch(
        "select id, role, content, tool_calls, created_at from assistant_messages where run_id = $1 order by id",
        run_id,
    )
    return [dict(r) for r in rows]


async def chat(org_id: int, run_id: int, user_message: str) -> dict:
    """One analyst turn. Caller must have checked that run_id belongs to org_id."""
    system = await _system_prompt(org_id, run_id, user_message)
    past = await db.pool().fetch(
        """select role, content from (
               select id, role, content from assistant_messages
               where run_id = $1 and role in ('user', 'assistant') order by id desc limit $2
           ) t order by id""",
        run_id, HISTORY_TURNS * 2,
    )
    messages = [{"role": "system", "content": system}]
    messages += [{"role": r["role"], "content": r["content"] or ""} for r in past]
    messages.append({"role": "user", "content": user_message})

    ep = providers.vultr_endpoint(settings.assistant_model)
    tool_records: list[dict] = []
    reply = None
    for _ in range(MAX_TOOL_ROUNDS):
        resp = await providers.complete(ep, messages, tools=TOOLS, max_tokens=4096, temperature=0.2)
        msg = resp["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        if not calls:
            reply = (msg.get("content") or "").strip()
            break
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for call in calls:
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            text, record = await _run_tool(org_id, run_id, call["function"]["name"], args)
            tool_records.append(record)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
    if not reply:
        reply = "I couldn't reach an answer within my tool-call budget. Try a narrower question."

    async with db.pool().acquire() as conn, conn.transaction():
        await conn.execute(
            "insert into assistant_messages (run_id, role, content) values ($1, 'user', $2)", run_id, user_message
        )
        msg_id = await conn.fetchval(
            """insert into assistant_messages (run_id, role, content, tool_calls)
               values ($1, 'assistant', $2, $3) returning id""",
            run_id, reply, tool_records or None,
        )
    return {"id": msg_id, "reply": reply, "tool_calls": tool_records}
