"""Apply pending SQL migrations in backend/migrations, in filename order.

Then (re)provision every organization's read-only schema + role, so org views
pick up any analytics view changes from the migrations just applied.
"""

import asyncio
import sys
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import orgs  # noqa: E402
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

        org_ids = [r["id"] for r in await conn.fetch("select id from organizations order by id")]
        for org_id in org_ids:
            await orgs.provision_reader(conn, org_id)
        print(f"provisioned readers for {len(org_ids)} org(s)")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
