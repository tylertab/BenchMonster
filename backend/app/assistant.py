"""BMQuery's AI analyst: an LLM (on Vultr) with SQL and memory tools.

A conversation is scoped to the whole org, one benchmark profile, or one run.
Each turn: recall related findings from Backboard, give the model the schema
plus context for the scope, then loop on tool calls (run_sql, save_finding)
until it answers. Messages are stored per scope.
"""

import json
from dataclasses import dataclass
from decimal import Decimal

from fastapi import HTTPException

from . import db, memory, providers, sqlconsole
from .config import settings

MAX_TOOL_ROUNDS = 6
HISTORY_TURNS = 12
ROWS_FOR_MODEL = 50


@dataclass(frozen=True)
class Scope:
    org_id: int
    profile_id: int | None = None
    run_id: int | None = None

    @property
    def kind(self) -> str:
        return "run" if self.run_id else "profile" if self.profile_id else "org"

    def where(self, first_param: int = 1) -> tuple[str, list]:
        """SQL condition selecting this scope's assistant_messages (and only it)."""
        p = first_param
        return (
            f"org_id = ${p} and run_id is not distinct from ${p + 1} and profile_id is not distinct from ${p + 2}",
            [self.org_id, self.run_id, self.profile_id if not self.run_id else None],
        )


async def resolve_scope(org_id: int, profile_id: int | None, run_id: int | None) -> Scope:
    """Validate that the profile/run belongs to the org (404 otherwise)."""
    if run_id:
        if not await db.pool().fetchval("select 1 from runs where id = $1 and org_id = $2", run_id, org_id):
            raise HTTPException(404, "run not found")
        return Scope(org_id, run_id=run_id)
    if profile_id:
        if not await db.pool().fetchval(
            "select 1 from benchmark_profiles where id = $1 and org_id = $2", profile_id, org_id
        ):
            raise HTTPException(404, "benchmark profile not found")
        return Scope(org_id, profile_id=profile_id)
    return Scope(org_id)


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_sql",
            "description": (
                "Run one read-only PostgreSQL SELECT against the results views. "
                "Filter to the current scope (run_id / profile_id) unless asked to compare more broadly. "
                "Returns up to 50 rows."
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
                "Save a durable, specific insight to the organization's long-term memory so it can be "
                "recalled in future sessions (e.g. 'Triage v2's concise prompt cost 24% less but lost "
                "9 points of all-fields accuracy, mostly on sentiment'). Only save concrete conclusions."
            ),
            "parameters": {
                "type": "object",
                "properties": {"finding": {"type": "string"}},
                "required": ["finding"],
            },
        },
    },
]

SYSTEM = """You are BMQuery, BenchMonster's benchmark analyst. You help the user understand LLM benchmark results by querying the data with SQL.

Concepts: a benchmark profile is a versioned configuration (prompt + input sets + scoring + models). Each run executes one profile version (profile_id, profile_version) over every input with every model; results has one row per (run, input, model).

## Scope
{scope}

## Schema (PostgreSQL views; they are on the search_path, so don't schema-qualify them)
{schema}

Notes: score is 0..1, passed is boolean; latency/ttft in ms; cost_usd in USD; tokens_per_sec is end-to-end throughput. Postgres can't use output aliases inside ORDER BY expressions; repeat the expression instead.

## Things you remember from earlier sessions
{memories}

## How to work
- Use run_sql to get facts; never invent numbers. Keep queries small and filtered to the scope.
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


async def _run_context(run_id: int) -> tuple[str, str]:
    pool = db.pool()
    run = await pool.fetchrow(
        """select r.id, r.name, r.status, r.total_inputs, r.prompt_name, r.template, r.scoring_method,
                  r.profile_id, r.profile_version, p.name as profile,
                  (select string_agg(filename, ', ' order by position) from run_datasets where run_id = r.id) as input_files
           from runs r left join benchmark_profiles p on p.id = r.profile_id where r.id = $1""",
        run_id,
    )
    summary = await pool.fetch("select * from analytics.model_summary where run_id = $1", run_id)
    profile = f" of profile \"{run['profile']}\" (profile_id = {run['profile_id']}) v{run['profile_version']}" if run["profile"] else ""
    text = f"""One run: run_id = {run_id}{f' ("{run["name"]}")' if run["name"] else ''}{profile}.
Prompt "{run['prompt_name']}" (scoring: {run['scoring_method']}); status {run['status']}; {run['total_inputs']} inputs per model from {run['input_files']}.
Prompt template:
{run['template'][:1500]}

Per-model summary (from model_summary):
{_summary_text(summary)}

