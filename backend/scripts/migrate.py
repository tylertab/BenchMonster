"""Apply pending SQL migrations in backend/migrations, in filename order.

Also gives the read-only `bench_reader` role a login password taken from
READONLY_DATABASE_URL, so the SQL console can connect as it.
"""

import asyncio
import sys
from pathlib import Path
from urllib.parse import urlparse

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


async def main() -> None:
    conn = await asyncpg.connect(settings.database_url)
    try:
        await conn.execute(
            "create table if not exists schema_migrations"
            " (name text primary key, applied_at timestamptz not null default now())"
        )
        applied = {r["name"] for r in await conn.fetch("select name from schema_migrations")}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name in applied:
                continue
            print(f"applying {path.name}")
            async with conn.transaction():
                await conn.execute(path.read_text())
                await conn.execute("insert into schema_migrations (name) values ($1)", path.name)

        if settings.readonly_database_url:
            ro = urlparse(settings.readonly_database_url)
            # ALTER ROLE can't take bind parameters; quote the literal server-side.
            pw = await conn.fetchval("select quote_literal($1)", ro.password)
            await conn.execute(f'alter role "{ro.username}" login password {pw}')
            print(f"role {ro.username}: login enabled")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
