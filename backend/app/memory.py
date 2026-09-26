"""Backboard.io long-term memory for the analyst (memory API only; chat runs on Vultr)."""

import logging

import httpx

from .config import settings

log = logging.getLogger("uvicorn.error")
_client = httpx.AsyncClient(timeout=30)


def enabled() -> bool:
    return bool(settings.backboard_api_key and settings.backboard_assistant_id)


def _url(path: str) -> str:
    return f"{settings.backboard_base_url}/assistants/{settings.backboard_assistant_id}/memories{path}"


def _headers() -> dict:
    return {"X-API-Key": settings.backboard_api_key}


async def search(query: str, limit: int = 5) -> list[str]:
    """Relevant past findings. Memory is best-effort: failures return nothing."""
    if not enabled():
        return []
    try:
        resp = await _client.post(_url("/search"), headers=_headers(), json={"query": query, "limit": limit})
        resp.raise_for_status()
        return [m["content"] for m in resp.json().get("memories", [])]
    except httpx.HTTPError:
        log.warning("backboard memory search failed", exc_info=True)
        return []


async def add(content: str, metadata: dict | None = None) -> bool:
    if not enabled():
        return False
    try:
        resp = await _client.post(_url(""), headers=_headers(), json={"content": content, "metadata": metadata or {}})
        resp.raise_for_status()
        return True
    except httpx.HTTPError:
        log.warning("backboard memory add failed", exc_info=True)
        return False