Filter queries with run_id = {run_id}."""
    return text, f"run {run_id} {run['prompt_name']}"


async def _profile_context(profile_id: int) -> tuple[str, str]:
    pool = db.pool()
    p = await pool.fetchrow("select name, description, current_version from benchmark_profiles where id = $1", profile_id)
    versions = await pool.fetch(
        """select v.version, v.prompt_name, v.note, cardinality(v.model_ids) as models,
                  (select string_agg(d.filename, ', ' order by d.position) from profile_version_datasets d where d.version_id = v.id) as inputs
           from profile_versions v where v.profile_id = $1 order by v.version""",
        profile_id,
    )
    runs = await pool.fetch(
        """select r.id, r.name, r.profile_version, r.status, r.created_at,
                  (select round(max(accuracy)::numeric, 3) from analytics.model_summary s where s.run_id = r.id) as best_acc,
                  (select round(sum(cost_usd)::numeric, 4) from results x where x.run_id = r.id) as cost
           from runs r where r.profile_id = $1 order by r.id""",
        profile_id,
    )
    vtext = "\n".join(
        f"- v{v['version']}: prompt \"{v['prompt_name']}\", inputs {v['inputs']}, {v['models']} models"
        + (f" (note: {v['note']})" if v["note"] else "")
        for v in versions
    )
    rtext = "\n".join(
        f"- run_id {r['id']} (v{r['profile_version']}{', ' + repr(r['name']) if r['name'] else ''}): {r['status']}, "
        f"best accuracy {r['best_acc']}, cost ${r['cost']}"
        for r in runs
    ) or "(no runs yet)"
    text = f"""One benchmark profile: "{p['name']}" (profile_id = {profile_id}), current version v{p['current_version']}.
{p['description'] or ''}
Versions:
{vtext}
Runs:
{rtext}

Filter queries with profile_id = {profile_id}; compare versions with profile_version / prompt_name."""
    return text, f"profile {p['name']}"


async def _org_context(org_id: int) -> tuple[str, str]:
    rows = await db.pool().fetch(
        """select p.id, p.name, p.current_version,
                  (select count(*) from runs r where r.profile_id = p.id) as runs
           from benchmark_profiles p where p.org_id = $1 order by p.updated_at desc limit 30""",
        org_id,
    )
    total_runs = await db.pool().fetchval("select count(*) from runs where org_id = $1", org_id)
    ptext = "\n".join(f"- profile_id {r['id']}: \"{r['name']}\" (v{r['current_version']}, {r['runs']} runs)" for r in rows)
    text = f"""All of the organization's benchmarks ({total_runs} runs).
Benchmark profiles:
{ptext or '(none yet)'}

Compare across profiles, versions, and models as the user asks."""
    return text, "all benchmarks"


async def _system_prompt(scope: Scope, user_message: str) -> tuple[str, str]:
    if scope.kind == "run":
        context, label = await _run_context(scope.run_id)
    elif scope.kind == "profile":
        context, label = await _profile_context(scope.profile_id)
    else:
        context, label = await _org_context(scope.org_id)
    memories = await memory.search(scope.org_id, f"{label}: {user_message}")
    system = SYSTEM.format(
        scope=context,
        schema=sqlconsole.schema_as_text(await sqlconsole.schema(scope.org_id)),
        memories="\n".join(f"- {m}" for m in memories) or "(nothing yet)",
    )
    return system, label


async def _run_tool(scope: Scope, label: str, name: str, args: dict) -> tuple[str, dict]:
    """Returns (text for the model, record for the UI)."""
    if name == "run_sql":
        sql = args.get("sql", "")
        try:
            res = await sqlconsole.run(scope.org_id, sql, max_rows=ROWS_FOR_MODEL)
        except sqlconsole.QueryError as e:
            return f"ERROR: {e}", {"tool": name, "sql": sql, "error": str(e)}
        cols = [c["name"] for c in res["columns"]]
        rows = [[_fmt(v) for v in r] for r in res["rows"]]
        text = json.dumps({"columns": cols, "rows": rows, "truncated": res["truncated"]})
        return text, {"tool": name, "sql": sql, "columns": cols, "rows": rows, "truncated": res["truncated"]}
    if name == "save_finding":
        finding = args.get("finding", "").strip()
        meta = {k: v for k, v in (("run_id", scope.run_id), ("profile_id", scope.profile_id)) if v}
        ok = await memory.add(scope.org_id, f"[{label}] {finding}", meta) if finding else False
        return ("saved" if ok else "memory unavailable"), {"tool": name, "finding": finding, "saved": ok}
    return f"ERROR: unknown tool {name}", {"tool": name, "error": "unknown tool"}


async def history(scope: Scope) -> list[dict]:
    cond, args = scope.where()
    rows = await db.pool().fetch(
        f"select id, role, content, tool_calls, created_at from assistant_messages where {cond} order by id", *args
    )
    return [dict(r) for r in rows]


async def chat(scope: Scope, user_message: str) -> dict:
    """One analyst turn. The scope must come from resolve_scope (org ownership checked)."""
    system, label = await _system_prompt(scope, user_message)
    cond, args = scope.where()
    past = await db.pool().fetch(
        f"""select role, content from (
               select id, role, content from assistant_messages
               where {cond} and role in ('user', 'assistant') order by id desc limit ${len(args) + 1}
           ) t order by id""",
        *args, HISTORY_TURNS * 2,
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
                call_args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                call_args = {}
            text, record = await _run_tool(scope, label, call["function"]["name"], call_args)
            tool_records.append(record)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
    if not reply:
        reply = "I couldn't reach an answer within my tool-call budget. Try a narrower question."

    profile_id = scope.profile_id if not scope.run_id else None
    async with db.pool().acquire() as conn, conn.transaction():
        await conn.execute(
            "insert into assistant_messages (org_id, profile_id, run_id, role, content) values ($1, $2, $3, 'user', $4)",
            scope.org_id, profile_id, scope.run_id, user_message,
        )
        msg_id = await conn.fetchval(
            """insert into assistant_messages (org_id, profile_id, run_id, role, content, tool_calls)
               values ($1, $2, $3, 'assistant', $4, $5) returning id""",
            scope.org_id, profile_id, scope.run_id, reply, tool_records or None,
        )
    return {"id": msg_id, "reply": reply, "tool_calls": tool_records}
