from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import assistant, providers

router = APIRouter(prefix="/api/runs/{run_id}/chat", tags=["assistant"])


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


@router.get("")
async def get_history(run_id: int):
    return await assistant.history(run_id)


@router.post("")
async def send(run_id: int, body: ChatIn):
    try:
        return await assistant.chat(run_id, body.message)
    except LookupError:
        raise HTTPException(404, "run not found")
    except providers.ProviderError as e:
        raise HTTPException(502, f"assistant model error: {e}")
