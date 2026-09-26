import jsonschema
from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .. import auth, datasets, db

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

COLUMNS = """d.id, d.name, d.filename, d.format, d.columns, d.row_count, d.created_at, d.description,
    d.schema, u.name as created_by,
    (select count(distinct run_id) from run_datasets rd where rd.dataset_id = d.id) as run_count,
    (select count(distinct run_id) from run_datasets rd where rd.expected_dataset_id = d.id) as expected_run_count"""


@router.post("")
async def upload(file: UploadFile, name: str | None = Form(None), description: str | None = Form(None),
                 ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Upload a CSV / JSONL / JSON file; every row is stored, and a row schema is inferred."""
    filename = (file.filename or "dataset").strip()
    try:
        rows = datasets.parse(filename, await file.read())
    except (datasets.DatasetError, ValueError) as e:
        raise HTTPException(400, str(e))
    # Columns = union of keys in first-seen order (JSON rows may differ).
    columns: dict[str, None] = {}
    for r in rows:
        for k in r:
            columns.setdefault(k)
    fmt = filename.rsplit(".", 1)[-1].lower()
    async with db.pool().acquire() as conn, conn.transaction():
        dataset_id = await conn.fetchval(
            """insert into datasets (org_id, name, filename, format, columns, row_count, description, schema, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id""",
            ctx.org_id, (name or "").strip() or filename.rsplit(".", 1)[0], filename,
            "jsonl" if fmt == "ndjson" else fmt, list(columns), len(rows), (description or "").strip() or None,
            datasets.infer_schema(rows, list(columns)), ctx.user_id,
        )
        await conn.executemany(
            "insert into dataset_rows (dataset_id, idx, data) values ($1, $2, $3)",
            [(dataset_id, i, r) for i, r in enumerate(rows)],
        )
    return await get_dataset(dataset_id, ctx=ctx)


@router.get("")
async def list_datasets(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        f"""select {COLUMNS} from datasets d left join users u on u.id = d.created_by
            where d.org_id = $1 order by d.created_at desc""",
        ctx.org_id,
    )
    return [dict(r) for r in rows]


async def _row_data(dataset_id: int) -> list[tuple[int, dict]]:
    rows = await db.pool().fetch("select idx, data from dataset_rows where dataset_id = $1 order by idx", dataset_id)
    return [(r["idx"], r["data"]) for r in rows]


@router.get("/{dataset_id}")
async def get_dataset(dataset_id: int, limit: int = 20, offset: int = 0, ctx: auth.Ctx = Depends(auth.current_ctx)):
    pool = db.pool()
    row = await pool.fetchrow(
        f"""select {COLUMNS} from datasets d left join users u on u.id = d.created_by
            where d.id = $1 and d.org_id = $2""",
        dataset_id, ctx.org_id,
    )
    if not row:
        raise HTTPException(404, "dataset not found")
    out = dict(row)
    if out["schema"] is None:  # uploaded before schemas existed: infer once and keep
        out["schema"] = datasets.infer_schema([d for _, d in await _row_data(dataset_id)], out["columns"])
        await pool.execute("update datasets set schema = $2 where id = $1", dataset_id, out["schema"])
    sample = await pool.fetch(
        "select idx, data from dataset_rows where dataset_id = $1 order by idx limit $2 offset $3",
        dataset_id, min(limit, 500), offset,
    )
    return {**out, "rows": [{"idx": r["idx"], **r["data"]} for r in sample]}


class DatasetMetaIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(None, max_length=5000)
    schema_: dict | None = Field(None, alias="schema")


def _check_schema(schema: dict) -> None:
    try:
        jsonschema.Draft202012Validator.check_schema(schema)
    except jsonschema.SchemaError as e:
        raise HTTPException(400, f"invalid JSON schema: {e.message}")


@router.patch("/{dataset_id}")
async def update_dataset(dataset_id: int, body: DatasetMetaIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Rename, describe, or set the row schema (rows themselves are immutable)."""
    if body.schema_ is not None:
        _check_schema(body.schema_)
    status = await db.pool().execute(
        """update datasets set name = $3, description = $4, schema = coalesce($5, schema)
           where id = $1 and org_id = $2""",
        dataset_id, ctx.org_id, body.name.strip(), (body.description or "").strip() or None, body.schema_,
    )
    if status == "UPDATE 0":
        raise HTTPException(404, "dataset not found")
    return await get_dataset(dataset_id, ctx=ctx)


class ValidateIn(BaseModel):
    schema_: dict | None = Field(None, alias="schema")


@router.post("/{dataset_id}/validate")
async def validate(dataset_id: int, body: ValidateIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Check every row against a schema (the posted one, or the saved one)."""
    ds = await db.pool().fetchrow(
        "select schema, columns from datasets where id = $1 and org_id = $2", dataset_id, ctx.org_id
    )
    if not ds:
        raise HTTPException(404, "dataset not found")
    rows = await _row_data(dataset_id)
    schema = body.schema_ or ds["schema"] or datasets.infer_schema([d for _, d in rows], ds["columns"])
    _check_schema(schema)
    return datasets.validate_rows(rows, schema)


@router.get("/{dataset_id}/infer-schema")
async def infer(dataset_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """A freshly inferred schema from all rows (not saved)."""
    ds = await db.pool().fetchrow("select columns from datasets where id = $1 and org_id = $2", dataset_id, ctx.org_id)
    if not ds:
        raise HTTPException(404, "dataset not found")
    return datasets.infer_schema([d for _, d in await _row_data(dataset_id)], ds["columns"])


@router.delete("/{dataset_id}")
async def delete_dataset(dataset_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Past runs keep their inputs, expected values, and results; only the stored rows go."""
    await db.pool().execute("delete from datasets where id = $1 and org_id = $2", dataset_id, ctx.org_id)
    return {"ok": True}
