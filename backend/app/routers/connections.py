"""Connections to an org's object storage and databases. Owners manage them; everyone
in the org can browse them and import datasets."""

from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from .. import auth, db, linked
from .. import selection as sel_lib
from .. import connections as conns

router = APIRouter(prefix="/api/connections", tags=["connections"])

COLUMNS = """c.id, c.name, c.kind, c.provider, c.config, c.allow_write, c.access, c.created_at, c.updated_at,
    u.name as created_by,
    (select count(*) from datasets d where d.org_id = c.org_id and (d.source->>'connection_id')::int = c.id) as dataset_count"""


def _out(row) -> dict:
    out = dict(row)
    out["config"] = conns.public_config(row["kind"], row["config"])
    return out


async def _get(connection_id: int, org_id: int) -> dict:
    row = await db.pool().fetchrow(
        f"select {COLUMNS} from connections c left join users u on u.id = c.created_by where c.id = $1 and c.org_id = $2",
        connection_id, org_id,
    )
    if not row:
        raise HTTPException(404, "connection not found")
    return _out(row)


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["s3", "postgres"]
    provider: Literal["vultr", "tiger", "aws", "other"] = "other"
    config: dict
    secret: dict | None = None  # omitted on update = keep the saved credentials
    allow_write: bool = False

    @model_validator(mode="after")
    def _valid(self):
        conns.parse_config(self.kind, self.config, self.secret)  # raises on bad shape
        return self


@router.get("")
async def list_connections(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        f"select {COLUMNS} from connections c left join users u on u.id = c.created_by where c.org_id = $1 order by lower(c.name)",
        ctx.org_id,
    )
    return [_out(r) for r in rows]


@router.post("/test")
async def test_connection(body: ConnectionIn, ctx: auth.Ctx = Depends(auth.require_owner)):
    """Check access with unsaved settings (the form's Test button)."""
    if body.secret is None:
        raise HTTPException(400, "enter the credentials to test")
    return await conns.check(body.kind, body.config, body.secret, body.allow_write)


@router.post("")
async def create_connection(body: ConnectionIn, ctx: auth.Ctx = Depends(auth.require_owner)):
    if body.secret is None:
        raise HTTPException(400, "enter the credentials")
    access = await conns.check(body.kind, body.config, body.secret, body.allow_write)
    try:
        connection_id = await db.pool().fetchval(
            """insert into connections (org_id, name, kind, provider, config, secret, allow_write, access, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id""",
            ctx.org_id, body.name.strip(), body.kind, body.provider, body.config, conns.encrypt(body.secret),
            body.allow_write, access, ctx.user_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, f"a connection named {body.name.strip()!r} already exists")
    return await _get(connection_id, ctx.org_id)


@router.put("/{connection_id}")
async def update_connection(connection_id: int, body: ConnectionIn, ctx: auth.Ctx = Depends(auth.require_owner)):
    row = await db.pool().fetchrow("select kind, secret from connections where id = $1 and org_id = $2", connection_id, ctx.org_id)
    if not row:
        raise HTTPException(404, "connection not found")
    if body.kind != row["kind"]:
        raise HTTPException(400, "a connection's type can't change; create a new one")
    secret = body.secret if body.secret is not None else conns.decrypt(row["secret"])
    access = await conns.check(body.kind, body.config, secret, body.allow_write)
    try:
        await db.pool().execute(
            """update connections set name = $3, provider = $4, config = $5, secret = $6, allow_write = $7, access = $8,
                   updated_at = now() where id = $1 and org_id = $2""",
            connection_id, ctx.org_id, body.name.strip(), body.provider, body.config, conns.encrypt(secret),
            body.allow_write, access,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, f"a connection named {body.name.strip()!r} already exists")
    return await _get(connection_id, ctx.org_id)


