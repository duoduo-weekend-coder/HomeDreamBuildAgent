#!/usr/bin/env python3
"""Write the acquisition-agent metadata for a rendered video.

For output/x.mp4 this writes, next to it:
  x.metadata.json  a complete VideoMetadata snapshot (schemaVersion 1) for POST /api/content/posts
  x.metadata.md    the same information for people: timeline, raw sources, transcript, facts, checklist

Segment times are seconds in the edited video; rawRanges are seconds in the original footage.
Raw assets carry Google Drive file IDs when the footage came from fetch_drive.py --index.
Re-running after a change bumps `revision`; re-running with no change keeps it.

make_video.py calls this after every render. To (re)build metadata for an existing video:
    python video_metadata.py storyboards/build-30s.json output/build-30s-16x9.mp4 [--aspect 9:16]
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from make_video import (  # noqa: E402
    DEFAULT_STYLE, IMAGE_EXTS, apply_info, find_file, fit_durations, media_duration, shot_starts,
)

SCHEMA_VERSION = 1
SOURCE_SYSTEM = "home-video-studio"
KIND_LABELS = {"overview": "Home overview", "build": "Building process", "showcase": "Vibe final show",
               "drone": "Drone + process", "walkthrough": "Walk-through"}


def safe_id(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", text).strip("-")[:120] or "item"


def find_index_entry(path: Path) -> dict:
    """The scan/Drive index entry for a media file, found in the nearest .index/index.json above it."""
    resolved = path.resolve()
    for folder in resolved.parents:
        index = folder / ".index" / "index.json"
        if index.exists():
            for entry in json.loads(index.read_text()).get("media", []):
                if Path(entry["file"]).resolve() == resolved or (folder / entry["file"]).resolve() == resolved:
                    return entry
            return {}
    return {}


def describe_shot(shot: dict) -> str:
    parts = [shot.get("kicker"), shot.get("title"), shot.get("subtitle")]
    return " · ".join(str(p) for p in parts if p) or "Untitled shot"


def build(storyboard_path: Path, output: Path, aspect: str | None = None) -> dict:
    sb = json.loads(storyboard_path.read_text())
    shots = sb["shots"]
    info = sb.get("info", {})
    apply_info(shots, info)
    style = {**DEFAULT_STYLE, **sb.get("style", {})}
    total = float(sb["duration"])
    T = float(style["transition_duration"])
    durs = fit_durations(shots, total, T)
    starts = shot_starts(durs, T)
    aspect = aspect or sb.get("aspect", "16:9")

    job_dir = output.parent.parent if output.parent.name == "output" else output.parent
    content_id = safe_id(sb.get("content_id") or (f"{job_dir.name}-{output.stem}" if job_dir.name != "." else output.stem))

    raw_assets: dict[str, dict] = {}
    segments, notes = [], []
    for i, shot in enumerate(shots):
        src_value = shot.get("source")
        if src_value in (None, "card"):
            notes.append(f"{starts[i]:.2f}–{min(starts[i] + durs[i], total):.2f}s: title card "
                         f"\"{describe_shot(shot)}\" (no raw footage, so not a segment)")
            continue
        path = find_file(src_value, storyboard_path.parent)
        if path is None:
            raise FileNotFoundError(f"Shot {i + 1} source not found: {src_value}")
        entry = find_index_entry(path)
        asset_id = safe_id(path.stem)
        is_photo = path.suffix.lower() in IMAGE_EXTS
        if asset_id not in raw_assets:
            raw_assets[asset_id] = {
                "id": asset_id,
                "kind": "image" if is_photo else "video",
                "driveFileId": entry.get("drive_id"),
                "fileName": path.name,
                "description": describe_shot(shot),
                "capturedAt": entry.get("taken"),
                "shareable": False,
            }
        start, end = round(starts[i], 2), round(min(starts[i] + durs[i], total), 2)
        segment = {
            "id": f"seg-{len(segments) + 1:02d}",
            "startSeconds": start,
            "endSeconds": end,
            "description": describe_shot(shot),
            "rawAssetIds": [asset_id],
        }
        if shot.get("narration"):
            segment["transcript"] = shot["narration"]
        if not is_photo:
            raw_start = float(shot.get("start", 0))
            raw_len = (end - start) * float(shot.get("speed", 1.0))
            clip_len = entry.get("duration") or media_duration(path)  # a short clip holds its last frame
            segment["rawRanges"] = [{"rawAssetId": asset_id, "startSeconds": round(raw_start, 2),
                                     "endSeconds": round(min(raw_start + raw_len, clip_len), 2)}]
        if entry.get("taken"):
            segment["facts"] = [{
                "id": f"{segment['id']}-captured", "key": "footage_captured_on", "value": entry["taken"][:10],
                "verified": True, "customerVisible": False, "sourceAssetIds": [asset_id],
            }]
        segments.append(segment)

    kind = sb.get("kind", "")
    title = sb.get("title") or " · ".join(
        p for p in (info.get("home_name"), KIND_LABELS.get(kind, "Home video"), f"{total:g}s", aspect) if p)
    duration = round(media_duration(output), 2) if output.exists() else total
    return {
        "schemaVersion": SCHEMA_VERSION,
        "contentId": content_id,
        "revision": 1,
        "platform": "instagram",
        "instagramMediaId": None,
        "permalink": None,
        "title": title,
        "caption": sb.get("caption"),
        "durationSeconds": duration,
        "video": {"driveFileId": None, "fileName": output.name, "aspectRatio": aspect},
        "source": {"system": SOURCE_SYSTEM, "recordId": safe_id(f"{job_dir.name}-{output.name}")},
        "rawAssets": list(raw_assets.values()),
        "segments": segments,
        "facts": [],
        "demo": False,
    }, notes, info


def with_revision(payload: dict, json_path: Path) -> dict:
    """Keep the stored revision if nothing changed; otherwise bump it. Published IDs carry over."""
    if not json_path.exists():
        return payload
    old = json.loads(json_path.read_text())
    for key in ("instagramMediaId", "permalink"):
        payload[key] = payload[key] or old.get(key)
    if old.get("video", {}).get("driveFileId") and not payload["video"]["driveFileId"]:
        payload["video"]["driveFileId"] = old["video"]["driveFileId"]
    same = {k: v for k, v in old.items() if k != "revision"} == {k: v for k, v in payload.items() if k != "revision"}
    payload["revision"] = old.get("revision", 1) if same else old.get("revision", 1) + 1
    return payload


def markdown(payload: dict, notes: list[str], info: dict, output: Path) -> str:
    p = payload
    lines = [
        f"# {p['title']}",
        "",
        f"Video metadata for the acquisition agent. Generated {datetime.now():%Y-%m-%d %H:%M} by {SOURCE_SYSTEM}.",
        "",
        "## Identity",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| `contentId` | `{p['contentId']}` |",
        f"| `revision` | {p['revision']} |",
        f"| `platform` | {p['platform']} |",
        f"| `instagramMediaId` / `permalink` | {p['instagramMediaId'] or '— (add after publishing)'} / {p['permalink'] or '—'} |",
        f"| `durationSeconds` | {p['durationSeconds']} |",
        f"| Edited video | `{output.name}` ({p['video']['aspectRatio']}); `video.driveFileId`: {('`' + p['video']['driveFileId'] + '`') if p['video']['driveFileId'] else '— (not uploaded to Drive yet)'} |",
        f"| `source` | `{p['source']['system']}` / `{p['source']['recordId']}` |",
        f"| `demo` | {str(p['demo']).lower()} |",
        "",
        f"**Caption:** {p['caption'] or '— (none yet)'}",
        "",
        "## Timeline (edited video)",
        "",
        "| Segment | Edited time | What it shows | Narration | Raw source | Original footage range |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for s in p["segments"]:
        ranges = ", ".join(f"{r['startSeconds']}–{r['endSeconds']}s" for r in s.get("rawRanges", [])) or "still image"
        lines.append(f"| `{s['id']}` | {s['startSeconds']}–{s['endSeconds']}s | {s['description']} | "
                     f"{s.get('transcript', '')} | `{', '.join(s['rawAssetIds'])}` | {ranges} |")
    lines += [""] + [f"- {n}" for n in notes] + ([""] if notes else [])
    lines += [
        "Segments overlap by the cross-fade length where one shot dissolves into the next. Ranges are not frame-perfect.",
        "",
        "## Raw sources",
        "",
        "| ID | Kind | Google Drive file ID | Captured | File |",
        "| --- | --- | --- | --- | --- |",
    ]
    for a in p["rawAssets"]:
        lines.append(f"| `{a['id']}` | {a['kind']} | {('`' + a['driveFileId'] + '`') if a['driveFileId'] else '— (local file)'} | "
                     f"{(a.get('capturedAt') or '')[:16].replace('T', ' ')} | {a['fileName']} |")
    lines += [
        "",
        "Raw files stay private (`shareable: false`). Drive IDs are internal references, not customer links.",
        "",
        "## Facts",
        "",
        "- Each segment records its footage capture date from the camera's file metadata (`verified: true`, "
        "`customerVisible: false` until the team chooses to expose it).",
        "- Stage labels, titles and narration describe what the footage appears to show. They are **not** verified facts "
        "about dimensions, materials, permits, prices or schedule.",
    ]
    given = {k: v for k, v in info.items() if v}
    if given:
        lines.append("- Details entered in the web form (not stored as facts because no source document backs them yet): "
                     + "; ".join(f"{k.replace('_', ' ')}: {v}" for k, v in given.items()))
    lines += [
        "",
        "## Before publishing",
        "",
        "- [ ] Upload the edited video to Google Drive and set `video.driveFileId`.",
        "- [ ] After posting, set `instagramMediaId` and `permalink`. Re-running `video_metadata.py` keeps them and bumps `revision`.",
        "- [ ] Add any company-confirmed facts, each with the raw source that backs it.",
        "- [ ] Submit: `curl -X POST $ACQUISITION_URL/api/content/posts -H 'Content-Type: application/json' "
        f"-H \"Authorization: Bearer $WORKSPACE_TOKEN\" --data @{output.stem}.metadata.json`",
        "",
        "## Payload",
        "",
        "```json",
        json.dumps(p, indent=2),
        "```",
        "",
    ]
    return "\n".join(lines)


def write_metadata(storyboard_path: Path, output: Path, aspect: str | None = None) -> tuple[Path, Path]:
    payload, notes, info = build(storyboard_path, output, aspect)
    json_path = output.with_name(f"{output.stem}.metadata.json")
    md_path = output.with_name(f"{output.stem}.metadata.md")
    payload = with_revision(payload, json_path)
    json_path.write_text(json.dumps(payload, indent=2) + "\n")
    md_path.write_text(markdown(payload, notes, info, output))
    return json_path, md_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Write VideoMetadata JSON + markdown for a rendered video")
    parser.add_argument("storyboard", type=Path)
    parser.add_argument("output", type=Path, help="The rendered .mp4")
    parser.add_argument("--aspect", help="Aspect the video was rendered at, if it overrode the storyboard")
    args = parser.parse_args()
    try:
        j, m = write_metadata(args.storyboard, args.output, args.aspect)
        print(f"wrote {j} and {m}")
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
