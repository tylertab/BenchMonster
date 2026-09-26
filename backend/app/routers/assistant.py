from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .. import assistant, auth, memory, providers, voice

router = APIRouter(prefix="/api", tags=["bmquery"])


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


# --- BMQuery chat, scoped by ?profile_id= or ?run_id= (neither = whole org) ---


@router.get("/bmquery/chat")
async def get_history(profile_id: int | None = None, run_id: int | None = None, ctx: auth.Ctx = Depends(auth.current_ctx)):
    return await assistant.history(await assistant.resolve_scope(ctx.org_id, profile_id, run_id))


@router.post("/bmquery/chat")
async def send(body: ChatIn, profile_id: int | None = None, run_id: int | None = None,
               ctx: auth.Ctx = Depends(auth.current_ctx)):
    scope = await assistant.resolve_scope(ctx.org_id, profile_id, run_id)
    try:
        return await assistant.chat(scope, body.message)
    except providers.ProviderError as e:
        raise HTTPException(502, f"assistant model error: {e}")


MAX_AUDIO_BYTES = 10 * 1024 * 1024


@router.post("/bmquery/voice")
async def voice_turn(audio: UploadFile, profile_id: int | None = None, run_id: int | None = None,
                     ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Push-to-talk: transcribe the clip, then run it through the analyst like a typed message."""
    scope = await assistant.resolve_scope(ctx.org_id, profile_id, run_id)
    data = await audio.read()
    if not data:
        raise HTTPException(400, "empty audio")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "audio clip too long")
    try:
        transcript = await voice.transcribe(data, audio.filename or "clip.webm", audio.content_type or "audio/webm")
    except voice.VoiceError as e:
        raise HTTPException(502, str(e))
    if not transcript:
        raise HTTPException(422, "didn't catch that. Try again?")
    try:
        result = await assistant.chat(scope, transcript)
    except providers.ProviderError as e:
        raise HTTPException(502, f"assistant model error: {e}")
    return {"transcript": transcript, **result}


# --- Org memory (what the analyst remembers) -------------------------------


@router.get("/memory")
async def list_memories(ctx: auth.Ctx = Depends(auth.current_ctx)):
    return await memory.list_all(ctx.org_id)


@router.delete("/memory/{memory_id}")
async def forget(memory_id: str, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await memory.delete(ctx.org_id, memory_id)
    return {"ok": True}
