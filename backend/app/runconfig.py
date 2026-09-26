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
from . import connections as conns
from . import db, linked, runner, scoring, templates
from . import fields as field_lib
from . import selection as sel

MAX_INPUTS = 10_000
MAX_STREAMED_INPUTS = 1_000_000  # records per run read from a connection's table
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


class LinkedSource(BaseModel):
    """A table read straight from a Postgres connection, in `key` order, during the run."""

    connection_id: int
    table: str = Field(min_length=1, max_length=300)
    key: str = Field(min_length=1, max_length=200)  # unique column the run pages through


class DatasetRef(BaseModel):
    """A record source: each row becomes one prompt; plus where its expected outputs come from.

    Either an uploaded/imported dataset (dataset_id) or a connection's table (source).
    """

    dataset_id: int | None = None
    source: LinkedSource | None = None
    # Which columns reach the prompt and how they're parsed. None = every column, parsed automatically.
    fields: list[field_lib.FieldSpec] | None = Field(None, max_length=200)
    mapping: dict[str, str] = {}  # {template variable: input column, or "$record" for the whole row}
    # Expected outputs: a column of the input file, or (with expected_dataset_id) a
    # separate dataset matched by input_key <-> expected_key, or by row order if no
    # keys. With an expected dataset and no column, the whole row (minus the key) is
    # the expected value, as typed JSON.
    expected_column: str | None = None
    expected_dataset_id: int | None = None
    input_key: str | None = None
    expected_key: str | None = None
    # Which records to use (filters, dedupe, first/random N). Default: all of them.
    selection: sel.Selection = sel.Selection()


class RunConfig(BaseModel):
    prompt_name: str = Field(min_length=1, max_length=200)
    # The library prompt version this text came from (provenance only; the text below is what runs).
    prompt_id: int | None = None
    prompt_version: int | None = None
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

    def all_variables(self) -> list[str]:
        """Variables of the template, then any only in the system prompt."""
        return list(dict.fromkeys([*templates.variables(self.template), *templates.variables(self.system_prompt or "")]))

    def bindings_json(self) -> dict:
        return {v: b.model_dump(exclude_none=True) for v, b in self.bindings.items()}

    def params(self) -> dict:
        return {"max_tokens": self.max_tokens, "temperature": self.temperature, "concurrency": self.concurrency,
                "mode": self.mode, "batch_size": self.batch_size}


