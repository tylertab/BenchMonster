from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    # .env holds production values (it's what deploy.sh ships); an optional,
    # gitignored .env.local overrides them for local development.
    model_config = SettingsConfigDict(env_file=(ROOT / ".env", ROOT / ".env.local"), extra="ignore")

    database_url: str

    vultr_inference_api_key: str = ""
    vultr_inference_base_url: str = "https://api.vultrinference.com/v1"

    backboard_api_key: str = ""
    backboard_base_url: str = "https://app.backboard.io/api"

    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = ""  # blank = voice.DEFAULT_VOICE
    elevenlabs_tts_model: str = "eleven_flash_v2_5"
    elevenlabs_stt_model: str = "scribe_v1"

    # Model the review assistant runs on (a Vultr model id).
    assistant_model: str = "glm-5.3"
    # Model used for LLM-as-judge scoring.
    judge_model: str = "deepseek-v4.1-flash"

    cors_origins: list[str] = ["http://localhost:3000"]

    # Session cookie over HTTPS only (set true in production).
    cookie_secure: bool = False
    # Base URL used in invitation links.
    public_url: str = "http://localhost:3000"

    # Fernet key that encrypts saved connection credentials.
    connection_secret_key: str = ""
    # Let connections reach private / loopback addresses (dev only: local S3, local Postgres).
    allow_private_connections: bool = False


settings = Settings()
