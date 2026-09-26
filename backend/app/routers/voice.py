from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .. import assistant, providers, voice

router = APIRouter(prefix="/api", tags=["voice"])

MAX_AUDIO_BYTES = 10 * 1024 * 1024


@router.post("/runs/{run_id}/voice")
async def voice_turn(run_id: int, audio: UploadFile):
    """Push-to-talk: transcribe the clip, then run it through the analyst like a typed message."""
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
        result = await assistant.chat(run_id, transcript)
    except LookupError:
        raise HTTPException(404, "run not found")
    except providers.ProviderError as e:
        raise HTTPException(502, f"assistant model error: {e}")
    return {"transcript": transcript, **result}


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


@router.post("/tts")
async def speak(body: SpeakIn):
    try:
        upstream = await voice.synthesize(body.text)
    except voice.VoiceError as e:
        raise HTTPException(502, str(e))
    return StreamingResponse(
        upstream.aiter_bytes(), media_type="audio/mpeg", background=BackgroundTask(upstream.aclose)
    )
