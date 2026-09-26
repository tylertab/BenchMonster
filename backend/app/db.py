import json

import asyncpg

from .config import settings

_pool: asyncpg.Pool | None = None
_readonly_pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    # Decode json/jsonb columns to Python objects instead of strings.
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def connect() -> None:
    global _pool, _readonly_pool
    _pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=10, init=_init_conn)
    _readonly_pool = await asyncpg.create_pool(
        settings.readonly_database_url or settings.database_url, min_size=1, max_size=5, init=_init_conn
    )


async def disconnect() -> None:
    for p in (_pool, _readonly_pool):
        if p is not None:
            await p.close()


def pool() -> asyncpg.Pool:
    assert _pool is not None, "database not connected"
    return _pool


def readonly_pool() -> asyncpg.Pool:
    assert _readonly_pool is not None, "database not connected"
    return _readonly_pool
