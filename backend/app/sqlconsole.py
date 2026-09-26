"""Run user (or assistant) SQL as the org's own reader role.

Each org connects as `org_<id>_reader`, which can only read the `org_<id>`
views (pre-filtered to that org) and has a 5s statement_timeout. On top of
that we force a READ ONLY transaction that is always rolled back (so a user's
SET can't leak into the pooled connection), and use the extended protocol,
which rejects multi-statement strings.
"""

import asyncio
import time
from urllib.parse import urlparse

import asyncpg

from . import db, orgs
from .config import settings

MAX_ROWS = 1000
_pools: dict[int, asyncpg.Pool] = {}
_lock = asyncio.Lock()


class QueryError(Exception):
    pass


async def _org_pool(org_id: int) -> asyncpg.Pool:
    if org_id in _pools:
        return _pools[org_id]
    async with _lock:
        if org_id not in _pools:
            password = await db.pool().fetchval("select reader_password from organizations where id = $1", org_id)
            if not password:
                async with db.pool().acquire() as conn:
                    await orgs.provision_reader(conn, org_id)
                password = await db.pool().fetchval("select reader_password from organizations where id = $1", org_id)
            base = urlparse(settings.database_url)
            _pools[org_id] = await asyncpg.create_pool(
                host=base.hostname, port=base.port, database=base.path.lstrip("/"),
                user=orgs.role_name(org_id), password=password, ssl="require",
                min_size=0, max_size=3, init=db.init_conn,
            )
    return _pools[org_id]


async def close_pools() -> None:
    for p in _pools.values():
        await p.close()
    _pools.clear()


async def run(org_id: int, sql: str, max_rows: int = MAX_ROWS) -> dict:
    sql = sql.strip().rstrip(";")
    if not sql:
        raise QueryError("empty query")
    start = time.perf_counter()
    async with (await _org_pool(org_id)).acquire() as conn:
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


async def schema(org_id: int) -> list[dict]:
    """Views and columns visible to the org's console, for the UI and the assistant."""
    async with (await _org_pool(org_id)).acquire() as conn:
        rows = await conn.fetch(
            """select table_name, column_name, data_type
               from information_schema.columns
               where table_schema = current_schema()
               order by table_name, ordinal_position"""
        )
    tables: dict[str, list] = {}
    for r in rows:
        tables.setdefault(r["table_name"], []).append({"name": r["column_name"], "type": r["data_type"]})
    return [{"name": t, "columns": cols} for t, cols in tables.items()]


def schema_as_text(tables: list[dict]) -> str:
    return "\n".join(f"{t['name']}({', '.join(c['name'] + ' ' + c['type'] for c in t['columns'])})" for t in tables)
