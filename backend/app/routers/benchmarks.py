from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .. import auth, datasets, db, runner, scoring

router = APIRouter(prefix="/api", tags=["benchmarks"])


@router.post("/datasets/parse")
async def parse_dataset(file: UploadFile, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Parse an upload for preview; the client then posts the mapped cases."""
    try:
        rows = datasets.parse(file.filename or "", await file.read())
    except (datasets.DatasetError, ValueError) as e:
        raise HTTPException(400, str(e))
    columns = list(rows[0].keys())
    return {
        "columns": columns,
        "rows": rows,
        "suggested_input": datasets.guess_column(columns, datasets.INPUT_GUESSES) or columns[0],
        "suggested_expected": datasets.guess_column(columns, datasets.EXPECTED_GUESSES),
    }


class CaseIn(BaseModel):
    input: str
    expected: str | None = None
    metadata: dict = {}


class BenchmarkIn(BaseModel):
    name: str = Field(min_length=1)
    description: str | None = None
    system_prompt: str | None = None
    prompt_template: str = "{input}"
    scoring_method: Literal[scoring.METHODS]  # type: ignore[valid-type]
    scoring_config: dict = {}
    cases: list[CaseIn] = Field(min_length=1, max_length=datasets.MAX_ROWS)


@router.post("/benchmarks")
async def create_benchmark(body: BenchmarkIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    if "{input}" not in body.prompt_template:
        raise HTTPException(400, "prompt_template must contain {input}")
    if body.scoring_method == "json_schema" and not body.scoring_config.get("schema"):
        raise HTTPException(400, "json_schema scoring needs scoring_config.schema")
    async with db.pool().acquire() as conn, conn.transaction():
        bench_id = await conn.fetchval(
            """insert into benchmarks (org_id, name, description, system_prompt, prompt_template,
                   scoring_method, scoring_config)
               values ($1, $2, $3, $4, $5, $6, $7) returning id""",
            ctx.org_id, body.name, body.description, body.system_prompt, body.prompt_template,
            body.scoring_method, body.scoring_config,
        )
        # executemany, not COPY: COPY's binary format bypasses the jsonb text codec.
        await conn.executemany(
            "insert into cases (benchmark_id, idx, input, expected, metadata) values ($1, $2, $3, $4, $5)",
            [(bench_id, i, c.input, c.expected, c.metadata) for i, c in enumerate(body.cases)],
        )
    return {"id": bench_id}


@router.get("/benchmarks")
async def list_benchmarks(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        """select b.id, b.name, b.description, b.scoring_method, b.created_at,
                  (select count(*) from cases c where c.benchmark_id = b.id) as case_count,
                  (select count(*) from runs r where r.benchmark_id = b.id) as run_count
           from benchmarks b where b.org_id = $1 order by b.created_at desc""",
        ctx.org_id,
    )
    return [dict(r) for r in rows]


@router.get("/benchmarks/{bench_id}")
async def get_benchmark(bench_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    pool = db.pool()
    bench = await pool.fetchrow("select * from benchmarks where id = $1 and org_id = $2", bench_id, ctx.org_id)
    if not bench:
        raise HTTPException(404, "benchmark not found")
    cases = await pool.fetch(
        "select idx, input, expected from cases where benchmark_id = $1 order by idx limit 20", bench_id
    )
    runs = await pool.fetch(
        "select id, status, total_cases, created_at, finished_at from runs where benchmark_id = $1"
        " order by created_at desc",
        bench_id,
    )
    case_count = await pool.fetchval("select count(*) from cases where benchmark_id = $1", bench_id)
    return {
        **dict(bench),
        "case_count": case_count,
        "sample_cases": [dict(c) for c in cases],
        "runs": [dict(r) for r in runs],
    }


class RunIn(BaseModel):
    model_ids: list[int] = Field(min_length=1)
    max_tokens: int = Field(4096, ge=16, le=32768)
    temperature: float = Field(0.0, ge=0, le=2)
    concurrency: int = Field(8, ge=1, le=32)


@router.post("/benchmarks/{bench_id}/runs")
async def start_run(bench_id: int, body: RunIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    pool = db.pool()
    case_count = await pool.fetchval(
        """select count(*) from cases c join benchmarks b on b.id = c.benchmark_id
           where c.benchmark_id = $1 and b.org_id = $2""",
        bench_id, ctx.org_id,
    )
    if not case_count:
        raise HTTPException(404, "benchmark not found or has no cases")
    found = await pool.fetchval(
        "select count(*) from models where id = any($1) and active and (org_id is null or org_id = $2)",
        body.model_ids, ctx.org_id,
    )
    if found != len(set(body.model_ids)):
        raise HTTPException(400, "unknown or inactive model id")
    async with pool.acquire() as conn, conn.transaction():
        run_id = await conn.fetchval(
            "insert into runs (benchmark_id, params, total_cases) values ($1, $2, $3) returning id",
            bench_id, body.model_dump(exclude={"model_ids"}), case_count,
        )
        await conn.executemany(
            "insert into run_models (run_id, model_id) values ($1, $2)",
            [(run_id, m) for m in set(body.model_ids)],
        )
    runner.start(run_id)
    return {"id": run_id}
