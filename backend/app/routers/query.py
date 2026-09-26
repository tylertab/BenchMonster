from fastapi import APIRouter, Depends, HTTPException
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
    """Create, or overwrite the org's query with the same name."""
    row = await db.pool().fetchrow(
        """insert into saved_queries (org_id, name, sql, created_by) values ($1, $2, $3, $4)
           on conflict (org_id, name) do update set sql = excluded.sql, updated_at = now()
           returning id, name, sql, created_at, updated_at""",
        ctx.org_id, body.name.strip(), body.sql, ctx.user_id,
    )
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
    except Exception as e:  # unique (org_id, name)
        if "saved_queries_org_id_name_key" in str(e):
            raise HTTPException(409, "a saved query with that name already exists")
        raise
    if not row:
        raise HTTPException(404, "saved query not found")
    return dict(row)


@router.delete("/saved-queries/{query_id}")
async def delete_saved(query_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await db.pool().execute("delete from saved_queries where id = $1 and org_id = $2", query_id, ctx.org_id)
    return {"ok": True}
