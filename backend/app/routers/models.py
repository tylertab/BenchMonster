from decimal import Decimal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, HttpUrl

from .. import db, providers
from ..config import settings

router = APIRouter(prefix="/api/models", tags=["models"])

PUBLIC_COLUMNS = """id, provider, model_id, display_name, base_url, is_custom, active,
    input_cost_per_mtok, output_cost_per_mtok, context_length"""


async def sync_vultr_models() -> int:
    """Upsert Vultr's catalog (names + live prices); deactivate models Vultr dropped."""
    catalog = await providers.fetch_vultr_catalog()
    base = settings.vultr_inference_base_url
    async with db.pool().acquire() as conn, conn.transaction():
        for m in catalog:
            await conn.execute(
                """insert into models (provider, model_id, display_name, base_url,
                       input_cost_per_mtok, output_cost_per_mtok, context_length, active)
                   values ('vultr', $1, $2, $3, $4, $5, $6, true)
                   on conflict (base_url, model_id) do update set
                       display_name = excluded.display_name,
                       input_cost_per_mtok = excluded.input_cost_per_mtok,
                       output_cost_per_mtok = excluded.output_cost_per_mtok,
                       context_length = excluded.context_length,
                       active = true""",
                m["model_id"], m["display_name"], base,
                m["input_cost_per_mtok"], m["output_cost_per_mtok"], m["context_length"],
            )
        await conn.execute(
            "update models set active = false where provider = 'vultr' and not (model_id = any($1))",
            [m["model_id"] for m in catalog],
        )
    return len(catalog)


@router.get("")
async def list_models():
    rows = await db.pool().fetch(
        f"select {PUBLIC_COLUMNS} from models where active order by is_custom desc, display_name"
    )
    return [dict(r) for r in rows]


@router.post("/sync")
async def sync():
    return {"synced": await sync_vultr_models()}


class CustomModelIn(BaseModel):
    display_name: str
    model_id: str
    base_url: HttpUrl
    api_key: str | None = None
    input_cost_per_mtok: Decimal = Decimal(0)
    output_cost_per_mtok: Decimal = Decimal(0)


@router.post("")
async def add_custom_model(body: CustomModelIn):
    """Register any OpenAI-compatible endpoint (vLLM on a Vultr GPU, Ollama, etc.).

    Sends one tiny request first so a bad URL/key fails here, not mid-benchmark.
    """
    ep = providers.ModelEndpoint(
        body.model_id, str(body.base_url), body.api_key,
        body.input_cost_per_mtok, body.output_cost_per_mtok,
    )
    try:
        await providers.complete(ep, [{"role": "user", "content": "ping"}], max_tokens=5)
    except providers.ProviderError as e:
        raise HTTPException(400, f"Endpoint check failed: {e}")
    row = await db.pool().fetchrow(
        f"""insert into models (provider, model_id, display_name, base_url, api_key,
               input_cost_per_mtok, output_cost_per_mtok, is_custom)
           values ('openai_compatible', $1, $2, $3, $4, $5, $6, true)
           on conflict (base_url, model_id) do update set
               display_name = excluded.display_name, api_key = excluded.api_key,
               input_cost_per_mtok = excluded.input_cost_per_mtok,
               output_cost_per_mtok = excluded.output_cost_per_mtok, active = true
           returning {PUBLIC_COLUMNS}""",
        body.model_id, body.display_name, str(body.base_url), body.api_key,
        body.input_cost_per_mtok, body.output_cost_per_mtok,
    )
    return dict(row)


@router.delete("/{model_pk}")
async def remove_model(model_pk: int):
    # Soft delete: past results keep pointing at the model.
    await db.pool().execute("update models set active = false where id = $1", model_pk)
    return {"ok": True}
