from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .. import assistant, auth, providers, voice

router = APIRouter(prefix="/api", tags=["voice"])

MAX_AUDIO_BYTES = 10 * 1024 * 1024


@router.post("/runs/{run_id}/voice")
async def voice_turn(run_id: int, audio: UploadFile, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Push-to-talk: transcribe the clip, then run it through the analyst like a typed message."""
    await auth.run_in_org(run_id, ctx.org_id)
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
        result = await assistant.chat(ctx.org_id, run_id, transcript)
    except providers.ProviderError as e:
        raise HTTPException(502, f"assistant model error: {e}")
    return {"transcript": transcript, **result}


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


@router.post("/tts")
async def speak(body: SpeakIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    try:
        upstream = await voice.synthesize(body.text)
    except voice.VoiceError as e:
        raise HTTPException(502, str(e))
    return StreamingResponse(
        upstream.aiter_bytes(), media_type="audio/mpeg", background=BackgroundTask(upstream.aclose)
    )
