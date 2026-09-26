"""A run configuration (what a benchmark profile version stores) and turning it into a run.

Validation renders every input up front, so a bad mapping or missing column
fails before anything is written or any model is called.
"""

import csv
import io
import json
import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from . import datasets as ds_lib
from . import db, runner, scoring, templates

MAX_INPUTS = 10_000
MAX_INLINE_CHARS = 200_000  # a whole dataset / fixed text inlined into the prompt
MAX_TOTAL_PROMPT_CHARS = 50_000_000  # inline values are repeated in every stored prompt
RECORD = "$record"  # mapping value: the whole record, as typed JSON
NEEDS_EXPECTED = {"exact", "contains", "numeric", "json_fields"}


class Binding(BaseModel):
    """A variable that doesn't vary per record: fixed text, or a whole dataset inlined."""

    type: Literal["text", "dataset"]
    value: str | None = Field(None, max_length=MAX_INLINE_CHARS)
    dataset_id: int | None = None
    format: Literal["json", "jsonl", "csv"] = "json"


class DatasetRef(BaseModel):
    """A record source: each row becomes one prompt; plus where its expected outputs come from."""

    dataset_id: int
    mapping: dict[str, str] = {}  # {template variable: input column, or "$record" for the whole row}
    # Expected outputs: a column of the input file, or (with expected_dataset_id) a
    # separate dataset matched by input_key <-> expected_key, or by row order if no
    # keys. With an expected dataset and no column, the whole row (minus the key) is
    # the expected value, as typed JSON.
    expected_column: str | None = None
    expected_dataset_id: int | None = None
    input_key: str | None = None
    expected_key: str | None = None


class RunConfig(BaseModel):
    prompt_name: str = Field(min_length=1, max_length=200)
    system_prompt: str | None = Field(None, max_length=20000)
    template: str = Field(min_length=1, max_length=50000)
    # Record sources. Empty = a single prompt per model (every variable bound below).
    datasets: list[DatasetRef] = Field([], max_length=20)
    # Variables not read from records: {variable: Binding}.
    bindings: dict[str, Binding] = {}
    # Expected output for a single-prompt run (no record sources).
    expected_text: str | None = Field(None, max_length=MAX_INLINE_CHARS)
    scoring_method: Literal[scoring.METHODS]  # type: ignore[valid-type]
    scoring_config: dict = {}
    model_ids: list[int] = Field(min_length=1)
    max_tokens: int = Field(4096, ge=16, le=32768)
    temperature: float = Field(0.0, ge=0, le=2)
    concurrency: int = Field(8, ge=1, le=32)
    # "realtime": one streaming request per input. "batch": batch_size inputs are
    # packed into one request that must return a JSON array of answers.
    mode: Literal["realtime", "batch"] = "realtime"
    batch_size: int = Field(10, ge=2, le=50)

    def bindings_json(self) -> dict:
        return {v: b.model_dump(exclude_none=True) for v, b in self.bindings.items()}

    def params(self) -> dict:
        return {"max_tokens": self.max_tokens, "temperature": self.temperature, "concurrency": self.concurrency,
                "mode": self.mode, "batch_size": self.batch_size}


class Prepared(BaseModel):
    """A validated config: datasets resolved and every input rendered."""

    # (position, dataset_id, name, filename, mapping, expected_column,
    #  expected_dataset_id, expected_filename, input_key, expected_key)
    datasets: list[tuple]
    inputs: list[tuple]  # (position, row_idx, variables, prompt, expected)


async def _rows(dataset_id: int):
    return await db.pool().fetch("select idx, data from dataset_rows where dataset_id = $1 order by idx", dataset_id)


def _schema_of(ds, rows) -> dict:
    return ds["schema"] if ds["schema"] is not None else ds_lib.infer_schema([r["data"] for r in rows], ds["columns"])


