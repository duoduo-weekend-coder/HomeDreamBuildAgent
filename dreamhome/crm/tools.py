"""Tools the CRM agent can call. Each executor receives the lead id; they never trust slot times or
fields the model invents without validating them."""
import json
import logging
from datetime import datetime

from dreamhome.config import get_business
from dreamhome.db import Booking, Lead, get_session, utcnow
from dreamhome.integrations import gcal
from dreamhome.integrations.twilio_sms import notify_team as send_sms

log = logging.getLogger(__name__)


def lead_field_keys() -> list[str]:
    return [f["key"] for f in get_business()["lead_fields"]]


def required_keys() -> list[str]:
    return [f["key"] for f in get_business()["lead_fields"] if f.get("required")]


def tool_definitions() -> list[dict]:
    return [
        {
            "name": "update_lead",
            "description": "Save anything learned about the prospect. Pass only fields you learned; values are short plain-text summaries.",
            "input_schema": {
                "type": "object",
                "properties": {k: {"type": "string"} for k in lead_field_keys()},
                "additionalProperties": False,
            },
        },
        {
            "name": "check_availability",
            "description": "Get the next open consultation slots on the builder's calendar. Returns slot_iso values to use with book_meeting.",
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "book_meeting",
            "description": "Book a consultation call in one of the slots returned by check_availability, and alert the team.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "slot_iso": {"type": "string", "description": "Exact slot_iso from check_availability"},
                    "name": {"type": "string"},
                    "email": {"type": "string"},
                    "phone": {"type": "string"},
                },
                "required": ["slot_iso", "name", "email"],
                "additionalProperties": False,
            },
        },
        {
            "name": "notify_team",
            "description": "Text the sales team about a qualified lead who has not booked yet.",
            "input_schema": {
                "type": "object",
                "properties": {"summary": {"type": "string", "description": "One or two sentences: who, what project, where, when, how to reach them"}},
                "required": ["summary"],
                "additionalProperties": False,
            },
        },
        {
            "name": "handoff_to_human",
            "description": "Stop automated replies on this conversation and alert the team to take over.",
            "input_schema": {
                "type": "object",
                "properties": {"reason": {"type": "string"}},
                "required": ["reason"],
                "additionalProperties": False,
            },
        },
    ]


def _label(dt: datetime) -> str:
    return dt.strftime("%A %b %-d at %-I:%M %p").replace(":00 ", " ")


def lead_summary(lead: Lead) -> str:
    f = lead.fields or {}
    parts = [f.get("name") or lead.handle or "Someone", f.get("project_type"), f.get("size"), f.get("location"),
             f.get("timeline") and f"start {f['timeline']}", f.get("budget_range") and f"budget {f['budget_range']}",
             f.get("phone"), f.get("email")]
    via = f"via {lead.channel}" + (f" @{lead.handle}" if lead.handle else "")
    return ", ".join(p for p in parts if p) + f" ({via})"


def execute(name: str, args: dict, lead_id: int) -> str:
    with get_session() as s:
        lead = s.get(Lead, lead_id)

        if name == "update_lead":
            allowed = set(lead_field_keys())
            merged = dict(lead.fields or {})
            merged.update({k: str(v).strip() for k, v in args.items() if k in allowed and str(v).strip()})
            lead.fields = merged
            if lead.status == "new" and all(merged.get(k) for k in required_keys()):
                lead.status = "qualified"
            s.add(lead)
            s.commit()
            missing = [k for k in lead_field_keys() if not merged.get(k)]
            return json.dumps({"saved": True, "still_unknown": missing})

        if name == "check_availability":
            slots = gcal.available_slots()
            return json.dumps({"slots": [{"slot_iso": d.isoformat(), "label": _label(d)} for d in slots],
                               "timezone": get_business()["booking"]["timezone"]})

        if name == "book_meeting":
            try:
                start = datetime.fromisoformat(args["slot_iso"])
            except ValueError:
                return json.dumps({"error": "slot_iso is not a valid ISO datetime; call check_availability"})
            open_slots = {d.isoformat() for d in gcal.available_slots(limit=50)}
            if start.isoformat() not in open_slots:
                return json.dumps({"error": "That slot is no longer available. Call check_availability and offer new times."})
            merged = dict(lead.fields or {})
            merged.update({k: args[k] for k in ("name", "email", "phone") if args.get(k)})
            lead.fields = merged
            biz = get_business()
            ev = gcal.create_event(
                start,
                summary=f"{biz['name']} consultation: {merged.get('name')} ({merged.get('project_type', 'project')})",
                description="Booked by the Instagram assistant.\n\n" + "\n".join(f"{k}: {v}" for k, v in merged.items()),
                attendee_email=args.get("email"),
            )
            s.add(Booking(lead_id=lead.id, start=ev.start, end=ev.end, calendar_event_id=ev.id, meet_link=ev.meet_link))
            lead.status = "booked"
            lead.team_notified = True
            s.add(lead)
            s.commit()
            s.refresh(lead)
            send_sms(f"New booking {_label(ev.start)}: {lead_summary(lead)}. {ev.meet_link}".strip())
            return json.dumps({"booked": True, "when": _label(ev.start), "meet_link": ev.meet_link,
                               "note": "A calendar invite goes to their email."})

        if name == "notify_team":
            if lead.team_notified:
                return json.dumps({"sent": False, "reason": "team already notified about this lead"})
            send_sms(f"New lead: {lead_summary(lead)}. {args.get('summary', '')}")
            lead.team_notified = True
            s.add(lead)
            s.commit()
            return json.dumps({"sent": True})

        if name == "handoff_to_human":
            lead.agent_paused = True
            lead.status = "handed_off"
            s.add(lead)
            s.commit()
            send_sms(f"Needs a human: {lead_summary(lead)}. Reason: {args.get('reason', '')}")
            return json.dumps({"handed_off": True, "tell_user": "A team member will reply here shortly."})

    return json.dumps({"error": f"unknown tool {name}"})
