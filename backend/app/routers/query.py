import csv
import io
import json
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import auth, db, linked, sqlconsole
from .. import connections as conns

router = APIRouter(prefix="/api", tags=["query"])


class QueryIn(BaseModel):
    sql: str
    connection_id: int | None = None  # a Postgres connection instead of BenchMonster's own data


async def _run(org_id: int, sql: str, connection_id: int | None, max_rows: int = sqlconsole.MAX_ROWS) -> dict:
    if connection_id is None:
        try:
            return await sqlconsole.run(org_id, sql, max_rows=max_rows)
        except sqlconsole.QueryError as e:
            raise HTTPException(400, str(e))
    conn, cfg, sec = await linked.load_connection(org_id, connection_id)
    if conn["kind"] != "postgres":
        raise HTTPException(400, "only Postgres connections can be queried with SQL")
    return await conns.pg_query(cfg, sec, sql, max_rows)


@router.post("/query")
async def run_query(body: QueryIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    return await _run(ctx.org_id, body.sql, body.connection_id)


EXPORT_MAX_ROWS = 50_000


class ExportIn(BaseModel):
    sql: str
    connection_id: int | None = None
    format: Literal["csv", "json"] = "csv"
    filename: str | None = Field(None, max_length=120)


def _plain(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


@router.post("/query/export")
async def export_query(body: ExportIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Run a query and download every row (up to 50,000) as CSV or JSON."""
    res = await _run(ctx.org_id, body.sql, body.connection_id, EXPORT_MAX_ROWS)
    cols = [c["name"] for c in res["columns"]]
    rows = [[_plain(v) for v in r] for r in res["rows"]]
    if body.format == "json":
        content = json.dumps([dict(zip(cols, r)) for r in rows], ensure_ascii=False, indent=2)
        media = "application/json"
    else:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(cols)
        w.writerows([[json.dumps(v) if isinstance(v, (dict, list)) else v for v in r] for r in rows])
        content, media = buf.getvalue(), "text/csv"
    base = re.sub(r"[^\w.\- ]+", "", (body.filename or "").strip()).strip().replace(" ", "-")
    base = base or f"bmquery-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
    name = base if base.lower().endswith(f".{body.format}") else f"{base}.{body.format}"
    headers = {"Content-Disposition": f'attachment; filename="{name}"', "X-Row-Count": str(res["row_count"]),
               "X-Truncated": str(res["truncated"]).lower()}
    return Response(content, media_type=media, headers=headers)


@router.get("/query/schema")
async def get_schema(connection_id: int | None = None, ctx: auth.Ctx = Depends(auth.current_ctx)):
    if connection_id is None:
        return await sqlconsole.schema(ctx.org_id)
    conn, cfg, sec = await linked.load_connection(ctx.org_id, connection_id)
    if conn["kind"] != "postgres":
        raise HTTPException(400, "only Postgres connections can be queried with SQL")
    return await conns.pg_schema(cfg, sec)


# --- Saved queries (shared across the org) ---------------------------------


class SavedQueryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    sql: str = Field(min_length=1, max_length=20000)
    connection_id: int | None = None


async def _own_connection(org_id: int, connection_id: int | None) -> int | None:
    if connection_id is not None and not await db.pool().fetchval(
        "select 1 from connections where id = $1 and org_id = $2", connection_id, org_id
    ):
        raise HTTPException(404, "connection not found")
    return connection_id


@router.get("/saved-queries")
async def list_saved(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        """select q.id, q.name, q.sql, q.connection_id, c.name as connection_name, q.created_at, q.updated_at,
                  u.name as created_by
           from saved_queries q left join users u on u.id = q.created_by
           left join connections c on c.id = q.connection_id
           where q.org_id = $1 order by lower(q.name)""",
        ctx.org_id,
    )
    return [dict(r) for r in rows]


@router.post("/saved-queries")
async def save(body: SavedQueryIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Create a new saved query. Names are unique per org: a clash is a 409, never a silent overwrite."""
    try:
        row = await db.pool().fetchrow(
            """insert into saved_queries (org_id, name, sql, created_by, connection_id) values ($1, $2, $3, $4, $5)
               returning id, name, sql, connection_id, created_at, updated_at""",
            ctx.org_id, body.name.strip(), body.sql, ctx.user_id, await _own_connection(ctx.org_id, body.connection_id),
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, f"a saved query named {body.name.strip()!r} already exists")
    return dict(row)


@router.put("/saved-queries/{query_id}")
async def update_saved(query_id: int, body: SavedQueryIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Rename and/or edit a saved query."""
    try:
        row = await db.pool().fetchrow(
            """update saved_queries set name = $3, sql = $4, connection_id = $5, updated_at = now()
               where id = $1 and org_id = $2 returning id, name, sql, connection_id, created_at, updated_at""",
            query_id, ctx.org_id, body.name.strip(), body.sql, await _own_connection(ctx.org_id, body.connection_id),
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, f"a saved query named {body.name.strip()!r} already exists")
    if not row:
        raise HTTPException(404, "saved query not found")
    return dict(row)


@router.delete("/saved-queries/{query_id}")
async def delete_saved(query_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await db.pool().execute("delete from saved_queries where id = $1 and org_id = $2", query_id, ctx.org_id)
    return {"ok": True}
