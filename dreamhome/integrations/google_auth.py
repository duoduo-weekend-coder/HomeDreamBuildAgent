"""Google credentials: prefer a user OAuth token (needed to invite attendees + create Meet links),
fall back to a service account (fine for Drive and for writing to a shared calendar)."""
from functools import lru_cache
from pathlib import Path

from dreamhome.config import ROOT, get_settings

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/calendar",
]
OAUTH_TOKEN = ROOT / "secrets" / "google-token.json"


@lru_cache
def credentials():
    if OAUTH_TOKEN.exists():
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        creds = Credentials.from_authorized_user_file(str(OAUTH_TOKEN), SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            OAUTH_TOKEN.write_text(creds.to_json())
        return creds
    sa = ROOT / get_settings().google_service_account_file
    if sa.exists():
        from google.oauth2 import service_account

        return service_account.Credentials.from_service_account_file(str(sa), scopes=SCOPES)
    return None


def is_user_oauth() -> bool:
    return Path(OAUTH_TOKEN).exists()
