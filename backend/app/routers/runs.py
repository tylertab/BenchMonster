import csv
import io
import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import auth, db, runner, scoring, templates

router = APIRouter(prefix="/api/runs", tags=["runs"])

MAX_INPUTS = 10_000
NEEDS_EXPECTED = {"exact", "contains", "numeric", "json_fields"}


# --- Create -----------------------------------------------------------------


class RunDatasetIn(BaseModel):
    dataset_id: int
    mapping: dict[str, str] = {}  # {template variable: dataset column}
    expected_column: str | None = None


class RunIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    prompt_id: int
    # Optional per-run overrides of the prompt (e.g. from clone & edit).
    template: str | None = Field(None, max_length=50000)
    system_prompt: str | None = Field(None, max_length=20000)
    datasets: list[RunDatasetIn] = Field(min_length=1, max_length=20)
    scoring_method: Literal[scoring.METHODS]  # type: ignore[valid-type]
    scoring_config: dict = {}
    model_ids: list[int] = Field(min_length=1)
    max_tokens: int = Field(4096, ge=16, le=32768)
    temperature: float = Field(0.0, ge=0, le=2)
    concurrency: int = Field(8, ge=1, le=32)
    output_name: str | None = Field(None, max_length=200)


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "run"


def _output_name(requested: str | None, prompt_name: str) -> str:
    if requested and requested.strip():
        base = re.sub(r"\s+", "-", re.sub(r"[^\w.\- ]+", "", requested.strip()).strip()) or "predictions"
    else:
        base = f"{_slug(prompt_name)}-{datetime.now(timezone.utc):%Y%m%d-%H%M}-predictions"
    return base if base.lower().endswith(".csv") else f"{base}.csv"


