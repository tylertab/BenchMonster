"""Run user (or assistant) SQL against the analytics views as `bench_reader`.

Defense in depth: the role can only SELECT from analytics.* and has a 5s
statement_timeout; here we also force a READ ONLY transaction that is always
rolled back (so a user's SET can't leak into the pooled connection), and we
use the extended protocol, which rejects multi-statement strings.
"""

import time

import asyncpg

from . import db

MAX_ROWS = 1000


class QueryError(Exception):
    pass


async def run(sql: str, max_rows: int = MAX_ROWS) -> dict:
    sql = sql.strip().rstrip(";")
    if not sql:
        raise QueryError("empty query")
    start = time.perf_counter()
    async with db.readonly_pool().acquire() as conn:
        tr = conn.transaction(readonly=True)
        await tr.start()
        try:
            await conn.execute("set local statement_timeout = '5s'")
            stmt = await conn.prepare(sql)
            columns = [{"name": a.name, "type": a.type.name} for a in stmt.get_attributes()]
            rows = await stmt.fetch() if not columns else [r async for r in _limited(stmt, max_rows + 1)]
        except asyncpg.PostgresError as e:
            raise QueryError(f"{type(e).__name__}: {e}") from e
        finally:
            await tr.rollback()
    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    return {
        "columns": columns,
        "rows": [list(r.values()) for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
        "elapsed_ms": round((time.perf_counter() - start) * 1000, 1),
    }


async def _limited(stmt, n: int):
    count = 0
    async for r in stmt.cursor():
        yield r
        count += 1
        if count >= n:
            break


async def schema() -> list[dict]:
    """Views and columns visible to the console, for the UI sidebar and the assistant."""
    rows = await db.readonly_pool().fetch(
        """select table_name, column_name, data_type
           from information_schema.columns
           where table_schema = 'analytics'
           order by table_name, ordinal_position"""
    )
    tables: dict[str, list] = {}
    for r in rows:
        tables.setdefault(r["table_name"], []).append({"name": r["column_name"], "type": r["data_type"]})
    return [{"name": t, "columns": cols} for t, cols in tables.items()]


def schema_as_text(tables: list[dict]) -> str:
    return "\n".join(
        f"analytics.{t['name']}({', '.join(c['name'] + ' ' + c['type'] for c in t['columns'])})" for t in tables
    )
