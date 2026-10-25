"""One reel end to end: photos -> selection -> script -> voice -> captions -> MP4 -> (publish)."""
import logging
import traceback
from pathlib import Path

from dreamhome.config import MEDIA_DIR, get_settings
from dreamhome.db import Reel, get_session, select
from dreamhome.integrations import instagram
from dreamhome.integrations.drive import Batch
from dreamhome.integrations.elevenlabs import Word, audio_duration, synthesize
from dreamhome.reels import renderer
from dreamhome.reels.captions import chunk_words
from dreamhome.reels.scriptwriter import Script, write_script
from dreamhome.reels.selector import select_shots

log = logging.getLogger(__name__)


def segment_starts(segments: list[str], words: list[Word]) -> list[float]:
    """Map each text segment to the start time of its first spoken word.
    TTS word tokens are split on whitespace exactly like the segments, so counting words lines up."""
    starts, k = [], 0
    for seg in segments:
        starts.append(words[min(k, len(words) - 1)].start if words else 0.0)
        k += len(seg.split())
    return starts


def shot_segments(script: Script) -> list[str]:
    """Text spoken over each shot: hook rides on shot 1, CTA on the last shot."""
    segs = list(script.narration)
    segs[0] = f"{script.hook} {segs[0]}".strip()
    segs[-1] = f"{segs[-1]} {script.cta}".strip()
    return segs


def full_caption(script: Script) -> str:
    tags = " ".join(t if t.startswith("#") else f"#{t}" for t in script.hashtags)
    return f"{script.caption}\n\n{tags}".strip()


def build_reel(batch: Batch, series: str = "") -> Reel:
    with get_session() as s:
        reel = Reel(project=batch.project, source_date=batch.date, status="draft")
        s.add(reel)
        s.commit()
        s.refresh(reel)
    workdir = MEDIA_DIR / f"reel_{reel.id}"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        images, selection = select_shots(batch.images, batch.project, batch.date, batch.notes)
        log.info("reel %s: selected %d shots (%s)", reel.id, len(images), selection.reason)
        script = write_script(batch.project, batch.date, batch.notes, [sh.shot_note for sh in selection.shots], series)

        segments = shot_segments(script)
        voice = workdir / "voice.mp3"
        words = synthesize(" ".join(segments), voice)
        out = MEDIA_DIR / f"reel_{reel.id}.mp4"
        renderer.render(
            images=images,
            segment_starts=segment_starts(segments, words),
            voice_duration=audio_duration(voice),
            captions=chunk_words(words),
            hook=script.hook,
            voice=voice,
            workdir=workdir,
            out=out,
        )
        selected_ids = [batch.source_ids[batch.images.index(p)] for p in images]
        updates = dict(status="approved" if get_settings().auto_approve else "rendered", script=script.model_dump(),
                       caption=full_caption(script), video_path=str(out), source_files=selected_ids)
    except Exception as e:  # keep the row so the dashboard shows what failed
        log.exception("reel %s failed", reel.id)
        updates = dict(status="failed", error=f"{e}\n{traceback.format_exc()[-1500:]}")
    with get_session() as s:
        reel = s.get(Reel, reel.id)
        for k, v in updates.items():
            setattr(reel, k, v)
        s.add(reel)
        s.commit()
        s.refresh(reel)
    return reel


def public_video_url(reel: Reel) -> str:
    return f"{get_settings().public_base_url.rstrip('/')}/media/{Path(reel.video_path).name}"


def publish(reel_id: int) -> Reel:
    with get_session() as s:
        reel = s.get(Reel, reel_id)
        if reel is None or not reel.video_path:
            raise ValueError(f"reel {reel_id} has no rendered video")
        try:
            result = instagram.publish_reel(public_video_url(reel), reel.caption)
            reel.ig_media_id, reel.ig_permalink, reel.status, reel.error = result["id"], result.get("permalink", ""), "published", ""
        except Exception as e:
            log.exception("publish %s failed", reel_id)
            reel.status, reel.error = "failed", str(e)[:2000]
        s.add(reel)
        s.commit()
        s.refresh(reel)
        return reel


def next_approved() -> Reel | None:
    with get_session() as s:
        return s.exec(select(Reel).where(Reel.status == "approved").order_by(Reel.id)).first()


def used_source_ids() -> set[str]:
    with get_session() as s:
        return {fid for r in s.exec(select(Reel)).all() for fid in (r.source_files or [])}
