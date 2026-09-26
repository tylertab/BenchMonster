import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from .. import auth, db, orgs
from ..config import settings
from .auth import accept_invite, me_payload, pending_invite

router = APIRouter(prefix="/api", tags=["organization"])

INVITE_TTL = timedelta(days=7)
Role = Literal["owner", "admin"]


@router.get("/org")
async def get_org(ctx: auth.Ctx = Depends(auth.current_ctx)):
    pool = db.pool()
    members = await pool.fetch(
        """select u.id, u.name, u.email, m.role, m.created_at from memberships m
           join users u on u.id = m.user_id where m.org_id = $1 order by m.created_at""",
        ctx.org_id,
    )
    invites = await pool.fetch(
        """select id, email, role, created_at, expires_at from invitations
           where org_id = $1 and accepted_at is null and expires_at > now() order by created_at desc""",
        ctx.org_id,
    )
    return {
        "id": ctx.org_id,
        "name": ctx.org_name,
        "role": ctx.role,
        "members": [dict(m) for m in members],
        "invitations": [dict(i) for i in invites] if ctx.is_owner else [],
    }


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@router.patch("/org")
async def rename_org(body: OrgIn, ctx: auth.Ctx = Depends(auth.require_owner)):
    await db.pool().execute("update organizations set name = $2 where id = $1", ctx.org_id, body.name.strip())
    return {"ok": True}


@router.post("/orgs")
async def create_org(body: OrgIn, user: auth.User = Depends(auth.current_user)):
    """Create another organization (you become its owner) and switch to it."""
    async with db.pool().acquire() as conn, conn.transaction():
        org_id = await orgs.create_org(conn, body.name.strip(), user.id)
        await conn.execute("update sessions set org_id = $2 where token_hash = $1", user.session_hash, org_id)
    return await me_payload(user.id, org_id)


class InviteIn(BaseModel):
    email: EmailStr
    role: Role = "admin"


@router.post("/org/invitations")
async def invite(body: InviteIn, ctx: auth.Ctx = Depends(auth.require_owner)):
    if await db.pool().fetchval(
        """select 1 from memberships m join users u on u.id = m.user_id
           where m.org_id = $1 and lower(u.email) = lower($2)""",
        ctx.org_id, body.email,
    ):
        raise HTTPException(409, "already a member")
    token = secrets.token_urlsafe(24)
    inv_id = await db.pool().fetchval(
        """insert into invitations (org_id, email, role, token_hash, invited_by, expires_at)
           values ($1, $2, $3, $4, $5, $6) returning id""",
        ctx.org_id, body.email, body.role, auth.token_hash(token), ctx.user_id,
        datetime.now(timezone.utc) + INVITE_TTL,
    )
    # No email service: the owner shares this link. The token is only shown once.
    return {"id": inv_id, "token": token, "url": f"{settings.public_url}/invite/{token}"}


@router.delete("/org/invitations/{inv_id}")
async def revoke_invite(inv_id: int, ctx: auth.Ctx = Depends(auth.require_owner)):
    await db.pool().execute("delete from invitations where id = $1 and org_id = $2", inv_id, ctx.org_id)
    return {"ok": True}


async def _owner_count(org_id: int) -> int:
    return await db.pool().fetchval("select count(*) from memberships where org_id = $1 and role = 'owner'", org_id)


class RoleIn(BaseModel):
    role: Role


@router.patch("/org/members/{user_id}")
async def change_role(user_id: int, body: RoleIn, ctx: auth.Ctx = Depends(auth.require_owner)):
    current = await db.pool().fetchval(
        "select role from memberships where org_id = $1 and user_id = $2", ctx.org_id, user_id
    )
    if not current:
        raise HTTPException(404, "member not found")
    if current == "owner" and body.role != "owner" and await _owner_count(ctx.org_id) <= 1:
        raise HTTPException(400, "an organization needs at least one owner")
    await db.pool().execute(
        "update memberships set role = $3 where org_id = $1 and user_id = $2", ctx.org_id, user_id, body.role
    )
    return {"ok": True}


@router.delete("/org/members/{user_id}")
async def remove_member(user_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Owners can remove anyone; anyone can remove themselves (leave)."""
    if user_id != ctx.user_id and not ctx.is_owner:
        raise HTTPException(403, "only organization owners can remove members")
    role = await db.pool().fetchval(
        "select role from memberships where org_id = $1 and user_id = $2", ctx.org_id, user_id
    )
    if not role:
        raise HTTPException(404, "member not found")
    if role == "owner" and await _owner_count(ctx.org_id) <= 1:
        raise HTTPException(400, "an organization needs at least one owner")
    await db.pool().execute("delete from memberships where org_id = $1 and user_id = $2", ctx.org_id, user_id)
    return {"ok": True}


@router.get("/invitations/{token}")
async def invitation_info(token: str):
    """Public: lets the invite page show which org/email/role the link is for."""
    inv = await pending_invite(token)
    if not inv:
        raise HTTPException(404, "this invitation is invalid or has expired")
    return {"org_name": inv["org_name"], "email": inv["email"], "role": inv["role"]}


@router.post("/invitations/{token}/accept")
async def accept(token: str, user: auth.User = Depends(auth.current_user)):
    inv = await pending_invite(token)
    if not inv:
        raise HTTPException(404, "this invitation is invalid or has expired")
    if inv["email"].lower() != user.email.lower():
        raise HTTPException(403, f"this invitation was sent to {inv['email']}; sign in with that account")
    async with db.pool().acquire() as conn, conn.transaction():
        await accept_invite(conn, inv, user.id)
        await conn.execute("update sessions set org_id = $2 where token_hash = $1", user.session_hash, inv["org_id"])
    return await me_payload(user.id, inv["org_id"])
