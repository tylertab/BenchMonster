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

from .. import auth, db, sqlconsole

router = APIRouter(prefix="/api", tags=["query"])


class QueryIn(BaseModel):
    sql: str


@router.post("/query")
async def run_query(body: QueryIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    try:
        return await sqlconsole.run(ctx.org_id, body.sql)
    except sqlconsole.QueryError as e:
        raise HTTPException(400, str(e))


EXPORT_MAX_ROWS = 50_000


class ExportIn(BaseModel):
    sql: str
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
    try:
        res = await sqlconsole.run(ctx.org_id, body.sql, max_rows=EXPORT_MAX_ROWS)
    except sqlconsole.QueryError as e:
        raise HTTPException(400, str(e))
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
async def get_schema(ctx: auth.Ctx = Depends(auth.current_ctx)):
    return await sqlconsole.schema(ctx.org_id)


# --- Saved queries (shared across the org) ---------------------------------


class SavedQueryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    sql: str = Field(min_length=1, max_length=20000)


@router.get("/saved-queries")
async def list_saved(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        """select q.id, q.name, q.sql, q.created_at, q.updated_at, u.name as created_by
           from saved_queries q left join users u on u.id = q.created_by
           where q.org_id = $1 order by lower(q.name)""",
        ctx.org_id,
    )
    return [dict(r) for r in rows]


@router.post("/saved-queries")
async def save(body: SavedQueryIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Create a new saved query. Names are unique per org: a clash is a 409, never a silent overwrite."""
    try:
        row = await db.pool().fetchrow(
            """insert into saved_queries (org_id, name, sql, created_by) values ($1, $2, $3, $4)
               returning id, name, sql, created_at, updated_at""",
            ctx.org_id, body.name.strip(), body.sql, ctx.user_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, f"a saved query named {body.name.strip()!r} already exists")
    return dict(row)


@router.put("/saved-queries/{query_id}")
async def update_saved(query_id: int, body: SavedQueryIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Rename and/or edit a saved query."""
    try:
        row = await db.pool().fetchrow(
            """update saved_queries set name = $3, sql = $4, updated_at = now()
               where id = $1 and org_id = $2 returning id, name, sql, created_at, updated_at""",
            query_id, ctx.org_id, body.name.strip(), body.sql,
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
