import csv
import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from .. import auth, db

router = APIRouter(prefix="/api/runs", tags=["runs"])


@router.get("/{run_id}")
async def get_run(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Run status, per-model progress, and summary metrics (for polling)."""
    pool = db.pool()
    run = await pool.fetchrow(
        """select r.*, b.name as benchmark_name, b.scoring_method
           from runs r join benchmarks b on b.id = r.benchmark_id where r.id = $1 and b.org_id = $2""",
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
        "models": [dict(m) for m in models],
        "summary": [dict(s) for s in summary],
    }


@router.get("/{run_id}/config")
async def get_run_config(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Everything that went into a run (dataset, prompts, scoring, models, params), for cloning."""
    await auth.run_in_org(run_id, ctx.org_id)
    pool = db.pool()
    row = await pool.fetchrow(
        """select b.id as benchmark_id, b.name, b.description, b.system_prompt, b.prompt_template,
                  b.scoring_method, b.scoring_config, r.params
           from runs r join benchmarks b on b.id = r.benchmark_id where r.id = $1""",
        run_id,
    )
    cases = await pool.fetch(
        "select input, expected from cases where benchmark_id = $1 order by idx", row["benchmark_id"]
    )
    model_ids = [r["model_id"] for r in await pool.fetch("select model_id from run_models where run_id = $1", run_id)]
    return {**dict(row), "cases": [dict(c) for c in cases], "model_ids": model_ids}


@router.get("/{run_id}/results")
async def get_results(run_id: int, model_id: int | None = None, only_failed: bool = False,
                      limit: int = 200, offset: int = 0, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await auth.run_in_org(run_id, ctx.org_id)
    rows = await db.pool().fetch(
        """select res.id, res.model_id, m.display_name as model, c.idx as case_idx, c.input,
                  c.expected, res.output, res.score, res.passed, res.judge_rationale,
                  res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out,
                  res.reasoning_tokens, res.cost_usd, res.error
           from results res
           join cases c on c.id = res.case_id
           join models m on m.id = res.model_id
           where res.run_id = $1
             and ($2::int is null or res.model_id = $2)
             and (not $3 or not coalesce(res.passed, false))
           order by c.idx, m.display_name
           limit $4 offset $5""",
        run_id, model_id, only_failed, min(limit, 1000), offset,
    )
    return [dict(r) for r in rows]


EXPORT_COLUMNS = [
    "model", "model_id", "case_idx", "input", "expected", "output", "score", "passed", "judge_rationale",
    "latency_ms", "ttft_ms", "tokens_in", "tokens_out", "reasoning_tokens", "tokens_per_sec", "cost_usd", "error",
]


@router.get("/{run_id}/export.csv")
async def export_csv(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Every input and output of the run as a CSV download."""
    await auth.run_in_org(run_id, ctx.org_id)
    rows = await db.pool().fetch(
        f"select {', '.join(EXPORT_COLUMNS)} from analytics.results where run_id = $1 order by case_idx, model",
        run_id,
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(EXPORT_COLUMNS)
    writer.writerows([list(r.values()) for r in rows])
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="run-{run_id}.csv"'},
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
