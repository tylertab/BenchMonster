"""ElevenLabs speech-to-text and text-to-speech for the analyst's voice mode."""

import re

import httpx

from .config import settings

BASE = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE = "hpp4J3VqNfWAUOO0d1Us"  # Bella
_client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10))


class VoiceError(Exception):
    pass


def _headers() -> dict:
    if not settings.elevenlabs_api_key:
        raise VoiceError("ELEVENLABS_API_KEY is not configured")
    return {"xi-api-key": settings.elevenlabs_api_key}


async def transcribe(audio: bytes, filename: str, content_type: str) -> str:
    resp = await _client.post(
        f"{BASE}/speech-to-text",
        headers=_headers(),
        data={"model_id": settings.elevenlabs_stt_model},
        files={"file": (filename, audio, content_type)},
    )
    if resp.status_code >= 400:
        raise VoiceError(f"speech-to-text failed: HTTP {resp.status_code} {resp.text[:200]}")
    return resp.json().get("text", "").strip()


def speakable(text: str) -> str:
    """Strip markdown so TTS doesn't read symbols aloud."""
    text = re.sub(r"`{3}.*?`{3}", "", text, flags=re.DOTALL)
    text = re.sub(r"[*_`#>|]", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()[:2500]


async def synthesize(text: str) -> httpx.Response:
    """Returns an open streaming response of MP3 audio; caller must close it."""
    req = _client.build_request(
        "POST",
        f"{BASE}/text-to-speech/{settings.elevenlabs_voice_id or DEFAULT_VOICE}/stream",
        headers=_headers(),
        params={"output_format": "mp3_44100_64"},
        json={"text": speakable(text), "model_id": settings.elevenlabs_tts_model},
    )
    resp = await _client.send(req, stream=True)
    if resp.status_code >= 400:
        body = await resp.aread()
        await resp.aclose()
        raise VoiceError(f"text-to-speech failed: HTTP {resp.status_code} {body[:200]!r}")
    return resp
