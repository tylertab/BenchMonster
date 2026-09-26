"""Organization provisioning: each org gets its own read-only SQL surface.

`org_<id>` holds one view per analytics view, filtered to the org (with org_id
dropped), and `org_<id>_reader` is a login role that can read only that schema.
Re-running `provision_reader` is idempotent and refreshes the views, so it runs
on org creation and on every migrate.
"""

import secrets

import asyncpg

# Global rows (org_id null) are visible to every org for these views.
SHARED_VIEWS = {"models"}


def schema_name(org_id: int) -> str:
    return f"org_{int(org_id)}"


def role_name(org_id: int) -> str:
    return f"org_{int(org_id)}_reader"


async def provision_reader(conn: asyncpg.Connection, org_id: int) -> None:
    org_id = int(org_id)
    schema, role = schema_name(org_id), role_name(org_id)
    password = await conn.fetchval("select reader_password from organizations where id = $1", org_id)
    if not password:
        password = secrets.token_urlsafe(24)
        await conn.execute("update organizations set reader_password = $2 where id = $1", org_id, password)
    quoted_pw = await conn.fetchval("select quote_literal($1)", password)

    async with conn.transaction():
        exists = await conn.fetchval("select 1 from pg_roles where rolname = $1", role)
        verb = "alter" if exists else "create"
        await conn.execute(f'{verb} role "{role}" login password {quoted_pw}')
        await conn.execute(f'alter role "{role}" set search_path = "{schema}"')
        await conn.execute(f"alter role \"{role}\" set statement_timeout = '5s'")
        await conn.execute(f'alter role "{role}" set default_transaction_read_only = on')

        await conn.execute(f'create schema if not exists "{schema}"')
        views = await conn.fetch(
            """select table_name, array_agg(column_name::text order by ordinal_position) as cols
               from information_schema.columns
               where table_schema = 'analytics'
               group by table_name"""
        )
        for v in views:
            name = v["table_name"]
            cols = ", ".join(f'"{c}"' for c in v["cols"] if c != "org_id")
            where = f"org_id = {org_id}" + (" or org_id is null" if name in SHARED_VIEWS else "")
            await conn.execute(f'drop view if exists "{schema}"."{name}"')
            await conn.execute(
                f'create view "{schema}"."{name}" as select {cols} from analytics."{name}" where {where}'
            )
        await conn.execute(f'grant usage on schema "{schema}" to "{role}"')
        await conn.execute(f'grant select on all tables in schema "{schema}" to "{role}"')


async def create_org(conn: asyncpg.Connection, name: str, owner_user_id: int) -> int:
    org_id = await conn.fetchval("insert into organizations (name) values ($1) returning id", name)
    await conn.execute(
        "insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", org_id, owner_user_id
    )
    await provision_reader(conn, org_id)
    return org_id
