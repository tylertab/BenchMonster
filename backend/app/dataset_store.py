"""Storing dataset rows (from an upload or a connection import)."""

from . import datasets, db


def columns_of(rows: list[dict[str, str]]) -> list[str]:
    """Union of keys in first-seen order (JSON rows may differ)."""
    columns: dict[str, None] = {}
    for r in rows:
        for k in r:
            columns.setdefault(k)
    return list(columns)


async def create(org_id: int, user_id: int, *, name: str, filename: str, fmt: str, rows: list[dict[str, str]],
                 description: str | None = None, source: dict | None = None, columns: list[str] | None = None) -> int:
    columns = columns or columns_of(rows)
    async with db.pool().acquire() as conn, conn.transaction():
        dataset_id = await conn.fetchval(
            """insert into datasets (org_id, name, filename, format, columns, row_count, description, schema, created_by, source)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id""",
            org_id, name, filename, fmt, columns, len(rows), (description or "").strip() or None,
            datasets.infer_schema(rows, columns), user_id, source,
        )
        await conn.executemany(
            "insert into dataset_rows (dataset_id, idx, data) values ($1, $2, $3)",
            [(dataset_id, i, r) for i, r in enumerate(rows)],
        )
    return dataset_id


async def replace_rows(dataset_id: int, rows: list[dict[str, str]], source: dict, columns: list[str] | None = None) -> None:
    """New rows for a linked dataset. Past runs keep the prompts they rendered.

    The row schema is kept when the columns are unchanged (it may have been edited),
    and re-inferred otherwise.
    """
    columns = columns or columns_of(rows)
    async with db.pool().acquire() as conn, conn.transaction():
        old = await conn.fetchrow("select columns, schema from datasets where id = $1 for update", dataset_id)
        schema = old["schema"] if old["schema"] is not None and list(old["columns"]) == columns else datasets.infer_schema(rows, columns)
        await conn.execute("delete from dataset_rows where dataset_id = $1", dataset_id)
        await conn.executemany(
            "insert into dataset_rows (dataset_id, idx, data) values ($1, $2, $3)",
            [(dataset_id, i, r) for i, r in enumerate(rows)],
        )
        await conn.execute(
            "update datasets set columns = $2, row_count = $3, schema = $4, source = $5 where id = $1",
            dataset_id, columns, len(rows), schema, source,
        )