@router.post("")
async def create_run(body: RunIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    pool = db.pool()
    prompt = await pool.fetchrow("select * from prompts where id = $1 and org_id = $2", body.prompt_id, ctx.org_id)
    if not prompt:
        raise HTTPException(404, "prompt not found")
    template = body.template if body.template is not None else prompt["template"]
    system_prompt = body.system_prompt if body.system_prompt is not None else prompt["system_prompt"]
    variables = templates.variables(template)
    if not variables:
        raise HTTPException(400, "the template has no {{variables}}")
    if body.scoring_method == "json_schema" and not body.scoring_config.get("schema"):
        raise HTTPException(400, "json_schema scoring needs scoring_config.schema")

    found = await pool.fetchval(
        "select count(*) from models where id = any($1) and active and (org_id is null or org_id = $2)",
        body.model_ids, ctx.org_id,
    )
    if found != len(set(body.model_ids)):
        raise HTTPException(400, "unknown or inactive model id")

    # Validate every dataset and render every input before writing anything.
    run_datasets, inputs = [], []
    for pos, rd in enumerate(body.datasets):
        ds = await pool.fetchrow(
            "select id, name, filename, columns from datasets where id = $1 and org_id = $2", rd.dataset_id, ctx.org_id
        )
        if not ds:
            raise HTTPException(404, f"dataset {rd.dataset_id} not found")
        cols = set(ds["columns"])
        # Unmapped variables default to a same-named column.
        mapping = {v: rd.mapping.get(v) or v for v in variables}
        missing = [f"{{{{{v}}}}} → {c}" for v, c in mapping.items() if c not in cols]
        if missing:
            raise HTTPException(400, f"{ds['filename']}: no column for {', '.join(missing)}")
        if rd.expected_column and rd.expected_column not in cols:
            raise HTTPException(400, f"{ds['filename']}: no column {rd.expected_column!r}")
        if body.scoring_method in NEEDS_EXPECTED and not rd.expected_column:
            raise HTTPException(400, f"{ds['filename']}: {body.scoring_method} scoring needs an expected column")
        run_datasets.append((pos, ds["id"], ds["name"], ds["filename"], mapping, rd.expected_column))
        rows = await pool.fetch("select idx, data from dataset_rows where dataset_id = $1 order by idx", ds["id"])
        for r in rows:
            values = {v: r["data"].get(c, "") for v, c in mapping.items()}
            expected = r["data"].get(rd.expected_column) if rd.expected_column else None
            inputs.append((pos, r["idx"], values, templates.render(template, values), expected))
        if len(inputs) > MAX_INPUTS:
            raise HTTPException(400, f"too many inputs ({len(inputs)}+); the limit is {MAX_INPUTS}")
    if not inputs:
        raise HTTPException(400, "the selected datasets have no rows")

    params = {"max_tokens": body.max_tokens, "temperature": body.temperature, "concurrency": body.concurrency}
    async with pool.acquire() as conn, conn.transaction():
        run_id = await conn.fetchval(
            """insert into runs (org_id, name, prompt_id, prompt_name, system_prompt, template,
                   scoring_method, scoring_config, params, total_inputs, output_name, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id""",
            ctx.org_id, (body.name or "").strip() or None, prompt["id"], prompt["name"],
            (system_prompt or "").strip() or None, template, body.scoring_method, body.scoring_config,
            params, len(inputs), _output_name(body.output_name, prompt["name"]), ctx.user_id,
        )
        await conn.executemany(
            """insert into run_datasets (run_id, position, dataset_id, dataset_name, filename, mapping, expected_column)
               values ($1, $2, $3, $4, $5, $6, $7)""",
            [(run_id, *rd) for rd in run_datasets],
        )
        await conn.executemany(
            """insert into run_inputs (run_id, dataset_position, row_idx, variables, prompt, expected)
               values ($1, $2, $3, $4, $5, $6)""",
            [(run_id, *i) for i in inputs],
        )
        await conn.executemany(
            "insert into run_models (run_id, model_id) values ($1, $2)", [(run_id, m) for m in set(body.model_ids)]
        )
    runner.start(run_id)
    return {"id": run_id}


# --- List (dashboard) ---------------------------------------------------------


@router.get("")
async def list_runs(
    q: str | None = None,
    status: str | None = None,
    prompt_id: int | None = None,
    dataset_id: int | None = None,
    model_id: int | None = None,
    sort: Literal["newest", "oldest"] = "newest",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    ctx: auth.Ctx = Depends(auth.current_ctx),
):
    """Runs with their metadata; `q` searches run/prompt names, template, file names, and models."""
    where = ["r.org_id = $1"]
    args: list = [ctx.org_id]

    def arg(v) -> str:
        args.append(v)
        return f"${len(args)}"

    if q and q.strip():
        term = q.strip()
        if term.lstrip("#").isdigit():
            where.append(f"r.id = {arg(int(term.lstrip('#')))}")
        else:
            p = arg(f"%{term}%")
            where.append(
                f"""(r.name ilike {p} or r.prompt_name ilike {p} or r.template ilike {p} or r.output_name ilike {p}
                     or exists (select 1 from run_datasets rd where rd.run_id = r.id
                                and (rd.filename ilike {p} or rd.dataset_name ilike {p}))
                     or exists (select 1 from run_models rm join models m on m.id = rm.model_id
                                where rm.run_id = r.id and (m.display_name ilike {p} or m.model_id ilike {p})))"""
            )
    if status:
        where.append(f"r.status = {arg(status)}")
    if prompt_id:
        where.append(f"r.prompt_id = {arg(prompt_id)}")
    if dataset_id:
        where.append(f"exists (select 1 from run_datasets rd where rd.run_id = r.id and rd.dataset_id = {arg(dataset_id)})")
    if model_id:
        where.append(f"exists (select 1 from run_models rm where rm.run_id = r.id and rm.model_id = {arg(model_id)})")

    cond = " and ".join(where)
    pool = db.pool()
    total = await pool.fetchval(f"select count(*) from runs r where {cond}", *args)
    rows = await pool.fetch(
        f"""select r.id, r.name, r.status, r.prompt_id, r.prompt_name, r.template, r.output_name,
                   r.scoring_method, r.total_inputs, r.created_at, r.started_at, r.finished_at,
                   u.name as created_by,
                   (select coalesce(json_agg(rd.filename order by rd.position), '[]')
                      from run_datasets rd where rd.run_id = r.id) as input_files,
                   (select coalesce(json_agg(m.display_name order by m.display_name), '[]')
                      from run_models rm join models m on m.id = rm.model_id where rm.run_id = r.id) as models,
                   (select count(*) from results res where res.run_id = r.id) as done,
                   (select max(accuracy) from analytics.model_summary s where s.run_id = r.id) as best_accuracy,
                   (select sum(cost_usd) from results res where res.run_id = r.id) as total_cost_usd
            from runs r left join users u on u.id = r.created_by
            where {cond}
            order by r.created_at {'desc' if sort == 'newest' else 'asc'}, r.id {'desc' if sort == 'newest' else 'asc'}
            limit {arg(limit)} offset {arg(offset)}""",
        *args,
    )
    return {"total": total, "items": [dict(r) for r in rows]}


# --- Single run -------------------------------------------------------------------


async def _datasets(run_id: int) -> list[dict]:
    rows = await db.pool().fetch(
        """select rd.position, rd.dataset_id, rd.dataset_name, rd.filename, rd.mapping, rd.expected_column,
                  (select count(*) from run_inputs ri where ri.run_id = rd.run_id and ri.dataset_position = rd.position) as rows
           from run_datasets rd where rd.run_id = $1 order by rd.position""",
        run_id,
    )
    return [dict(r) for r in rows]


@router.get("/{run_id}")
async def get_run(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Run metadata, per-model progress, and summary metrics (for polling)."""
    pool = db.pool()
    run = await pool.fetchrow(
        """select r.*, u.name as created_by_name from runs r left join users u on u.id = r.created_by
           where r.id = $1 and r.org_id = $2""",
        run_id, ctx.org_id,
    )
    if not run:
        raise HTTPException(404, "run not found")
    models = await pool.fetch(
        """select m.id, m.display_name, m.model_id, m.provider, m.is_custom,
                  count(res.id) as done,
                  count(res.id) filter (where res.error is not null) as errors
           from run_models rm
           join models m on m.id = rm.model_id
           left join results res on res.run_id = rm.run_id and res.model_id = m.id
           where rm.run_id = $1
           group by m.id order by m.display_name""",
        run_id,
    )
    summary = await pool.fetch(
        "select * from analytics.model_summary where run_id = $1 order by accuracy desc nulls last", run_id
    )
    return {
        **dict(run),
        "variables": templates.variables(run["template"]),
        "datasets": await _datasets(run_id),
        "models": [dict(m) for m in models],
        "summary": [dict(s) for s in summary],
    }


@router.get("/{run_id}/config")
async def get_run_config(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Everything needed to prefill a new run from this one (clone & edit)."""
    await auth.run_in_org(run_id, ctx.org_id)
    pool = db.pool()
    run = await pool.fetchrow(
        """select r.name, r.prompt_id, r.prompt_name, r.template, r.system_prompt, r.scoring_method,
                  r.scoring_config, r.params, r.output_name,
                  p.template as current_template, p.system_prompt as current_system_prompt
           from runs r left join prompts p on p.id = r.prompt_id where r.id = $1""",
        run_id,
    )
    model_ids = [r["model_id"] for r in await pool.fetch("select model_id from run_models where run_id = $1", run_id)]
    return {**dict(run), "datasets": await _datasets(run_id), "model_ids": model_ids}


@router.get("/{run_id}/results")
async def get_results(run_id: int, model_id: int | None = None, only_failed: bool = False,
                      limit: int = 200, offset: int = 0, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await auth.run_in_org(run_id, ctx.org_id)
    rows = await db.pool().fetch(
        """select res.id, res.model_id, m.display_name as model, rd.filename as input_file,
                  ri.row_idx, ri.variables, ri.prompt, ri.expected, res.output, res.score, res.passed,
                  res.judge_rationale, res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out,
                  res.reasoning_tokens, res.cost_usd, res.error
           from results res
           join run_inputs ri on ri.id = res.input_id
           join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
           join models m on m.id = res.model_id
           where res.run_id = $1
             and ($2::int is null or res.model_id = $2)
             and (not $3 or not coalesce(res.passed, false))
           order by ri.dataset_position, ri.row_idx, m.display_name
           limit $4 offset $5""",
        run_id, model_id, only_failed, min(limit, 1000), offset,
    )
    return [dict(r) for r in rows]


PREDICTION_COLUMNS = [
    "prediction", "expected", "score", "passed", "judge_rationale", "latency_ms", "ttft_ms",
    "tokens_in", "tokens_out", "reasoning_tokens", "tokens_per_sec", "cost_usd", "error",
]


@router.get("/{run_id}/predictions")
async def predictions(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """The run's output predictions file: one row per (input, model), named output_name."""
    run = await db.pool().fetchrow(
        "select output_name, template from runs where id = $1 and org_id = $2", run_id, ctx.org_id
    )
    if not run:
        raise HTTPException(404, "run not found")
    variables = templates.variables(run["template"])
    rows = await db.pool().fetch(
        """select rd.filename as input_file, ri.row_idx, ri.variables, ri.prompt, m.display_name as model,
                  m.model_id, res.output as prediction, ri.expected, res.score, res.passed, res.judge_rationale,
                  res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out, res.reasoning_tokens,
                  res.tokens_per_sec, res.cost_usd, res.error
           from results res
           join run_inputs ri on ri.id = res.input_id
           join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
           join models m on m.id = res.model_id
           where res.run_id = $1
           order by ri.dataset_position, ri.row_idx, m.display_name""",
        run_id,
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["input_file", "row", *variables, "prompt", "model", "model_id", *PREDICTION_COLUMNS])
    for r in rows:
        writer.writerow(
            [r["input_file"], r["row_idx"], *(r["variables"].get(v, "") for v in variables), r["prompt"],
             r["model"], r["model_id"], *(r[c] for c in PREDICTION_COLUMNS)]
        )
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{run["output_name"]}"'},
    )


@router.get("/{run_id}/latency")
async def latency_distribution(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Raw latencies per model, for box/scatter charts."""
    await auth.run_in_org(run_id, ctx.org_id)
    rows = await db.pool().fetch(
        """select m.display_name as model, res.latency_ms, res.ttft_ms, res.score, res.cost_usd
           from results res join models m on m.id = res.model_id
           where res.run_id = $1 and res.error is null""",
        run_id,
    )
    return [dict(r) for r in rows]


@router.delete("/{run_id}")
async def delete_run(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    status = await db.pool().fetchval("select status from runs where id = $1 and org_id = $2", run_id, ctx.org_id)
    if status is None:
        raise HTTPException(404, "run not found")
    if status in ("queued", "running"):
        raise HTTPException(409, "wait for the run to finish before deleting it")
    await db.pool().execute("delete from runs where id = $1", run_id)
    return {"ok": True}
