#!/usr/bin/env python3
"""Read a folder of photos and clips so the shots can be picked for a storyboard.

For every photo and video it records capture time, length, resolution, GPS and drone
camera data (altitude, gimbal angle), and marks duplicates such as the DJI Fly app's
re-exports of the same shot. It saves a thumbnail per photo and a 4-frame strip per
clip, plus one contact sheet per shoot day, so a whole day can be reviewed in one image.
Text files (e.g. Google Docs exported by fetch_drive.py) are collected as notes.

    python scan_media.py media/raw

Writes <folder>/.index/index.json, index.md, thumbnails and sheet-<day>.jpg.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".dng", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
TEXT_EXTS = {".txt", ".md"}
SAME_SHOT_SECONDS = 3
TILE_W, TILE_H = 640, 360


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])} failed: {result.stderr[-800:]}")
    return result.stdout


def parse_time(value) -> datetime | None:
    if not value or not isinstance(value, str) or value.startswith("0000"):
        return None
    value = re.sub(r"(\.\d+)?([+-]\d\d:\d\d|Z)?$", "", value.strip())
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass
    return None


def time_from_name(name: str) -> datetime | None:
    m = re.search(r"(20\d{6})_?(\d{6})", name)
    return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S") if m else None


def read_metadata(files: list[Path]) -> dict[Path, dict]:
    if not shutil.which("exiftool"):
        print("note: exiftool not found (brew install exiftool); GPS and drone data will be missing", file=sys.stderr)
        return {}
    try:
        out = run(["exiftool", "-json", "-n", "-q", "-api", "QuickTimeUTC", *map(str, files)])
    except (OSError, RuntimeError) as e:
        print(f"note: exiftool failed ({e}); GPS and drone data will be missing", file=sys.stderr)
        return {}
    return {Path(d["SourceFile"]): d for d in json.loads(out)}


def probe_video(path: Path) -> dict:
    data = json.loads(run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,r_frame_rate,codec_name,pix_fmt,color_transfer:format=duration", "-of", "json", str(path),
    ]))
    s = data["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return {
        "width": s["width"], "height": s["height"], "fps": round(int(num) / int(den), 2),
        "codec": s["codec_name"], "duration": round(float(data["format"]["duration"]), 2),
        "hdr_or_log": s.get("color_transfer") in ("arib-std-b67", "smpte2084") or "10" in s.get("pix_fmt", ""),
    }


def thumbnail(entry: dict, src: Path, out_dir: Path) -> Path:
    out = out_dir / f"{src.stem}.jpg"
    if out.exists():
        return out
    if entry["kind"] == "photo":
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vf", "scale=640:-2", "-frames:v", "1", str(out)])
    else:
        d = entry["duration"]
        stamps = [d * p for p in (0.1, 0.37, 0.63, 0.9)]
        inputs, labels = [], []
        for k, t in enumerate(stamps):
            inputs += ["-ss", f"{t:.2f}", "-i", str(src)]
            labels.append(
                f"[{k}:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,"
                f"drawtext=text='{t:.0f}s':x=8:y=8:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6[f{k}]"
            )
        graph = ";".join(labels) + ";" + "".join(f"[f{k}]" for k in range(4)) + "xstack=inputs=4:layout=0_0|480_0|0_270|480_270"
        run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-frames:v", "1", str(out)])
    return out


def contact_sheet(entries: list[dict], out: Path) -> None:
    """Grid of every non-duplicate thumbnail for one shoot day, labelled with its index number."""
    tiles = []
    for e in entries:
        tile = out.parent / f"tile-{Path(e['thumb']).stem}.jpg"
        label = f"#{e['n']}  {e['kind']}{'  ' + str(round(e['duration'])) + 's' if e['kind'] == 'video' else ''}"
        run([
            "ffmpeg", "-y", "-loglevel", "error", "-i", e["thumb"], "-vf",
            f"scale={TILE_W}:{TILE_H}:force_original_aspect_ratio=decrease,pad={TILE_W}:{TILE_H + 34}:(ow-iw)/2:34:color=0x222222,"
            f"drawtext=text='{label}':x=8:y=5:fontsize=24:fontcolor=white",
            "-frames:v", "1", str(tile),
        ])
        tiles.append(tile)
    cols = min(4, len(tiles))
    rows = -(-len(tiles) // cols)
    inputs = sum((["-i", str(t)] for t in tiles), [])
    layout = "|".join(f"{(i % cols) * TILE_W}_{(i // cols) * (TILE_H + 34)}" for i in range(len(tiles)))
    graph = (
        "".join(f"[{i}:v]" for i in range(len(tiles))) + f"xstack=inputs={len(tiles)}:layout={layout}:fill=black"
        if len(tiles) > 1 else "[0:v]null"
    )
    run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-frames:v", "1", str(out)])
    for t in tiles:
        t.unlink()
    if rows > 6:
        print(f"note: {out.name} has {len(tiles)} tiles; zoom into parts of it when reviewing")


def scan(folder: Path) -> Path:
    index_dir = folder / ".index"
    thumbs = index_dir / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in folder.rglob("*") if p.is_file() and ".index" not in p.parts and not p.name.startswith("."))
    media = [p for p in files if p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS]
    meta = read_metadata(media) if media else {}

    entries = []
    for p in media:
        m = meta.get(p, {})
        kind = "video" if p.suffix.lower() in VIDEO_EXTS else "photo"
        e = {"file": str(p), "kind": kind}
        if kind == "video":
            e.update(probe_video(p))
        else:
            e.update({"width": m.get("ImageWidth"), "height": m.get("ImageHeight")})
        taken = (
            parse_time(m.get("DateTimeOriginal")) or parse_time(m.get("CreateDate")) or time_from_name(p.name)
            or datetime.fromtimestamp(p.stat().st_mtime)
        )
        e["taken"] = taken.isoformat(timespec="seconds")
        for key, field in (("lat", "GPSLatitude"), ("lon", "GPSLongitude"), ("altitude_m", "RelativeAltitude"),
                           ("gimbal_pitch", "GimbalPitchDegree"), ("camera", "Model")):
            if m.get(field) not in (None, ""):
                e[key] = round(m[field], 6) if isinstance(m[field], float) else m[field]
        if "lat" not in e and isinstance(m.get("GPSCoordinates"), str):
            parts = m["GPSCoordinates"].split()
            if len(parts) >= 2:
                e["lat"], e["lon"] = float(parts[0]), float(parts[1])
        entries.append(e)

    notes = {str(p): p.read_text(encoding="utf-8-sig", errors="replace").strip() for p in files if p.suffix.lower() in TEXT_EXTS}
    return write_index(entries, notes, index_dir, str(folder), lambda e: thumbnail(e, Path(e["file"]), thumbs))


def write_index(entries: list[dict], notes: dict, index_dir: Path, label: str, make_thumb) -> Path:
    """Mark duplicates, number the shots, make thumbnails and contact sheets, and write index.json / index.md.

    Shared by the local scan and fetch_drive.py --index (which reads Drive metadata without downloading)."""
    index_dir.mkdir(parents=True, exist_ok=True)
    # The same shot saved twice (camera original + app export): keep the larger one.
    entries.sort(key=lambda e: e["taken"])
    groups: list[list[dict]] = []
    for e in entries:
        for group in groups:
            first = group[0]
            if first["kind"] == e["kind"] and abs(
                (datetime.fromisoformat(e["taken"]) - datetime.fromisoformat(first["taken"])).total_seconds()
            ) <= SAME_SHOT_SECONDS and (e["kind"] == "photo" or abs(e["duration"] - first["duration"]) < 2):
                group.append(e)
                break
        else:
            groups.append([e])

    def quality(e: dict) -> tuple:
        name = Path(e["file"]).name
        return ((e.get("width") or 0) * (e.get("height") or 0), e.get("local", True), not name.lower().startswith("dji_fly"),
                e.get("size_bytes", 0), -len(name))

    for group in groups:
        best = max(group, key=quality)
        for e in group:
            if e is not best:
                e["duplicate_of"] = best["file"]

    n = 0
    for e in entries:
        if "duplicate_of" not in e:
            n += 1
            e["n"] = n
            e["thumb"] = str(make_thumb(e))

    days: dict[str, list[dict]] = {}
    for e in entries:
        if "duplicate_of" not in e:
            days.setdefault(e["taken"][:10], []).append(e)
    for day, items in days.items():
        contact_sheet(items, index_dir / f"sheet-{day}.jpg")

    index = {"folder": label, "days": {d: len(v) for d, v in days.items()}, "notes": notes, "media": entries}
    (index_dir / "index.json").write_text(json.dumps(index, indent=2))

    lines = [f"# Media index: {label}", ""]
    for day, items in days.items():
        lines += [f"## {day}  ({len(items)} shots, contact sheet: sheet-{day}.jpg)", "",
                  "| # | kind | time | length | size | altitude | gimbal | file |", "|---|---|---|---|---|---|---|---|"]
        for e in items:
            length = f"{e['duration']:.0f}s" if e["kind"] == "video" else ""
            size = f"{e.get('width')}x{e.get('height')}" + (f" {e['fps']:g}fps" if e.get("fps") else "")
            alt = f"{float(e['altitude_m']):.0f} m" if "altitude_m" in e else ""
            pitch = f"{float(e['gimbal_pitch']):.0f}°" if "gimbal_pitch" in e else ""
            where = "" if e.get("local", True) else " (in Drive only)"
            lines.append(f"| {e['n']} | {e['kind']} | {e['taken'][11:16]} | {length} | {size} | {alt} | {pitch} | {e['file']}{where} |")
        lines.append("")
    dupes = [e for e in entries if "duplicate_of" in e]
    if dupes:
        lines += [f"{len(dupes)} duplicates skipped (same shot saved twice): " + ", ".join(Path(e["file"]).name for e in dupes), ""]
    gps = [e for e in entries if "lat" in e]
    if gps:
        lat = sum(e["lat"] for e in gps) / len(gps)
        lon = sum(e["lon"] for e in gps) / len(gps)
        lines += [f"Approximate location (GPS average of {len(gps)} files): {lat:.5f}, {lon:.5f}", ""]
    for path, text in notes.items():
        lines += [f"## Notes: {path}", "", text or "(empty)", ""]
    (index_dir / "index.md").write_text("\n".join(lines))
    print(f"{len(entries) - len(dupes)} shots over {len(days)} days ({len(dupes)} duplicates); see {index_dir / 'index.md'}")
    return index_dir


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Index photos and clips for storyboarding")
    parser.add_argument("folder", type=Path, nargs="?", default=Path("media/raw"))
    args = parser.parse_args()
    try:
        scan(args.folder)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
