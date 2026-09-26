from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import auth, db, templates

router = APIRouter(prefix="/api/prompts", tags=["prompts"])

COLUMNS = """p.id, p.name, p.system_prompt, p.template, p.created_at, p.updated_at,
    u.name as created_by,
    (select count(*) from runs r where r.prompt_id = p.id) as run_count,
    (select max(created_at) from runs r where r.prompt_id = p.id) as last_run_at"""


def _with_vars(row) -> dict:
    return {**dict(row), "variables": templates.variables(row["template"])}


class PromptIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    system_prompt: str | None = Field(None, max_length=20000)
    template: str = Field(min_length=1, max_length=50000)


def _validate(body: PromptIn) -> None:
    if not templates.variables(body.template):
        raise HTTPException(400, "the template needs at least one {{variable}} to fill from your datasets")


@router.get("")
async def list_prompts(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        f"""select {COLUMNS} from prompts p left join users u on u.id = p.created_by
            where p.org_id = $1 order by p.updated_at desc""",
        ctx.org_id,
    )
    return [_with_vars(r) for r in rows]


@router.get("/{prompt_id}")
async def get_prompt(prompt_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    row = await db.pool().fetchrow(
        f"""select {COLUMNS} from prompts p left join users u on u.id = p.created_by
            where p.id = $1 and p.org_id = $2""",
        prompt_id, ctx.org_id,
    )
    if not row:
        raise HTTPException(404, "prompt not found")
    return _with_vars(row)


@router.post("")
async def create_prompt(body: PromptIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    _validate(body)
    prompt_id = await db.pool().fetchval(
        """insert into prompts (org_id, name, system_prompt, template, created_by)
           values ($1, $2, $3, $4, $5) returning id""",
        ctx.org_id, body.name.strip(), (body.system_prompt or "").strip() or None, body.template, ctx.user_id,
    )
    return await get_prompt(prompt_id, ctx)


@router.put("/{prompt_id}")
async def update_prompt(prompt_id: int, body: PromptIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Past runs keep the template they used; edits only affect future runs."""
    _validate(body)
    status = await db.pool().execute(
        """update prompts set name = $3, system_prompt = $4, template = $5, updated_at = now()
           where id = $1 and org_id = $2""",
        prompt_id, ctx.org_id, body.name.strip(), (body.system_prompt or "").strip() or None, body.template,
    )
    if status == "UPDATE 0":
        raise HTTPException(404, "prompt not found")
    return await get_prompt(prompt_id, ctx)


@router.delete("/{prompt_id}")
async def delete_prompt(prompt_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await db.pool().execute("delete from prompts where id = $1 and org_id = $2", prompt_id, ctx.org_id)
    return {"ok": True}