class Prepared(BaseModel):
    """A validated config: datasets resolved and every input rendered (unless streamed)."""

    # (position, dataset_id, name, filename, mapping, expected_column, expected_dataset_id,
    #  expected_filename, input_key, expected_key, selection, source, fields)
    datasets: list[tuple]
    inputs: list[tuple]  # (position, row_idx, variables, prompt, expected)
    system_message: str | None = None  # the system prompt with its variables filled in
    streamed: bool = False  # the record source is a connection's table, read during the run


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

    system_vars = templates.variables(cfg.system_prompt or "")
    per_record = [v for v in system_vars if v not in cfg.bindings]
    if per_record:
        names = ", ".join(f"{{{{{v}}}}}" for v in per_record)
        raise HTTPException(400, f"{names} is in the system prompt, which is the same for every record: make it a Value or a Dataset")
    bindings = {v: b for v, b in cfg.bindings.items() if v in variables or v in system_vars}
    constants, labels = await _resolve_bindings(org_id, bindings)
    system_message = (cfg.system_prompt or "").strip() or None
    if system_message and system_vars:
        system_message = templates.render(system_message, constants)
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
            return Prepared(datasets=[], inputs=[], system_message=system_message)
        return Prepared(
            system_message=system_message,
            datasets=[(0, None, None, "(single prompt)", {}, None, None, None, None, None, {}, None, None)],
            inputs=[(0, 0, labels, templates.render(cfg.template, constants), (cfg.expected_text or "").strip() or None)],
        )

    inline_chars = sum(len(v) for v in constants.values())
    datasets, inputs = [], []
    for pos, ref in enumerate(cfg.datasets):
        if ref.source:
            datasets.append(await _prepare_linked(org_id, cfg, ref, record_vars, pos))
            continue
        if not ref.dataset_id:
            raise HTTPException(400, "each record source needs a dataset or a connection table")
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
        sel.validate(ref.selection, ds["columns"], ds["filename"])
        if cfg.scoring_method in NEEDS_EXPECTED and not (ref.expected_column or exp):
            raise HTTPException(400, f"{ds['filename']}: {cfg.scoring_method} scoring needs expected outputs")
        datasets.append((pos, ds["id"], ds["name"], ds["filename"], mapping, ref.expected_column,
                         exp["id"] if exp else None, exp["filename"] if exp else None,
                         ref.input_key if exp else None, ref.expected_key if exp else None,
                         {} if ref.selection.is_default() else ref.selection.model_dump(exclude_defaults=True),
                         None, _fields_json(ref.fields)))
        field_lib.validate(ref.fields, ds["columns"], ds["filename"])
        if not render:
            continue
        rows = await _rows(ds["id"])
        schema = _schema_of(ds, rows) if RECORD in mapping.values() or ref.fields is not None else None
        renderer = field_lib.RowRenderer(ref.fields, ds["columns"], schema) if ref.fields is not None else None
        expected_for = _expected_lookup(ref, exp, await pool.fetch(
            "select idx, data from dataset_rows where dataset_id = $1 order by idx", exp["id"]
        ) if exp else None)
        picked, stats = sel.apply(rows, ref.selection)
        if not picked:
            raise HTTPException(400, f"{ds['filename']}: the record filters match none of its {stats.total} records")
        unmatched = 0
        for i, r in picked:
            if renderer:
                values = {v: renderer.record(r["data"]) if c == RECORD else renderer.value(r["data"], c) for v, c in mapping.items()}
            else:
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
    streamed = any(ref.source for ref in cfg.datasets)
    if render and not inputs and not streamed:
        raise HTTPException(400, "the selected datasets have no rows")
    return Prepared(datasets=datasets, inputs=inputs, streamed=streamed, system_message=system_message)


def _fields_json(specs: list[field_lib.FieldSpec] | None) -> list | None:
    return None if specs is None else [f.model_dump(exclude_none=True, exclude_defaults=True) for f in specs]


def stream_spec(source: dict, selection: dict | None) -> conns.StreamSpec:
    s = sel.Selection(**(selection or {}))
    return conns.StreamSpec(table=source["table"], key=source["key"], rules=s.rules, match=s.match,
                            dedupe_on=s.dedupe_on, pick=s.pick, n=s.n, seed=s.seed)


async def _prepare_linked(org_id: int, cfg: RunConfig, ref: DatasetRef, record_vars: list[str], pos: int) -> tuple:
    """Validate a connection-table record source against the table's columns (rows are read at run time)."""
    label = ref.source.table
    if len(cfg.datasets) > 1:
        raise HTTPException(400, "a database table must be the only record source")
    if ref.expected_dataset_id:
        raise HTTPException(400, f"{label}: expected outputs from a database table come from one of its columns")
    conn, pcfg, psec = await linked.load_connection(org_id, ref.source.connection_id)
    if conn["kind"] != "postgres":
        raise HTTPException(400, f"{conn['name']} isn't a database; import a file from it as a dataset instead")
    info = await conns.pg_table_info(pcfg, psec, ref.source.table)
    types = {c["name"]: c["type"] for c in info["columns"]}
    cols = list(types)
    if ref.source.key not in types:
        raise HTTPException(400, f"{label}: no key column {ref.source.key!r}")
    if types[ref.source.key] not in conns.KEY_TYPES:
        raise HTTPException(400, f"{label}: key column {ref.source.key} is {types[ref.source.key]}; choose an integer, text, uuid, date or timestamp column")
    mapping = {v: ref.mapping.get(v) or v for v in record_vars}
    missing = [f"{{{{{v}}}}} → {c}" for v, c in mapping.items() if c != RECORD and c not in types]
    if missing:
        raise HTTPException(400, f"{label}: no column for {', '.join(missing)}")
    if ref.expected_column and ref.expected_column not in types:
        raise HTTPException(400, f"{label}: no column {ref.expected_column!r}")
    if cfg.scoring_method in NEEDS_EXPECTED and not ref.expected_column:
        raise HTTPException(400, f"{label}: {cfg.scoring_method} scoring needs an expected-output column")
    field_lib.validate(ref.fields, cols, label)
    sel.validate(ref.selection, cols, label)
    return (pos, None, conn["name"], ref.source.table, mapping, ref.expected_column, None, None, None, None,
            {} if ref.selection.is_default() else ref.selection.model_dump(exclude_defaults=True),
            ref.source.model_dump(), _fields_json(ref.fields))


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


