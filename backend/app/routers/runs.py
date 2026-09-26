from fastapi import APIRouter, HTTPException

from .. import db

router = APIRouter(prefix="/api/runs", tags=["runs"])


@router.get("/{run_id}")
async def get_run(run_id: int):
    """Run status, per-model progress, and summary metrics (for polling)."""
    pool = db.pool()
    run = await pool.fetchrow(
        """select r.*, b.name as benchmark_name, b.scoring_method
           from runs r join benchmarks b on b.id = r.benchmark_id where r.id = $1""",
        run_id,
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


@router.get("/{run_id}/results")
async def get_results(run_id: int, model_id: int | None = None, only_failed: bool = False,
                      limit: int = 200, offset: int = 0):
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


@router.get("/{run_id}/latency")
async def latency_distribution(run_id: int):
    """Raw latencies per model, for box/scatter charts."""
    rows = await db.pool().fetch(
        """select m.display_name as model, res.latency_ms, res.ttft_ms, res.score, res.cost_usd
           from results res join models m on m.id = res.model_id
           where res.run_id = $1 and res.error is null""",
        run_id,
    )
    return [dict(r) for r in rows]
