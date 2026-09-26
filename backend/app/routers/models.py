from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, HttpUrl

from .. import auth, db, providers
from ..config import settings

router = APIRouter(prefix="/api/models", tags=["models"])

PUBLIC_COLUMNS = """id, provider, model_id, display_name, base_url, is_custom, active,
    input_cost_per_mtok, output_cost_per_mtok, context_length"""

# Upserts must name the same expression as the models_scope_uniq index.
SCOPE_CONFLICT = "on conflict (coalesce(org_id, 0), base_url, model_id)"


async def sync_vultr_models() -> int:
    """Upsert Vultr's catalog (names + live prices) as global models; deactivate dropped ones."""
    catalog = await providers.fetch_vultr_catalog()
    base = settings.vultr_inference_base_url
    async with db.pool().acquire() as conn, conn.transaction():
        for m in catalog:
            await conn.execute(
                f"""insert into models (provider, model_id, display_name, base_url,
                       input_cost_per_mtok, output_cost_per_mtok, context_length, active)
                   values ('vultr', $1, $2, $3, $4, $5, $6, true)
                   {SCOPE_CONFLICT} do update set
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
async def list_models(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        f"""select {PUBLIC_COLUMNS} from models
            where active and (org_id is null or org_id = $1)
            order by is_custom desc, display_name""",
        ctx.org_id,
    )
    return [dict(r) for r in rows]


@router.post("/sync")
async def sync(ctx: auth.Ctx = Depends(auth.current_ctx)):
    return {"synced": await sync_vultr_models()}


class CustomModelIn(BaseModel):
    display_name: str
    model_id: str
    base_url: HttpUrl
    api_key: str | None = None
    input_cost_per_mtok: Decimal = Decimal(0)
    output_cost_per_mtok: Decimal = Decimal(0)


@router.post("")
async def add_custom_model(body: CustomModelIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Register an OpenAI-compatible endpoint for this org (vLLM on a Vultr GPU, Ollama, etc.).

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
        f"""insert into models (org_id, provider, model_id, display_name, base_url, api_key,
               input_cost_per_mtok, output_cost_per_mtok, is_custom)
           values ($1, 'openai_compatible', $2, $3, $4, $5, $6, $7, true)
           {SCOPE_CONFLICT} do update set
               display_name = excluded.display_name, api_key = excluded.api_key,
               input_cost_per_mtok = excluded.input_cost_per_mtok,
               output_cost_per_mtok = excluded.output_cost_per_mtok, active = true
           returning {PUBLIC_COLUMNS}""",
        ctx.org_id, body.model_id, body.display_name, str(body.base_url), body.api_key,
        body.input_cost_per_mtok, body.output_cost_per_mtok,
    )
    return dict(row)


@router.delete("/{model_pk}")
async def remove_model(model_pk: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    # Soft delete (past results keep pointing at it); only the org's own custom models.
    await db.pool().execute(
        "update models set active = false where id = $1 and org_id = $2", model_pk, ctx.org_id
    )
    return {"ok": True}
