"""Backboard.io long-term memory for the analyst, one Backboard assistant per org.

Memory API only (chat runs on Vultr). The org's assistant is created on first
use and its id stored on the organization, so findings are shared by everyone
in the org and never leak across orgs.
"""

import logging

import httpx

from . import db
from .config import settings

log = logging.getLogger("uvicorn.error")
_client = httpx.AsyncClient(timeout=30)


def enabled() -> bool:
    return bool(settings.backboard_api_key)


def _headers() -> dict:
    return {"X-API-Key": settings.backboard_api_key}


async def _assistant_id(org_id: int) -> str:
    row = await db.pool().fetchrow("select name, backboard_assistant_id from organizations where id = $1", org_id)
    if row["backboard_assistant_id"]:
        return row["backboard_assistant_id"]
    resp = await _client.post(
        f"{settings.backboard_base_url}/assistants",
        headers=_headers(),
        json={
            "name": f"BenchMonster org {org_id}: {row['name']}"[:100],
            "system_prompt": "Stores findings about this organization's LLM benchmark runs.",
        },
    )
    resp.raise_for_status()
    assistant_id = resp.json()["assistant_id"]
    # Another request may have raced us; keep whichever landed first.
    return await db.pool().fetchval(
        """update organizations set backboard_assistant_id = coalesce(backboard_assistant_id, $2)
           where id = $1 returning backboard_assistant_id""",
        org_id, assistant_id,
    )


async def search(org_id: int, query: str, limit: int = 5) -> list[str]:
    """Relevant past findings. Memory is best-effort: failures return nothing."""
    if not enabled():
        return []
    try:
        aid = await _assistant_id(org_id)
        resp = await _client.post(
            f"{settings.backboard_base_url}/assistants/{aid}/memories/search",
            headers=_headers(), json={"query": query, "limit": limit},
        )
        resp.raise_for_status()
        return [m["content"] for m in resp.json().get("memories", [])]
    except httpx.HTTPError:
        log.warning("backboard memory search failed", exc_info=True)
        return []


async def add(org_id: int, content: str, metadata: dict | None = None) -> bool:
    if not enabled():
        return False
    try:
        aid = await _assistant_id(org_id)
        resp = await _client.post(
            f"{settings.backboard_base_url}/assistants/{aid}/memories",
            headers=_headers(), json={"content": content, "metadata": metadata or {}},
        )
        resp.raise_for_status()
        return True
    except httpx.HTTPError:
        log.warning("backboard memory add failed", exc_info=True)
        return False


async def list_all(org_id: int) -> list[dict]:
    if not enabled():
        return []
    aid = await _assistant_id(org_id)
    resp = await _client.get(
        f"{settings.backboard_base_url}/assistants/{aid}/memories", headers=_headers(), params={"page_size": 100}
    )
    resp.raise_for_status()
    return [{"id": m["id"], "content": m["content"], "created_at": m.get("created_at")} for m in resp.json().get("memories", [])]


async def delete(org_id: int, memory_id: str) -> None:
    aid = await _assistant_id(org_id)
    resp = await _client.delete(
        f"{settings.backboard_base_url}/assistants/{aid}/memories/{memory_id}", headers=_headers()
    )
    resp.raise_for_status()
