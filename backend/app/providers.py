"""OpenAI-compatible chat client used for every model (Vultr and custom endpoints).

`stream_chat` is the benchmark path: it streams so we can measure time to first
token, and reports usage (including reasoning tokens) plus cost.
`complete` is the non-streaming path used by the judge and the assistant.
"""

import json
import time
from dataclasses import dataclass
from decimal import Decimal

import httpx

from .config import settings

TIMEOUT = httpx.Timeout(connect=10, read=180, write=30, pool=30)
_client = httpx.AsyncClient(timeout=TIMEOUT)


class ProviderError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status == 429 or self.status >= 500


@dataclass
class ModelEndpoint:
    model_id: str
    base_url: str
    api_key: str | None
    input_cost_per_mtok: Decimal = Decimal(0)
    output_cost_per_mtok: Decimal = Decimal(0)

    @classmethod
    def from_row(cls, row) -> "ModelEndpoint":
        return cls(
            model_id=row["model_id"],
            base_url=row["base_url"],
            api_key=row["api_key"] or (settings.vultr_inference_api_key if row["provider"] == "vultr" else None),
            input_cost_per_mtok=Decimal(row["input_cost_per_mtok"]),
            output_cost_per_mtok=Decimal(row["output_cost_per_mtok"]),
        )

    def headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def cost(self, tokens_in: int, tokens_out: int) -> Decimal:
        return (tokens_in * self.input_cost_per_mtok + tokens_out * self.output_cost_per_mtok) / Decimal(1_000_000)


@dataclass
class ChatResult:
    output: str
    reasoning: str
    latency_ms: float
    ttft_ms: float | None
    tokens_in: int
    tokens_out: int
    reasoning_tokens: int
    tokens_per_sec: float | None
    cost_usd: Decimal
    finish_reason: str | None


def _raise_for_status(resp: httpx.Response, body: bytes) -> None:
    if resp.status_code >= 400:
        text = body.decode(errors="replace")[:500]
        raise ProviderError(f"HTTP {resp.status_code}: {text}", resp.status_code)


async def stream_chat(
    ep: ModelEndpoint, messages: list[dict], *, max_tokens: int, temperature: float
) -> ChatResult:
    payload = {
        "model": ep.model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    content: list[str] = []
    reasoning: list[str] = []
    usage: dict = {}
    finish_reason = None
    ttft = None
    start = time.perf_counter()
    try:
        async with _client.stream(
            "POST", f"{ep.base_url.rstrip('/')}/chat/completions", headers=ep.headers(), json=payload
        ) as resp:
            if resp.status_code >= 400:
                _raise_for_status(resp, await resp.aread())
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                chunk = json.loads(data)
                if chunk.get("usage"):
                    usage = chunk["usage"]
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    # Providers disagree on the reasoning field name.
                    r = delta.get("reasoning") or delta.get("reasoning_content")
                    c = delta.get("content")
                    if (r or c) and ttft is None:
                        ttft = (time.perf_counter() - start) * 1000
                    if r:
                        reasoning.append(r)
                    if c:
                        content.append(c)
                    finish_reason = choice.get("finish_reason") or finish_reason
    except httpx.HTTPError as e:
        raise ProviderError(f"{type(e).__name__}: {e}") from e

    latency = (time.perf_counter() - start) * 1000
    tokens_in = usage.get("prompt_tokens", 0)
    tokens_out = usage.get("completion_tokens", 0)
    reasoning_tokens = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    return ChatResult(
        output="".join(content).strip(),
        reasoning="".join(reasoning),
        latency_ms=latency,
        ttft_ms=ttft,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        reasoning_tokens=reasoning_tokens,
        # End-to-end throughput. Short answers often arrive in a single burst, so
        # dividing by (latency - ttft) produces meaningless spikes.
        tokens_per_sec=tokens_out / (latency / 1000) if tokens_out else None,
        cost_usd=ep.cost(tokens_in, tokens_out),
        finish_reason=finish_reason,
    )


async def complete(ep: ModelEndpoint, messages: list[dict], **params) -> dict:
    """Non-streaming chat completion. Returns the raw response JSON."""
    payload = {"model": ep.model_id, "messages": messages, **params}
    try:
        resp = await _client.post(
            f"{ep.base_url.rstrip('/')}/chat/completions", headers=ep.headers(), json=payload
        )
    except httpx.HTTPError as e:
        raise ProviderError(f"{type(e).__name__}: {e}") from e
    _raise_for_status(resp, resp.content)
    return resp.json()


def vultr_endpoint(model_id: str) -> ModelEndpoint:
    return ModelEndpoint(model_id, settings.vultr_inference_base_url, settings.vultr_inference_api_key)


async def fetch_vultr_catalog() -> list[dict]:
    """Chat-capable models from Vultr's public catalog, with per-1M-token prices."""
    resp = await _client.get(f"{settings.vultr_inference_base_url.rstrip('/')}/models")
    resp.raise_for_status()
    out = []
    for m in resp.json()["data"]:
        if not any(o["type"] == "text" for o in m.get("output_modalities", [])):
            continue
        prices = {}
        ctx = None
        for mod in m.get("input_modalities", []) + m.get("output_modalities", []):
            for p in mod.get("pricing") or []:
                prices[p["type"]] = Decimal(p["cost_usd"]) * 1_000_000
            if mod["type"] == "text" and ctx is None:
                ctx = (mod.get("supported_inputs") or {}).get("max_context_length", {}).get("value")
        out.append(
            {
                "model_id": m["id"],
                "display_name": m.get("name") or m["id"],
                "input_cost_per_mtok": prices.get("prompt", Decimal(0)),
                "output_cost_per_mtok": prices.get("completion", Decimal(0)),
                "context_length": ctx,
            }
        )
    return out
