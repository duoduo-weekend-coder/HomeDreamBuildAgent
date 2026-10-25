"""Google Calendar availability + booking. Without Google credentials it runs against the local
Booking table only, so the CRM flow is demoable offline."""
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from dreamhome.config import get_business, get_settings
from dreamhome.integrations.google_auth import credentials, is_user_oauth

log = logging.getLogger(__name__)


@dataclass
class Event:
    id: str
    start: datetime
    end: datetime
    meet_link: str = ""
    html_link: str = ""


def _cfg():
    b = get_business()["booking"]
    return b, ZoneInfo(b["timezone"])


def _service():
    creds = credentials()
    if creds is None or not get_settings().google_calendar_id:
        return None
    from googleapiclient.discovery import build

    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def _busy(svc, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    cal = get_settings().google_calendar_id
    busy = []
    if svc:
        resp = svc.freebusy().query(body={"timeMin": start.isoformat(), "timeMax": end.isoformat(),
                                          "items": [{"id": cal}]}).execute()
        busy = [(datetime.fromisoformat(b["start"].replace("Z", "+00:00")),
                 datetime.fromisoformat(b["end"].replace("Z", "+00:00")))
                for b in resp["calendars"][cal].get("busy", [])]
    # Always respect bookings we made ourselves (covers mock mode and API propagation lag).
    from dreamhome.db import Booking, get_session, select

    with get_session() as s:
        for bk in s.exec(select(Booking)).all():
            st, en = bk.start, bk.end
            if st.tzinfo is None:
                st, en = st.replace(tzinfo=ZoneInfo("UTC")), en.replace(tzinfo=ZoneInfo("UTC"))
            busy.append((st, en))
    return busy


def candidate_slots(now: datetime, busy: list[tuple[datetime, datetime]], limit: int = 5) -> list[datetime]:
    b, tz = _cfg()
    length = timedelta(minutes=b["meeting_minutes"])
    now = now.astimezone(tz)
    day = now.date() + timedelta(days=1)  # never offer same-day slots
    slots = []
    for _ in range(b["days_ahead"] * 2):
        if day.weekday() in b["workdays"]:
            t = datetime(day.year, day.month, day.day, b["business_hours"]["start"], tzinfo=tz)
            close = datetime(day.year, day.month, day.day, b["business_hours"]["end"], tzinfo=tz)
            day_slots = []
            while t + length <= close:
                if not any(t < be and t + length > bs for bs, be in busy):
                    day_slots.append(t)
                t += timedelta(hours=1)
            # spread the offer across days: at most 2 per day
            slots += day_slots[:1] + day_slots[len(day_slots) // 2:len(day_slots) // 2 + 1]
        if len(slots) >= limit:
            break
        day += timedelta(days=1)
    return slots[:limit]


def available_slots(limit: int = 5) -> list[datetime]:
    b, tz = _cfg()
    now = datetime.now(tz)
    svc = _service()
    busy = _busy(svc, now, now + timedelta(days=b["days_ahead"] * 2))
    return candidate_slots(now, busy, limit)


def create_event(start: datetime, summary: str, description: str, attendee_email: str | None) -> Event:
    b, tz = _cfg()
    start = start.astimezone(tz)
    end = start + timedelta(minutes=b["meeting_minutes"])
    svc = _service()
    if svc is None:
        log.warning("[Calendar mock] %s at %s", summary, start)
        return Event(id=f"mock-{uuid.uuid4().hex[:8]}", start=start, end=end, meet_link="https://meet.google.com/mock-link")

    body = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": start.isoformat(), "timeZone": b["timezone"]},
        "end": {"dateTime": end.isoformat(), "timeZone": b["timezone"]},
    }
    kwargs = {}
    if is_user_oauth():  # service accounts can't invite attendees or create Meet links
        if attendee_email:
            body["attendees"] = [{"email": attendee_email}]
        body["conferenceData"] = {"createRequest": {"requestId": uuid.uuid4().hex,
                                                    "conferenceSolutionKey": {"type": "hangoutsMeet"}}}
        kwargs = {"conferenceDataVersion": 1, "sendUpdates": "all"}
    ev = svc.events().insert(calendarId=get_settings().google_calendar_id, body=body, **kwargs).execute()
    return Event(id=ev["id"], start=start, end=end, meet_link=ev.get("hangoutLink", ""), html_link=ev.get("htmlLink", ""))
