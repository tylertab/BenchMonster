"""Password hashing, cookie sessions, and the request context (user + active org + role)."""

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response

from . import db
from .config import settings

COOKIE = "bm_session"
SESSION_TTL = timedelta(days=14)
ROLES = ("owner", "admin")

# scrypt parameters (stdlib, no extra dependency).
_N, _R, _P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_b64, digest_b64 = stored.split("$")
        digest = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt_b64), n=_N, r=_R, p=_P)
        return hmac.compare_digest(digest, base64.b64decode(digest_b64))
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def start_session(response: Response, user_id: int, org_id: int | None) -> None:
    token = secrets.token_urlsafe(32)
    await db.pool().execute(
        "insert into sessions (token_hash, user_id, org_id, expires_at) values ($1, $2, $3, $4)",
        token_hash(token), user_id, org_id, datetime.now(timezone.utc) + SESSION_TTL,
    )
    response.set_cookie(
        COOKIE, token, max_age=int(SESSION_TTL.total_seconds()),
        httponly=True, samesite="lax", secure=settings.cookie_secure, path="/",
    )


async def end_session(request: Request, response: Response) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        await db.pool().execute("delete from sessions where token_hash = $1", token_hash(token))
    response.delete_cookie(COOKIE, path="/")


@dataclass
class User:
    id: int
    email: str
    name: str
    session_hash: str
    org_id: int | None  # active org; may be None if the user belongs to none


@dataclass
class Ctx:
    """A logged-in user acting inside their active organization."""

    user_id: int
    email: str
    name: str
    org_id: int
    org_name: str
    role: str

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"


async def current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "not signed in")
    row = await db.pool().fetchrow(
        """select u.id, u.email, u.name, s.token_hash, s.org_id
           from sessions s join users u on u.id = s.user_id
           where s.token_hash = $1 and s.expires_at > now()""",
        token_hash(token),
    )
    if not row:
        raise HTTPException(401, "session expired")
    return User(row["id"], row["email"], row["name"], row["token_hash"], row["org_id"])


async def current_ctx(user: User = Depends(current_user)) -> Ctx:
    row = None
    if user.org_id is not None:
        row = await db.pool().fetchrow(
            """select o.id, o.name, m.role from memberships m join organizations o on o.id = m.org_id
               where m.org_id = $1 and m.user_id = $2""",
            user.org_id, user.id,
        )
    if not row:
        # Active org is gone (removed from it); fall back to any remaining membership.
        row = await db.pool().fetchrow(
            """select o.id, o.name, m.role from memberships m join organizations o on o.id = m.org_id
               where m.user_id = $1 order by m.created_at limit 1""",
            user.id,
        )
        if not row:
            raise HTTPException(403, "you are not a member of any organization")
        await db.pool().execute("update sessions set org_id = $2 where token_hash = $1", user.session_hash, row["id"])
    return Ctx(user.id, user.email, user.name, row["id"], row["name"], row["role"])


async def require_owner(ctx: Ctx = Depends(current_ctx)) -> Ctx:
    if not ctx.is_owner:
        raise HTTPException(403, "only organization owners can do this")
    return ctx


async def run_in_org(run_id: int, org_id: int) -> None:
    """404 unless the run belongs to the org (don't reveal other orgs' ids)."""
    ok = await db.pool().fetchval(
        "select 1 from runs where id = $1 and org_id = $2",
        run_id, org_id,
    )
    if not ok:
        raise HTTPException(404, "run not found")
