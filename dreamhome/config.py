from functools import lru_cache
from pathlib import Path

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
MEDIA_DIR = DATA_DIR / "media"
CACHE_DIR = DATA_DIR / "cache"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    anthropic_api_key: str = ""
    chat_model: str = "claude-sonnet-5-5"
    script_model: str = "claude-opus-5-5"

    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "a0L48LDiuC3RCS8LXA36"  # Olena

    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from_number: str = ""

    google_service_account_file: str = "secrets/google-sa.json"
    google_drive_root_folder_id: str = ""
    google_calendar_id: str = ""

    ig_user_id: str = ""
    ig_access_token: str = ""
    ig_app_secret: str = ""
    ig_verify_token: str = "change-me"
    graph_api_version: str = "v23.0"

    public_base_url: str = "http://localhost:8000"
    auto_approve: bool = False
    database_url: str = f"sqlite:///{DATA_DIR / 'app.db'}"

    @property
    def google_enabled(self) -> bool:
        return (ROOT / self.google_service_account_file).exists()


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_business() -> dict:
    with open(ROOT / "config" / "business.yaml") as f:
        return yaml.safe_load(f)


for d in (DATA_DIR, MEDIA_DIR, CACHE_DIR):
    d.mkdir(parents=True, exist_ok=True)