@router.post("/{connection_id}/check")
async def recheck(connection_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    conn, cfg, sec = await linked.load_connection(ctx.org_id, connection_id)
    access = await conns.check(conn["kind"], conn["config"], conns.decrypt(conn["secret"]), conn["allow_write"])
    await db.pool().execute("update connections set access = $2 where id = $1", connection_id, access)
    return await _get(connection_id, ctx.org_id)


@router.delete("/{connection_id}")
async def delete_connection(connection_id: int, ctx: auth.Ctx = Depends(auth.require_owner)):
    """Imported datasets keep their rows; they just can't be refreshed any more."""
    status = await db.pool().execute("delete from connections where id = $1 and org_id = $2", connection_id, ctx.org_id)
    if status == "DELETE 0":
        raise HTTPException(404, "connection not found")
    return {"ok": True}


@router.get("/{connection_id}/browse")
async def browse(connection_id: int, folder: str = "", ctx: auth.Ctx = Depends(auth.current_ctx)):
    conn, cfg, sec = await linked.load_connection(ctx.org_id, connection_id)
    if conn["kind"] != "s3":
        raise HTTPException(400, "browse is for object storage; use tables for databases")
    return await conns.s3_browse(cfg, sec, folder)


@router.get("/{connection_id}/tables")
async def tables(connection_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    conn, cfg, sec = await linked.load_connection(ctx.org_id, connection_id)
    if conn["kind"] != "postgres":
        raise HTTPException(400, "tables are for databases; use browse for object storage")
    return await conns.pg_tables(cfg, sec)


@router.get("/{connection_id}/table")
async def table_info(connection_id: int, name: str, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Columns (with types), primary key and approximate size of one table."""
    conn, cfg, sec = await linked.load_connection(ctx.org_id, connection_id)
    if conn["kind"] != "postgres":
        raise HTTPException(400, "tables are for databases")
    return await conns.pg_table_info(cfg, sec, name)


class StreamPreviewIn(BaseModel):
    table: str = Field(min_length=1, max_length=300)
    key: str = Field(min_length=1, max_length=200)
    selection: sel_lib.Selection = sel_lib.Selection()


@router.post("/{connection_id}/select")
async def preview_stream(connection_id: int, body: StreamPreviewIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """How many rows of a table a record selection reads, plus the first few (for a streamed record source)."""
    conn, cfg, sec = await linked.load_connection(ctx.org_id, connection_id)
    if conn["kind"] != "postgres":
        raise HTTPException(400, "tables are for databases")
    info = await conns.pg_table_info(cfg, sec, body.table)
    sel_lib.validate(body.selection, [c["name"] for c in info["columns"]], body.table)
    spec = conns.StreamSpec(table=body.table, key=body.key, rules=body.selection.rules, match=body.selection.match,
                            dedupe_on=body.selection.dedupe_on, pick=body.selection.pick, n=body.selection.n,
                            seed=body.selection.seed)
    out = await conns.pg_stream_preview(cfg, sec, spec)
    return {**out, "description": body.selection.describe(),
            "rows": [{"idx": i, **r} for i, r in enumerate(out["rows"])]}


class ImportIn(BaseModel):
    path: str | None = Field(None, max_length=1000)  # object storage: file path
    table: str | None = Field(None, max_length=300)  # database: schema.table
    query: str | None = Field(None, max_length=20000)  # database: a read-only SELECT
    rules: list[sel_lib.Rule] = Field([], max_length=20)  # database table: filters applied in SQL
    match: Literal["all", "any"] = "all"
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=5000)
    auto_refresh: bool = False  # re-read the source before every run


@router.post("/{connection_id}/import")
async def import_dataset(connection_id: int, body: ImportIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    conn, _, _ = await linked.load_connection(ctx.org_id, connection_id)
    if conn["kind"] == "s3":
        if not body.path:
            raise HTTPException(400, "choose a file")
        source = {"connection_id": connection_id, "path": body.path}
    else:
        if bool(body.table) == bool((body.query or "").strip()):
            raise HTTPException(400, "choose a table, or write a query")
        source = {"connection_id": connection_id, **({"table": body.table} if body.table else {"query": body.query.strip()})}
        if body.table and body.rules:
            source |= {"rules": [r.model_dump() for r in body.rules], "match": body.match}
    source["auto_refresh"] = body.auto_refresh
    dataset_id = await linked.import_dataset(ctx.org_id, ctx.user_id, source, body.name, body.description)
    return {"id": dataset_id}