async def _resolve_bindings(org_id: int, bindings: dict[str, Binding]) -> tuple[dict[str, str], dict[str, str]]:
    """Values for non-record variables, plus short labels to store per input instead of big values."""
    values, labels = {}, {}
    for var, b in bindings.items():
        if b.type == "text":
            val = b.value or ""
            values[var] = val
            labels[var] = val if len(val) <= 300 else f"[fixed text, {len(val):,} chars]"
            continue
        if not b.dataset_id:
            raise HTTPException(400, f"{{{{{var}}}}}: choose the dataset to inline")
        ds = await db.pool().fetchrow(
            "select id, filename, columns, schema from datasets where id = $1 and org_id = $2", b.dataset_id, org_id
        )
        if not ds:
            raise HTTPException(404, f"{{{{{var}}}}}: dataset {b.dataset_id} not found (deleted?)")
        rows = await _rows(ds["id"])
        if b.format == "csv":
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=ds["columns"], extrasaction="ignore")
            w.writeheader()
            w.writerows(r["data"] for r in rows)
            val = buf.getvalue()
        else:
            schema = _schema_of(ds, rows)
            typed = [ds_lib.typed_row(r["data"], schema, order=ds["columns"]) for r in rows]
            val = json.dumps(typed, ensure_ascii=False, indent=2) if b.format == "json" else "\n".join(
                json.dumps(t, ensure_ascii=False) for t in typed
            )
        if len(val) > MAX_INLINE_CHARS:
            raise HTTPException(400, f"{{{{{var}}}}}: {ds['filename']} is {len(val):,} characters as {b.format}; the limit for inlining a whole dataset is {MAX_INLINE_CHARS:,}")
        values[var] = val
        labels[var] = f"[whole dataset {ds['filename']}, {len(rows)} rows, {b.format}]"
    return values, labels


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

    bindings = {v: b for v, b in cfg.bindings.items() if v in variables}
    constants, labels = await _resolve_bindings(org_id, bindings)
    record_vars = [v for v in variables if v not in bindings]
    if record_vars and not cfg.datasets:
        names = ", ".join(f"{{{{{v}}}}}" for v in record_vars)
        raise HTTPException(400, f"{names} read per-record data: add a record source, or give them fixed text or a whole dataset")
    if cfg.datasets and not record_vars:
        raise HTTPException(400, "no variable reads per-record data, so the record sources would only repeat the same prompt; remove them")

    if not cfg.datasets:  # single prompt per model
        if cfg.scoring_method in NEEDS_EXPECTED and not (cfg.expected_text or "").strip():
            raise HTTPException(400, f"{cfg.scoring_method} scoring needs an expected output")
        if not render:
            return Prepared(datasets=[], inputs=[])
        return Prepared(
            datasets=[(0, None, None, "(single prompt)", {}, None, None, None, None, None)],
            inputs=[(0, 0, labels, templates.render(cfg.template, constants), (cfg.expected_text or "").strip() or None)],
        )

    inline_chars = sum(len(v) for v in constants.values())
    datasets, inputs = [], []
    for pos, ref in enumerate(cfg.datasets):
        ds = await pool.fetchrow(
            "select id, name, filename, columns, schema from datasets where id = $1 and org_id = $2", ref.dataset_id, org_id
        )
        if not ds:
            raise HTTPException(404, f"dataset {ref.dataset_id} not found (deleted?)")
        cols = set(ds["columns"])
        # Unmapped variables default to a same-named column.
        mapping = {v: ref.mapping.get(v) or v for v in record_vars}
        missing = [f"{{{{{v}}}}} → {c}" for v, c in mapping.items() if c != RECORD and c not in cols]
        if missing:
            raise HTTPException(400, f"{ds['filename']}: no column for {', '.join(missing)}")
        exp = None
        if ref.expected_dataset_id:
            exp = await pool.fetchrow(
                "select id, filename, columns, schema from datasets where id = $1 and org_id = $2",
                ref.expected_dataset_id, org_id,
            )
            if not exp:
                raise HTTPException(404, f"expected-output dataset {ref.expected_dataset_id} not found (deleted?)")
            if ref.expected_column and ref.expected_column not in exp["columns"]:
                raise HTTPException(400, f"{exp['filename']}: no column {ref.expected_column!r}")
            if bool(ref.input_key) != bool(ref.expected_key):
                raise HTTPException(400, f"{ds['filename']}: set both key columns to match rows, or neither to match by row order")
            if ref.input_key and ref.input_key not in cols:
                raise HTTPException(400, f"{ds['filename']}: no key column {ref.input_key!r}")
            if ref.expected_key and ref.expected_key not in exp["columns"]:
                raise HTTPException(400, f"{exp['filename']}: no key column {ref.expected_key!r}")
        elif ref.expected_column and ref.expected_column not in cols:
            raise HTTPException(400, f"{ds['filename']}: no column {ref.expected_column!r}")
        if cfg.scoring_method in NEEDS_EXPECTED and not (ref.expected_column or exp):
            raise HTTPException(400, f"{ds['filename']}: {cfg.scoring_method} scoring needs expected outputs")
        datasets.append((pos, ds["id"], ds["name"], ds["filename"], mapping, ref.expected_column,
                         exp["id"] if exp else None, exp["filename"] if exp else None,
                         ref.input_key if exp else None, ref.expected_key if exp else None))
        if not render:
            continue
        rows = await _rows(ds["id"])
        schema = _schema_of(ds, rows) if RECORD in mapping.values() else None
        expected_for = _expected_lookup(ref, exp, await pool.fetch(
            "select idx, data from dataset_rows where dataset_id = $1 order by idx", exp["id"]
        ) if exp else None)
        unmatched = 0
        for i, r in enumerate(rows):
            values = {
                v: json.dumps(ds_lib.typed_row(r["data"], schema, order=ds["columns"]), ensure_ascii=False) if c == RECORD else r["data"].get(c, "")
                for v, c in mapping.items()
            }
            expected = expected_for(i, r["data"])
            if exp and expected is None:
                unmatched += 1
            inputs.append((pos, r["idx"], {**labels, **values}, templates.render(cfg.template, {**constants, **values}), expected))
        if unmatched and cfg.scoring_method in NEEDS_EXPECTED:
            how = f"{ref.input_key} = {ref.expected_key}" if ref.input_key else "row order"
            raise HTTPException(400, f"{ds['filename']}: {unmatched} input rows have no expected output in {exp['filename']} (matched by {how})")
        if len(inputs) > MAX_INPUTS:
            raise HTTPException(400, f"too many inputs ({len(inputs)}+); the limit is {MAX_INPUTS}")
        if inline_chars * len(inputs) > MAX_TOTAL_PROMPT_CHARS:
            raise HTTPException(400, f"inlined values ({inline_chars:,} chars) repeated across {len(inputs):,}+ prompts is too large; use fewer records or a smaller inlined dataset")
    if render and not inputs:
        raise HTTPException(400, "the selected datasets have no rows")
    return Prepared(datasets=datasets, inputs=inputs)


