from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile

from .. import auth, datasets, db

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

COLUMNS = """d.id, d.name, d.filename, d.format, d.columns, d.row_count, d.created_at,
    u.name as created_by,
    (select count(distinct run_id) from run_datasets rd where rd.dataset_id = d.id) as run_count"""


@router.post("")
async def upload(file: UploadFile, name: str | None = Form(None), ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Upload a CSV / JSONL / JSON file; every row is stored so runs can use it later."""
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
            """insert into datasets (org_id, name, filename, format, columns, row_count, created_by)
               values ($1, $2, $3, $4, $5, $6, $7) returning id""",
            ctx.org_id, (name or "").strip() or filename.rsplit(".", 1)[0], filename,
            "jsonl" if fmt == "ndjson" else fmt, list(columns), len(rows), ctx.user_id,
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
    sample = await pool.fetch(
        "select idx, data from dataset_rows where dataset_id = $1 order by idx limit $2 offset $3",
        dataset_id, min(limit, 500), offset,
    )
    return {**dict(row), "rows": [{"idx": r["idx"], **r["data"]} for r in sample]}


@router.delete("/{dataset_id}")
async def delete_dataset(dataset_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Past runs keep their rendered inputs and the file name; only the stored rows go."""
    await db.pool().execute("delete from datasets where id = $1 and org_id = $2", dataset_id, ctx.org_id)
    return {"ok": True}
