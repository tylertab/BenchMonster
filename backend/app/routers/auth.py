from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field

from .. import auth, db, orgs

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SignupIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    org_name: str | None = Field(None, max_length=100)
    invite_token: str | None = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


async def pending_invite(token: str):
    return await db.pool().fetchrow(
        """select i.*, o.name as org_name from invitations i join organizations o on o.id = i.org_id
           where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()""",
        auth.token_hash(token),
    )


async def accept_invite(conn, invite, user_id: int) -> None:
    await conn.execute(
        """insert into memberships (org_id, user_id, role) values ($1, $2, $3)
           on conflict (org_id, user_id) do nothing""",
        invite["org_id"], user_id, invite["role"],
    )
    await conn.execute("update invitations set accepted_at = $2 where id = $1", invite["id"], datetime.now(timezone.utc))


async def me_payload(user_id: int, active_org: int | None) -> dict:
    user = await db.pool().fetchrow("select id, name, email from users where id = $1", user_id)
    memberships = await db.pool().fetch(
        """select o.id, o.name, m.role from memberships m join organizations o on o.id = m.org_id
           where m.user_id = $1 order by o.name""",
        user_id,
    )
    org = next((m for m in memberships if m["id"] == active_org), memberships[0] if memberships else None)
    return {
        "user": dict(user),
        "org": {"id": org["id"], "name": org["name"]} if org else None,
        "role": org["role"] if org else None,
        "orgs": [dict(m) for m in memberships],
    }


@router.post("/signup")
async def signup(body: SignupIn, response: Response):
    invite = await pending_invite(body.invite_token) if body.invite_token else None
    if body.invite_token and not invite:
        raise HTTPException(400, "this invitation is invalid or has expired")
    if invite and invite["email"].lower() != body.email.lower():
        raise HTTPException(400, f"this invitation was sent to {invite['email']}")

    async with db.pool().acquire() as conn, conn.transaction():
        if await conn.fetchval("select 1 from users where lower(email) = lower($1)", body.email):
            raise HTTPException(409, "an account with this email already exists; sign in instead")
        user_id = await conn.fetchval(
            "insert into users (email, name, password_hash) values ($1, $2, $3) returning id",
            body.email, body.name.strip(), auth.hash_password(body.password),
        )
        if invite:
            await accept_invite(conn, invite, user_id)
            org_id = invite["org_id"]
        else:
            org_id = await orgs.create_org(conn, (body.org_name or f"{body.name.strip()}'s org").strip(), user_id)
    await auth.start_session(response, user_id, org_id)
    return await me_payload(user_id, org_id)


@router.post("/login")
async def login(body: LoginIn, response: Response):
    user = await db.pool().fetchrow(
        "select id, password_hash from users where lower(email) = lower($1)", body.email
    )
    if not user or not auth.verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "wrong email or password")
    org_id = await db.pool().fetchval(
        "select org_id from memberships where user_id = $1 order by created_at limit 1", user["id"]
    )
    await auth.start_session(response, user["id"], org_id)
    return await me_payload(user["id"], org_id)


@router.post("/logout")
async def logout(request: Request, response: Response):
    await auth.end_session(request, response)
    return {"ok": True}


@router.get("/me")
async def me(user: auth.User = Depends(auth.current_user)):
    return await me_payload(user.id, user.org_id)


class SwitchIn(BaseModel):
    org_id: int


@router.post("/switch-org")
async def switch_org(body: SwitchIn, user: auth.User = Depends(auth.current_user)):
    if not await db.pool().fetchval(
        "select 1 from memberships where org_id = $1 and user_id = $2", body.org_id, user.id
    ):
        raise HTTPException(404, "organization not found")
    await db.pool().execute("update sessions set org_id = $2 where token_hash = $1", user.session_hash, body.org_id)
    return await me_payload(user.id, body.org_id)
