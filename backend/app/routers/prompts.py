"""The prompt library. Every change to a prompt's text (system prompt or template)
is saved as a new, immutable version; renaming doesn't create one. Profiles
record which prompt version they were built from."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import auth, db, templates

router = APIRouter(prefix="/api/prompts", tags=["prompts"])

COLUMNS = """p.id, p.name, p.system_prompt, p.template, p.current_version, p.created_at, p.updated_at,
    u.name as created_by,
    (select count(distinct v.profile_id) from profile_versions v where v.prompt_id = p.id) as profile_count,
    (select count(*) from runs r where r.prompt_id = p.id) as run_count,
    (select max(created_at) from runs r where r.prompt_id = p.id) as last_run_at"""


def _variables(system_prompt: str | None, template: str) -> list[str]:
    return templates.variables(f"{template} {system_prompt or ''}")


def _with_vars(row) -> dict:
    return {**dict(row), "variables": _variables(row["system_prompt"], row["template"])}


class PromptIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    system_prompt: str | None = Field(None, max_length=20000)
    template: str = Field(min_length=1, max_length=50000)
    note: str | None = Field(None, max_length=500)  # what changed (for a new version)


def _validate(body: PromptIn) -> None:
    if not templates.variables(body.template):
        raise HTTPException(400, "the template needs at least one {{variable}} to fill from your datasets")


def _clean_system(s: str | None) -> str | None:
    return (s or "").strip() or None


def _changed(prev, cur) -> list[str]:
    out = []
    if (prev["system_prompt"] or None) != (cur["system_prompt"] or None):
        out.append("system prompt")
    if prev["template"] != cur["template"]:
        out.append("template")
    return out


async def _prompt_row(prompt_id: int, org_id: int):
    row = await db.pool().fetchrow(
        f"""select {COLUMNS} from prompts p left join users u on u.id = p.created_by
            where p.id = $1 and p.org_id = $2""",
        prompt_id, org_id,
    )
    if not row:
        raise HTTPException(404, "prompt not found")
    return row


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
    """The current text, every version (with what changed), and the profiles that use it."""
    row = await _prompt_row(prompt_id, ctx.org_id)
    versions = await db.pool().fetch(
        """select v.version, v.system_prompt, v.template, v.note, v.created_at, u.name as created_by,
                  (select count(*) from profile_versions pv where pv.prompt_id = v.prompt_id and pv.prompt_version = v.version) as profile_version_count
           from prompt_versions v left join users u on u.id = v.created_by
           where v.prompt_id = $1 order by v.version desc""",
        prompt_id,
    )
    history = []
    for i, v in enumerate(versions):
        prev = versions[i + 1] if i + 1 < len(versions) else None
        history.append({k: v[k] for k in ("version", "note", "created_at", "created_by", "profile_version_count")}
                       | {"changed": _changed(prev, v) if prev else []})
    used_by = await db.pool().fetch(
        """select distinct on (p.id) p.id as profile_id, p.name as profile_name, p.current_version,
                  pv.version as profile_version, pv.prompt_version
           from profile_versions pv join benchmark_profiles p on p.id = pv.profile_id
           where pv.prompt_id = $1 and p.org_id = $2
           order by p.id, pv.version desc""",
        prompt_id, ctx.org_id,
    )
    return {**_with_vars(row), "versions": history, "used_by": [dict(u) for u in used_by]}


@router.get("/{prompt_id}/versions/{version}")
async def get_version(prompt_id: int, version: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await _prompt_row(prompt_id, ctx.org_id)
    v = await db.pool().fetchrow(
        """select v.version, v.system_prompt, v.template, v.note, v.created_at, u.name as created_by
           from prompt_versions v left join users u on u.id = v.created_by
           where v.prompt_id = $1 and v.version = $2""",
        prompt_id, version,
    )
    if not v:
        raise HTTPException(404, f"version {version} not found")
    return {**dict(v), "variables": _variables(v["system_prompt"], v["template"])}


@router.post("")
async def create_prompt(body: PromptIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    _validate(body)
    async with db.pool().acquire() as conn, conn.transaction():
        prompt_id = await conn.fetchval(
            """insert into prompts (org_id, name, system_prompt, template, created_by)
               values ($1, $2, $3, $4, $5) returning id""",
            ctx.org_id, body.name.strip(), _clean_system(body.system_prompt), body.template, ctx.user_id,
        )
        await conn.execute(
            """insert into prompt_versions (prompt_id, version, system_prompt, template, note, created_by)
               values ($1, 1, $2, $3, $4, $5)""",
            prompt_id, _clean_system(body.system_prompt), body.template, (body.note or "").strip() or None, ctx.user_id,
        )
    return await get_prompt(prompt_id, ctx)


async def _new_version(conn, prompt_id: int, system_prompt: str | None, template: str, note: str | None, user_id: int) -> int:
    version = await conn.fetchval("select coalesce(max(version), 0) + 1 from prompt_versions where prompt_id = $1", prompt_id)
    await conn.execute(
        """insert into prompt_versions (prompt_id, version, system_prompt, template, note, created_by)
           values ($1, $2, $3, $4, $5, $6)""",
        prompt_id, version, system_prompt, template, (note or "").strip() or None, user_id,
    )
    await conn.execute(
        """update prompts set system_prompt = $2, template = $3, current_version = $4, updated_at = now() where id = $1""",
        prompt_id, system_prompt, template, version,
    )
    return version


@router.put("/{prompt_id}")
async def update_prompt(prompt_id: int, body: PromptIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Rename, and/or save changed text as a new version. Existing versions never change."""
    _validate(body)
    cur = await _prompt_row(prompt_id, ctx.org_id)
    system = _clean_system(body.system_prompt)
    async with db.pool().acquire() as conn, conn.transaction():
        await conn.execute("select 1 from prompts where id = $1 for update", prompt_id)
        await conn.execute("update prompts set name = $2, updated_at = now() where id = $1", prompt_id, body.name.strip())
        if system != cur["system_prompt"] or body.template != cur["template"]:
            await _new_version(conn, prompt_id, system, body.template, body.note, ctx.user_id)
    return await get_prompt(prompt_id, ctx)


@router.post("/{prompt_id}/versions/{version}/restore")
async def restore_version(prompt_id: int, version: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Make an old version current again, as a new version (history is never rewritten)."""
    cur = await _prompt_row(prompt_id, ctx.org_id)
    v = await db.pool().fetchrow(
        "select system_prompt, template from prompt_versions where prompt_id = $1 and version = $2", prompt_id, version
    )
    if not v:
        raise HTTPException(404, f"version {version} not found")
    if not _changed(cur, v):
        raise HTTPException(400, f"v{version} is the same as the current version")
    async with db.pool().acquire() as conn, conn.transaction():
        await conn.execute("select 1 from prompts where id = $1 for update", prompt_id)
        await _new_version(conn, prompt_id, v["system_prompt"], v["template"], f"Restored v{version}", ctx.user_id)
    return await get_prompt(prompt_id, ctx)


@router.delete("/{prompt_id}")
async def delete_prompt(prompt_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Profiles and runs keep their own copy of the text; they just lose the link."""
    await db.pool().execute("delete from prompts where id = $1 and org_id = $2", prompt_id, ctx.org_id)
    return {"ok": True}
