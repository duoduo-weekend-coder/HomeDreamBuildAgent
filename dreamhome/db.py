from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, Session, SQLModel, create_engine, select

from dreamhome.config import get_settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Reel(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    project: str
    source_date: str = ""
    status: str = "draft"  # draft -> rendered -> approved -> published | skipped | failed
    source_files: list = Field(default_factory=list, sa_column=Column(JSON))
    script: dict = Field(default_factory=dict, sa_column=Column(JSON))
    caption: str = ""
    video_path: str = ""
    ig_media_id: str = ""
    ig_permalink: str = ""
    scheduled_for: Optional[datetime] = None
    error: str = ""
    created_at: datetime = Field(default_factory=utcnow)


class Lead(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    channel: str  # instagram | web
    external_id: str = Field(index=True)  # IG-scoped user id or web session id
    handle: str = ""
    fields: dict = Field(default_factory=dict, sa_column=Column(JSON))
    source_reel_id: Optional[int] = Field(default=None, foreign_key="reel.id")
    status: str = "new"  # new -> qualified -> booked | handed_off
    team_notified: bool = False
    agent_paused: bool = False
    last_inbound_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)


class Message(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    lead_id: int = Field(foreign_key="lead.id", index=True)
    role: str  # user | assistant
    content: str
    created_at: datetime = Field(default_factory=utcnow)


class Booking(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    lead_id: int = Field(foreign_key="lead.id")
    start: datetime
    end: datetime
    calendar_event_id: str = ""
    meet_link: str = ""
    created_at: datetime = Field(default_factory=utcnow)


_engine = None


def get_engine():
    global _engine
    if _engine is None:
        url = get_settings().database_url
        _engine = create_engine(url, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {})
        SQLModel.metadata.create_all(_engine)
    return _engine


def get_session() -> Session:
    return Session(get_engine())


__all__ = ["Reel", "Lead", "Message", "Booking", "get_session", "select", "utcnow"]
