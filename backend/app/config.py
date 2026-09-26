from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    database_url: str
    # Read-only role used by the SQL console; falls back to database_url in dev.
    readonly_database_url: str | None = None

    vultr_inference_api_key: str = ""
    vultr_inference_base_url: str = "https://api.vultrinference.com/v1"

    backboard_api_key: str = ""
    backboard_base_url: str = "https://app.backboard.io/api"
    backboard_assistant_id: str = ""

    elevenlabs_api_key: str = ""
    elevenlabs_agent_id: str = ""

    # Model the review assistant runs on (a Vultr model id).
    assistant_model: str = "glm-5.3"
    # Model used for LLM-as-judge scoring.
    judge_model: str = "deepseek-v4.1-flash"

    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
