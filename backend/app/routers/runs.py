import csv
import io
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import auth, db, exports, runconfig, templates

router = APIRouter(prefix="/api/runs", tags=["runs"])

MAX_INPUTS = 10_000
NEEDS_EXPECTED = {"exact", "contains", "numeric", "json_fields"}


# --- List (dashboard) ---------------------------------------------------------


@router.get("")
async def list_runs(
    q: str | None = None,
    status: str | None = None,
    prompt_id: int | None = None,
    profile_id: int | None = None,
    version: int | None = None,
    dataset_id: int | None = None,
    model_id: int | None = None,
    sort: Literal["newest", "oldest"] = "newest",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    ctx: auth.Ctx = Depends(auth.current_ctx),
):
    """Runs with their metadata; `q` searches run/profile/prompt names, template, file names, and models."""
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
                     or exists (select 1 from benchmark_profiles bp where bp.id = r.profile_id and bp.name ilike {p})
                     or exists (select 1 from run_datasets rd where rd.run_id = r.id
                                and (rd.filename ilike {p} or rd.dataset_name ilike {p}))
                     or exists (select 1 from run_models rm join models m on m.id = rm.model_id
                                where rm.run_id = r.id and (m.display_name ilike {p} or m.model_id ilike {p})))"""
            )
    if status:
        where.append(f"r.status = {arg(status)}")
    if prompt_id:
        where.append(f"r.prompt_id = {arg(prompt_id)}")
    if profile_id:
        where.append(f"r.profile_id = {arg(profile_id)}")
    if version:
        where.append(f"r.profile_version = {arg(version)}")
    if dataset_id:
        d = arg(dataset_id)
        where.append(f"exists (select 1 from run_datasets rd where rd.run_id = r.id and (rd.dataset_id = {d} or rd.expected_dataset_id = {d}))")
    if model_id:
        where.append(f"exists (select 1 from run_models rm where rm.run_id = r.id and rm.model_id = {arg(model_id)})")

    cond = " and ".join(where)
    pool = db.pool()
    total = await pool.fetchval(f"select count(*) from runs r where {cond}", *args)
    rows = await pool.fetch(
        f"""select r.id, r.name, r.status, r.prompt_id, r.prompt_name, r.template, r.output_name,
                   r.profile_id, r.profile_version, (select name from benchmark_profiles bp where bp.id = r.profile_id) as profile_name,
                   r.scoring_method, r.total_inputs, r.created_at, r.started_at, r.finished_at,
                   u.name as created_by,
                   (select coalesce(json_agg(rd.filename order by rd.position), '[]')
                      from run_datasets rd where rd.run_id = r.id) as input_files,
                   (select coalesce(json_agg(m.display_name order by m.display_name), '[]')
                      from run_models rm join models m on m.id = rm.model_id where rm.run_id = r.id) as models,
                   (select count(*) from results res where res.run_id = r.id) as done,
                   top.accuracy as best_accuracy, top.model as top_model,
                   (select sum(cost_usd) from results res where res.run_id = r.id) as total_cost_usd
            from runs r left join users u on u.id = r.created_by
            left join lateral (
                select s.accuracy, s.model from analytics.model_summary s
                where s.run_id = r.id order by s.accuracy desc nulls last, s.total_cost_usd limit 1
            ) top on true
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
                  rd.expected_dataset_id, rd.expected_filename, rd.input_key, rd.expected_key, rd.selection,
                  rd.source, rd.fields,
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
        """select r.*, u.name as created_by_name, bp.name as profile_name, bp.current_version as profile_current_version
           from runs r left join users u on u.id = r.created_by
           left join benchmark_profiles bp on bp.id = r.profile_id
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
        "bindings": await runconfig.with_filenames(run["bindings"]),
        "variables": templates.variables(f'{run["template"]} {run["system_prompt"] or ""}'),
        "datasets": await _datasets(run_id),
        "models": [dict(m) for m in models],
        "summary": [dict(s) for s in summary],
    }


@router.get("/{run_id}/results")
async def get_results(run_id: int, model_id: int | None = None, only_failed: bool = False,
                      limit: int = 200, offset: int = 0, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await auth.run_in_org(run_id, ctx.org_id)
    rows = await db.pool().fetch(
        """select res.id, res.model_id, m.display_name as model, rd.filename as input_file,
                  ri.row_idx, ri.variables, ri.prompt, ri.expected, res.output, res.processed_output, res.score, res.passed,
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
    "prediction", "processed_output", "expected", "score", "passed", "judge_rationale", "latency_ms", "ttft_ms",
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
                  m.model_id, res.output as prediction, res.processed_output, ri.expected, res.score, res.passed, res.judge_rationale,
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


class ExportIn(BaseModel):
    connection_id: int
    target: str | None = Field(None, max_length=300)  # bucket folder, or Postgres table prefix


@router.post("/{run_id}/exports")
async def export_run(run_id: int, body: ExportIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Copy the run's results to a connection that allows writes."""
    return await exports.export_run(ctx.org_id, run_id, body.connection_id, body.target, user_id=ctx.user_id)


@router.get("/{run_id}/exports")
async def list_exports(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await auth.run_in_org(run_id, ctx.org_id)
    rows = await db.pool().fetch(
        """select e.id, e.connection_id, e.connection_name, e.target, e.status, e.detail, e.rows, e.automatic,
                  e.created_at, u.name as created_by
           from run_exports e left join users u on u.id = e.created_by
           where e.run_id = $1 order by e.created_at desc""",
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
