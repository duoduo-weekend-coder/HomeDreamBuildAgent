import logging

from dreamhome.config import get_business, get_settings

log = logging.getLogger(__name__)
SENT: list[str] = []  # in-memory record for mock mode / dashboard


def notify_team(body: str) -> list[str]:
    s = get_settings()
    phones = get_business().get("team_phones", [])
    SENT.append(body)
    if not (s.twilio_account_sid and s.twilio_auth_token and s.twilio_from_number):
        log.warning("[SMS mock] to %s: %s", phones, body)
        return ["mock"]
    from twilio.rest import Client

    client = Client(s.twilio_account_sid, s.twilio_auth_token)
    return [client.messages.create(to=p, from_=s.twilio_from_number, body=body[:1500]).sid for p in phones]
