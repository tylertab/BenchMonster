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

import asyncio

from . import connections as conns
from . import db, linked, memory, providers, sqlconsole
from .config import settings

MAX_TOOL_ROUNDS = 3  # write_query doesn't return data, so there's little to iterate on
HISTORY_TURNS = 12


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
            "name": "write_query",
            "description": (
                "Give the user a SQL query to run. It is NOT executed: it's shown to the user with buttons to "
                "open or run it in the SQL console, and you never see its results unless the user pastes them. "
                "Use one call per query; usually one query should answer the question."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "A few words saying what the query returns"},
                    "sql": {"type": "string", "description": "A single read-only PostgreSQL SELECT statement"},
                    "source": {
                        "type": "string",
                        "description": "'benchmonster' (default) or the exact name of a connected database listed in the system prompt",
                    },
                },
                "required": ["title", "sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_finding",
            "description": (
                "Save a durable, specific fact the user told you (or that they confirmed from query results) to the "
                "organization's long-term memory, e.g. 'In personality_survey, introversion_score is reversed'."
            ),
            "parameters": {
                "type": "object",
                "properties": {"finding": {"type": "string"}},
                "required": ["finding"],
            },
        },
    },
]

SYSTEM = """You are BMQuery, BenchMonster's benchmark analyst. You write SQL for the user to run against their LLM benchmark data. You do not run queries yourself: the only data you see is the Scope summary and the notes below. Never state results or numbers beyond those; write the query that answers the question and say what it will return.

Concepts: a benchmark profile is a versioned configuration (prompt + record source + scoring + models). Each run executes one profile version (profile_id, profile_version) over every input with every model; results has one row per (run, input, model).

## Scope
{scope}

## What the data looks like (looked up for you)
{notes}

## Schema (PostgreSQL views; they are on the search_path, so don't schema-qualify them)
{schema}

Column meanings in results:
- expected: the correct answer for the input (text). For classification tasks it's the class label, so GROUP BY expected gives per-class results.
- output: the model's raw reply. processed_output: the reply after the profile's output processing (e.g. the extracted label). Compare processed_output with expected.
- passed: whether it counted as correct (boolean). score: 0..1 (partial credit for some scoring methods; for exact match it equals passed).
- error: non-null when the call failed. latency_ms / ttft_ms in milliseconds; cost_usd in USD; tokens_per_sec is end-to-end throughput.
- variables: jsonb of the input's variable values; for runs that read a database table it holds only the row's key, e.g. {{"id": "1001"}}.
- row_idx: the input's position; run_id / profile_id / profile_version / model identify the run and model.
model_summary has one row per (run, model) with cases, errors, accuracy, pass_rate, latency percentiles and costs.

## Connected databases (source = the connection's name)
{connections}

## Query patterns
Accuracy per class, one row per run and model:
  select run_id, model, count(*) as cases, round(avg(passed::int)::numeric, 3) as accuracy,
         round(avg(passed::int) filter (where expected = 'A')::numeric, 3) as a_acc,
         round(avg(passed::int) filter (where expected = 'B')::numeric, 3) as b_acc
  from results where run_id in (...) group by run_id, model order by run_id desc, accuracy desc
Accuracy per class as rows instead of columns:
  select run_id, model, expected, count(*) as cases, round(avg(passed::int)::numeric, 3) as accuracy
  from results where ... group by run_id, model, expected order by run_id, model, expected
Compare versions of a profile:
  select profile_version, model, round(avg(accuracy)::numeric, 3) as accuracy, sum(total_cost_usd) as cost
  from model_summary where profile_id = N group by profile_version, model order by profile_version, accuracy desc
Most common mistakes:
  select expected, processed_output, count(*) from results where run_id = N and not passed
  group by expected, processed_output order by count(*) desc limit 20
Postgres notes: FILTER goes right after the aggregate: avg(x) filter (where ...), then round(...::numeric, 3) around it. Output aliases can't be used inside ORDER BY expressions (repeat the expression). Cast booleans with ::int before averaging.

## Things you remember from earlier sessions
{memories}

## How to work
- Plan the query from the schema and the notes above, then call write_query once with a query that fully answers the question. Only use tables and columns listed above. Don't write exploratory queries.
- Filter to the current scope (run_id / profile_id) unless the user asks more broadly.
- BenchMonster data and each connected database are separate databases: one query can't join across them. If a question needs both, write one query per source and say how to combine them.
- If the user reports an error, find the cause, fix it and call write_query again with the corrected query.
- After writing the query, reply briefly: what it returns (its columns) and anything to change (e.g. which run ids to put in). Don't paste the SQL into your reply; it's shown from write_query. Keep it short; you may be read aloud.
- If the user shares results or facts worth keeping, you may call save_finding.
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


async def _data_notes(scope: Scope) -> str:
    """Facts the analyst would otherwise have to query for: run ids, models, the answer values and
    input keys of each profile in scope (read from its latest run)."""
    pool = db.pool()
    if scope.run_id:
        profiles = await pool.fetch(
            "select p.id, p.name from runs r join benchmark_profiles p on p.id = r.profile_id where r.id = $1", scope.run_id
        )
    elif scope.profile_id:
        profiles = await pool.fetch("select id, name from benchmark_profiles where id = $1", scope.profile_id)
    else:
        profiles = await pool.fetch(
            "select id, name from benchmark_profiles where org_id = $1 order by updated_at desc limit 15", scope.org_id
        )
    lines = []
    for p in profiles:
        runs = await pool.fetch(
            "select id from runs where profile_id = $1 and status in ('completed', 'running', 'failed') order by id desc limit 12", p["id"]
        )
        if not runs:
            lines.append(f'- "{p["name"]}" (profile_id {p["id"]}): no runs yet')
            continue
        latest = runs[0]["id"]
        expected = await pool.fetch(
            """select expected, count(*) as n from (select expected from run_inputs where run_id = $1 and expected is not null limit 5000) s
               group by expected order by n desc limit 20""",
            latest,
        )
        distinct = await pool.fetchval(
            "select count(distinct expected) from (select expected from run_inputs where run_id = $1 limit 5000) s", latest
        )
        keys = await pool.fetch(
            "select distinct jsonb_object_keys(variables) as k from (select variables from run_inputs where run_id = $1 limit 20) s",
            latest,
        )
        models = await pool.fetch(
            "select m.display_name from run_models rm join models m on m.id = rm.model_id where rm.run_id = $1 order by 1", latest
        )
        values = ", ".join(repr(e["expected"][:40]) for e in expected[:16])
        exp_text = (f"expected has {distinct} distinct values" + (f", e.g. {values}" if distinct <= 40 else " (free text)")) if expected else "no expected values"
        lines.append(
            f'- "{p["name"]}" (profile_id {p["id"]}): run_ids {", ".join(str(r["id"]) for r in runs)} (latest first); '
            f"latest run's models: {', '.join(m['display_name'] for m in models)}; {exp_text}; "
            f"variables keys: {', '.join(k['k'] for k in keys) or 'none'}"
        )
    return "\n".join(lines) or "(no benchmark profiles yet)"


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
        connections=await _connections_context(scope.org_id),
        notes=await _data_notes(scope),
        memories="\n".join(f"- {m}" for m in memories) or "(nothing yet)",
    )
    return system, label


MAX_CONNECTION_TABLES = 40


async def _pg_connections(org_id: int) -> list:
    return await db.pool().fetch(
        """select id, name from connections where org_id = $1 and kind = 'postgres'
           and coalesce((access->>'read')::boolean, false) order by lower(name)""",
        org_id,
    )


async def _connections_context(org_id: int) -> str:
    """Each readable Postgres connection with its tables, for the model to query with source=<name>."""
    async def describe(c) -> str:
        try:
            _, cfg, sec = await linked.load_connection(org_id, c["id"])
            tables = await asyncio.wait_for(conns.pg_schema(cfg, sec), timeout=10)
        except Exception as e:  # an unreachable connection shouldn't break the analyst
            return f'"{c["name"]}": unavailable ({getattr(e, "detail", None) or type(e).__name__})'
        more = f"\n  (+{len(tables) - MAX_CONNECTION_TABLES} more tables)" if len(tables) > MAX_CONNECTION_TABLES else ""
        return f'"{c["name"]}":\n' + "\n".join(f"  {line}" for line in sqlconsole.schema_as_text(tables[:MAX_CONNECTION_TABLES]).splitlines()) + more

    rows = await _pg_connections(org_id)
    if not rows:
        return "(none)"
    return "\n".join(await asyncio.gather(*(describe(c) for c in rows)))


async def _run_tool(scope: Scope, label: str, name: str, args: dict) -> tuple[str, dict]:
    """Returns (text for the model, record for the UI)."""
    if name == "write_query":
        sql = (args.get("sql") or "").strip()
        source = (args.get("source") or "").strip()
        if source.lower() in ("", "benchmonster", "benchmonster data", "default"):
            source_name = None
        else:
            match = next((c for c in await _pg_connections(scope.org_id) if c["name"].lower() == source.lower()), None)
            if not match:
                return (f"ERROR: no connected database named {source!r}", {"tool": "query", "title": args.get("title"), "sql": sql,
                                                                            "source": source, "error": f"unknown source {source!r}"})
            source_name = match["name"]
        return "shown to the user (not run)", {"tool": "query", "title": (args.get("title") or "").strip() or None,
                                               "sql": sql, "source": source_name}
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


def _with_queries(content: str | None, tool_calls: list | None) -> str:
    """An earlier reply plus the queries it wrote, so the analyst can fix one when the user reports an error."""
    queries = [c for c in tool_calls or [] if c.get("tool") in ("query", "run_sql") and c.get("sql")]
    parts = [content or ""] + [
        f"[query you wrote{': ' + c['title'] if c.get('title') else ''}{' (source: ' + c['source'] + ')' if c.get('source') else ''}]\n{c['sql']}"
        for c in queries
    ]
    return "\n\n".join(p for p in parts if p)


async def chat(scope: Scope, user_message: str) -> dict:
    """One analyst turn. The scope must come from resolve_scope (org ownership checked)."""
    system, label = await _system_prompt(scope, user_message)
    cond, args = scope.where()
    past = await db.pool().fetch(
        f"""select role, content, tool_calls from (
               select id, role, content, tool_calls from assistant_messages
               where {cond} and role in ('user', 'assistant') order by id desc limit ${len(args) + 1}
           ) t order by id""",
        *args, HISTORY_TURNS * 2,
    )
    messages = [{"role": "system", "content": system}]
    messages += [{"role": r["role"], "content": _with_queries(r["content"], r["tool_calls"])} for r in past]
    messages.append({"role": "user", "content": user_message})

    ep = providers.vultr_endpoint(settings.assistant_model)
    tool_records: list[dict] = []
    drafts: list[str] = []  # answer text the model wrote alongside tool calls
    reply = None
    empty_retry = False
    for _ in range(MAX_TOOL_ROUNDS):
        resp = await providers.complete(ep, messages, tools=TOOLS, max_tokens=8192, temperature=0.2)
        msg = resp["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        if not calls:
            reply = (msg.get("content") or "").strip()
            if reply or empty_retry:
                break
            # An empty reply (e.g. the budget went on thinking): nudge once instead of giving up.
            empty_retry = True
            messages.append({"role": "user", "content": "Call write_query now with the query that answers my question, then explain it briefly."})
            continue
        if (msg.get("content") or "").strip():
            drafts.append(msg["content"].strip())
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for call in calls:
            try:
                call_args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                call_args = {}
            text, record = await _run_tool(scope, label, call["function"]["name"], call_args)
            tool_records.append(record)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
    # Keep a substantial answer written next to a tool call (e.g. before save_finding) if the
    # final message is only a short sign-off.
    longest = max(drafts, key=len, default="")
    if len(longest) > 200 and len(reply or "") < len(longest) / 2:
        reply = f"{longest}\n\n{reply}".strip() if reply else longest
    if not reply and any(r.get("tool") == "query" for r in tool_records):
        reply = "Here's the query; run it in the console."
    if not reply:
        reply = "I couldn't produce an answer this time (the model returned nothing). Try again, or split the question into smaller parts."

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
