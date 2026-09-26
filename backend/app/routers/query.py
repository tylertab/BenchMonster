from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import sqlconsole

router = APIRouter(prefix="/api/query", tags=["query"])


class QueryIn(BaseModel):
    sql: str


@router.post("")
async def run_query(body: QueryIn):
    try:
        return await sqlconsole.run(body.sql)
    except sqlconsole.QueryError as e:
        raise HTTPException(400, str(e))


@router.get("/schema")
async def get_schema():
    return await sqlconsole.schema()
