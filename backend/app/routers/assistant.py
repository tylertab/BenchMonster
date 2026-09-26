from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import assistant, auth, memory, providers

router = APIRouter(prefix="/api", tags=["assistant"])


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


@router.get("/runs/{run_id}/chat")
async def get_history(run_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await auth.run_in_org(run_id, ctx.org_id)
    return await assistant.history(run_id)


@router.post("/runs/{run_id}/chat")
async def send(run_id: int, body: ChatIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await auth.run_in_org(run_id, ctx.org_id)
    try:
        return await assistant.chat(ctx.org_id, run_id, body.message)
    except providers.ProviderError as e:
        raise HTTPException(502, f"assistant model error: {e}")


# --- Org memory (what the analyst remembers) -------------------------------


@router.get("/memory")
async def list_memories(ctx: auth.Ctx = Depends(auth.current_ctx)):
    return await memory.list_all(ctx.org_id)


@router.delete("/memory/{memory_id}")
async def forget(memory_id: str, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await memory.delete(ctx.org_id, memory_id)
    return {"ok": True}
