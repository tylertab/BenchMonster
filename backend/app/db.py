import json

import asyncpg

from .config import settings

_pool: asyncpg.Pool | None = None


async def init_conn(conn: asyncpg.Connection) -> None:
    # Decode json/jsonb columns to Python objects instead of strings.
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def connect() -> None:
    global _pool
    _pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=10, init=init_conn)


async def disconnect() -> None:
    if _pool is not None:
        await _pool.close()


def pool() -> asyncpg.Pool:
    assert _pool is not None, "database not connected"
    return _pool