def _expected_lookup(ref: DatasetRef, exp, exp_rows):
    """(input position, input row) -> expected value string, or None if unmatched."""
    if not exp:
        return lambda i, row: (row.get(ref.expected_column) if ref.expected_column else None)
    schema = exp["schema"]
    if schema is None:
        schema = ds_lib.infer_schema([r["data"] for r in exp_rows], exp["columns"])

    def value(er: dict) -> str:
        if ref.expected_column:
            return er.get(ref.expected_column, "")
        return json.dumps(ds_lib.typed_row(er, schema, drop=(ref.expected_key,) if ref.expected_key else (), order=exp["columns"]))

    if ref.input_key:
        by_key: dict[str, dict] = {}
        for r in exp_rows:
            by_key.setdefault(str(r["data"].get(ref.expected_key, "")).strip(), r["data"])

        def lookup(i, row):
            er = by_key.get(str(row.get(ref.input_key, "")).strip())
            return value(er) if er is not None else None
        return lookup

    ordered = [r["data"] for r in exp_rows]
    return lambda i, row: value(ordered[i]) if i < len(ordered) else None


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
                   params, total_inputs, output_name, created_by, profile_id, profile_version, bindings, expected_text)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id""",
            org_id, (name or "").strip() or None, cfg.prompt_name, (cfg.system_prompt or "").strip() or None,
            cfg.template, cfg.scoring_method, cfg.scoring_config, cfg.params(), len(prepared.inputs),
            output_name(output, label or cfg.prompt_name), user_id, profile_id, profile_version,
            cfg.bindings_json(), (cfg.expected_text or "").strip() or None,
        )
        await conn.executemany(
            """insert into run_datasets (run_id, position, dataset_id, dataset_name, filename, mapping, expected_column,
                   expected_dataset_id, expected_filename, input_key, expected_key)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)""",
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


async def with_filenames(bindings: dict | None) -> dict:
    """Bindings for display: whole-dataset bindings gain their dataset's filename."""
    bindings = dict(bindings or {})
    ids = [b["dataset_id"] for b in bindings.values() if b.get("type") == "dataset" and b.get("dataset_id")]
    if ids:
        names = {r["id"]: r["filename"] for r in await db.pool().fetch("select id, filename from datasets where id = any($1)", ids)}
        bindings = {k: {**b, "filename": names.get(b.get("dataset_id"))} if b.get("type") == "dataset" else b for k, b in bindings.items()}
    return bindings