async def prompt_link(org_id: int, cfg: RunConfig) -> tuple[int | None, int | None]:
    """(prompt_id, prompt_version) if that library version exists in the org, else (None, None)."""
    if not cfg.prompt_id or not cfg.prompt_version:
        return None, None
    ok = await db.pool().fetchval(
        """select 1 from prompt_versions v join prompts p on p.id = v.prompt_id
           where p.id = $1 and p.org_id = $2 and v.version = $3""",
        cfg.prompt_id, org_id, cfg.prompt_version,
    )
    return (cfg.prompt_id, cfg.prompt_version) if ok else (None, None)


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
    await linked.refresh_for_run(org_id, {
        *(r.dataset_id for r in cfg.datasets if r.dataset_id), *(r.expected_dataset_id for r in cfg.datasets if r.expected_dataset_id),
        *(b.dataset_id for b in cfg.bindings.values() if b.type == "dataset" and b.dataset_id),
    })
    prepared = await prepare(org_id, cfg)
    total, stream_state = len(prepared.inputs), None
    if prepared.streamed:
        # Count what the run will read, and bound it by the current highest key.
        ref = cfg.datasets[0]
        _, pcfg, psec = await linked.load_connection(org_id, ref.source.connection_id)
        plan = await conns.pg_stream_plan(pcfg, psec, stream_spec(ref.source.model_dump(), ref.selection.model_dump()))
        if not plan["selected"]:
            raise HTTPException(400, f"{ref.source.table}: no rows match the record selection")
        if plan["selected"] > MAX_STREAMED_INPUTS:
            raise HTTPException(400, f"{ref.source.table}: {plan['selected']:,} records selected; the limit per run is {MAX_STREAMED_INPUTS:,}. Filter or sample fewer.")
        total, stream_state = plan["selected"], {"max_key": plan["max_key"], "last_key": None, "done": 0}
    async with db.pool().acquire() as conn, conn.transaction():
        run_id = await conn.fetchval(
            """insert into runs (org_id, name, prompt_name, system_prompt, template, scoring_method, scoring_config,
                   params, total_inputs, output_name, created_by, profile_id, profile_version, bindings, expected_text,
                   stream_state, system_message, prompt_id, prompt_version)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id""",
            org_id, (name or "").strip() or None, cfg.prompt_name, (cfg.system_prompt or "").strip() or None,
            cfg.template, cfg.scoring_method, cfg.scoring_config, cfg.params(), total,
            output_name(output, label or cfg.prompt_name), user_id, profile_id, profile_version,
            cfg.bindings_json(), (cfg.expected_text or "").strip() or None, stream_state, prepared.system_message,
            *(await prompt_link(org_id, cfg)),
        )
        await conn.executemany(
            """insert into run_datasets (run_id, position, dataset_id, dataset_name, filename, mapping, expected_column,
                   expected_dataset_id, expected_filename, input_key, expected_key, selection, source, fields)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)""",
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

