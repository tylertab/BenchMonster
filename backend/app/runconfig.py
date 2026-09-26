"""A run configuration (what a benchmark profile version stores) and turning it into a run.

Validation renders every input up front, so a bad mapping or missing column
fails before anything is written or any model is called.
"""

import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from . import db, runner, scoring, templates

MAX_INPUTS = 10_000
NEEDS_EXPECTED = {"exact", "contains", "numeric", "json_fields"}


class DatasetRef(BaseModel):
    dataset_id: int
    mapping: dict[str, str] = {}  # {template variable: dataset column}
    expected_column: str | None = None


class RunConfig(BaseModel):
    prompt_name: str = Field(min_length=1, max_length=200)
    system_prompt: str | None = Field(None, max_length=20000)
    template: str = Field(min_length=1, max_length=50000)
    datasets: list[DatasetRef] = Field(min_length=1, max_length=20)
    scoring_method: Literal[scoring.METHODS]  # type: ignore[valid-type]
    scoring_config: dict = {}
    model_ids: list[int] = Field(min_length=1)
    max_tokens: int = Field(4096, ge=16, le=32768)
    temperature: float = Field(0.0, ge=0, le=2)
    concurrency: int = Field(8, ge=1, le=32)

    def params(self) -> dict:
        return {"max_tokens": self.max_tokens, "temperature": self.temperature, "concurrency": self.concurrency}


class Prepared(BaseModel):
    """A validated config: datasets resolved and every input rendered."""

    datasets: list[tuple]  # (position, dataset_id, name, filename, mapping, expected_column)
    inputs: list[tuple]  # (position, row_idx, variables, prompt, expected)


async def prepare(org_id: int, cfg: RunConfig, *, render: bool = True) -> Prepared:
    pool = db.pool()
    variables = templates.variables(cfg.template)
    if not variables:
        raise HTTPException(400, "the template has no {{variables}}")
    if cfg.scoring_method == "json_schema" and not cfg.scoring_config.get("schema"):
        raise HTTPException(400, "json_schema scoring needs scoring_config.schema")
    found = await pool.fetchval(
        "select count(*) from models where id = any($1) and active and (org_id is null or org_id = $2)",
        cfg.model_ids, org_id,
    )
    if found != len(set(cfg.model_ids)):
        raise HTTPException(400, "unknown or inactive model id")

    datasets, inputs = [], []
    for pos, ref in enumerate(cfg.datasets):
        ds = await pool.fetchrow(
            "select id, name, filename, columns from datasets where id = $1 and org_id = $2", ref.dataset_id, org_id
        )
        if not ds:
            raise HTTPException(404, f"dataset {ref.dataset_id} not found (deleted?)")
        cols = set(ds["columns"])
        # Unmapped variables default to a same-named column.
        mapping = {v: ref.mapping.get(v) or v for v in variables}
        missing = [f"{{{{{v}}}}} → {c}" for v, c in mapping.items() if c not in cols]
        if missing:
            raise HTTPException(400, f"{ds['filename']}: no column for {', '.join(missing)}")
        if ref.expected_column and ref.expected_column not in cols:
            raise HTTPException(400, f"{ds['filename']}: no column {ref.expected_column!r}")
        if cfg.scoring_method in NEEDS_EXPECTED and not ref.expected_column:
            raise HTTPException(400, f"{ds['filename']}: {cfg.scoring_method} scoring needs an expected column")
        datasets.append((pos, ds["id"], ds["name"], ds["filename"], mapping, ref.expected_column))
        if not render:
            continue
        rows = await pool.fetch("select idx, data from dataset_rows where dataset_id = $1 order by idx", ds["id"])
        for r in rows:
            values = {v: r["data"].get(c, "") for v, c in mapping.items()}
            expected = r["data"].get(ref.expected_column) if ref.expected_column else None
            inputs.append((pos, r["idx"], values, templates.render(cfg.template, values), expected))
        if len(inputs) > MAX_INPUTS:
            raise HTTPException(400, f"too many inputs ({len(inputs)}+); the limit is {MAX_INPUTS}")
    if render and not inputs:
        raise HTTPException(400, "the selected datasets have no rows")
    return Prepared(datasets=datasets, inputs=inputs)


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "run"


def output_name(requested: str | None, label: str) -> str:
    if requested and requested.strip():
        base = re.sub(r"\s+", "-", re.sub(r"[^\w.\- ]+", "", requested.strip()).strip()) or "predictions"
    else:
        base = f"{_slug(label)}-{datetime.now(timezone.utc):%Y%m%d-%H%M}-predictions"
    return base if base.lower().endswith(".csv") else f"{base}.csv"


async def create_run(
    org_id: int, user_id: int, cfg: RunConfig, *, name: str | None = None, output: str | None = None,
    profile_id: int | None = None, profile_version: int | None = None, label: str | None = None,
) -> int:
    prepared = await prepare(org_id, cfg)
    async with db.pool().acquire() as conn, conn.transaction():
        run_id = await conn.fetchval(
            """insert into runs (org_id, name, prompt_name, system_prompt, template, scoring_method, scoring_config,
                   params, total_inputs, output_name, created_by, profile_id, profile_version)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id""",
            org_id, (name or "").strip() or None, cfg.prompt_name, (cfg.system_prompt or "").strip() or None,
            cfg.template, cfg.scoring_method, cfg.scoring_config, cfg.params(), len(prepared.inputs),
            output_name(output, label or cfg.prompt_name), user_id, profile_id, profile_version,
        )
        await conn.executemany(
            """insert into run_datasets (run_id, position, dataset_id, dataset_name, filename, mapping, expected_column)
               values ($1, $2, $3, $4, $5, $6, $7)""",
            [(run_id, *d) for d in prepared.datasets],
        )
        await conn.executemany(
            """insert into run_inputs (run_id, dataset_position, row_idx, variables, prompt, expected)
               values ($1, $2, $3, $4, $5, $6)""",
            [(run_id, *i) for i in prepared.inputs],
        )
        await conn.executemany(
            "insert into run_models (run_id, model_id) values ($1, $2)", [(run_id, m) for m in set(cfg.model_ids)]
        )
    runner.start(run_id)
    return run_id
