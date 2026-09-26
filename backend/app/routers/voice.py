from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .. import auth, voice

router = APIRouter(prefix="/api", tags=["voice"])


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
