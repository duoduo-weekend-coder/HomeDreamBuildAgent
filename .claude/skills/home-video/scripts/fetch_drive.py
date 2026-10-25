#!/usr/bin/env python3
"""Index and download a Google Drive folder (including one shared with you) through the Drive API.

Uses rclone (`brew install rclone`) with a read-only Google sign-in. The first run opens
a browser window to approve access; after that it runs unattended.

    # Read metadata + thumbnails only (no video download): writes <dest>/.index like scan_media.py
    python fetch_drive.py <folder URL> --index --dest media/drive-<id>
    # Download just the shots you picked (names or paths from the index), shrinking clips
    python fetch_drive.py <folder URL> --dest media/drive-<id> --only DJI_0019_D.MP4 DJI_0022_D.JPG --shrink
    # Everything
    python fetch_drive.py <folder URL> --list
    python fetch_drive.py <folder URL> --dest media/drive-<id> [--shrink]

Google Docs in the folder are read as plain text notes.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

REMOTE = "homevideo-gdrive"
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}
DRIVE_API = "https://www.googleapis.com/drive/v3"
FOLDER_MIME = "application/vnd.google-apps.folder"
DOC_MIME = "application/vnd.google-apps.document"
FIELDS = "nextPageToken,files(id,name,size,mimeType,createdTime,thumbnailLink,imageMediaMetadata,videoMediaMetadata)"


def folder_id(value: str) -> str:
    m = re.search(r"/folders/([A-Za-z0-9_-]+)", value) or re.search(r"[?&]id=([A-Za-z0-9_-]+)", value)
    return m.group(1) if m else value


def ensure_remote() -> None:
    if not shutil.which("rclone"):
        sys.exit("rclone is not installed. Run: brew install rclone")
    remotes = subprocess.run(["rclone", "listremotes"], capture_output=True, text=True).stdout.split()
    if f"{REMOTE}:" in remotes:
        return
    print("Opening a browser to approve read-only Google Drive access...", flush=True)
    subprocess.run(["rclone", "config", "create", REMOTE, "drive", "scope=drive.readonly"], check=True)


def rclone_args(fid: str) -> list[str]:
    return [f"{REMOTE}:", "--drive-root-folder-id", fid, "--drive-export-formats", "txt"]


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


# ---------------------------------------------------------------- Drive API (metadata only)


def access_token() -> str:
    """rclone's OAuth token; any rclone call against the remote refreshes it when expired."""
    subprocess.run(["rclone", "about", f"{REMOTE}:"], capture_output=True)
    cfg = json.loads(subprocess.run(["rclone", "config", "dump"], capture_output=True, text=True, check=True).stdout)
    return json.loads(cfg[REMOTE]["token"])["access_token"]


def api_get(url: str, token: str) -> bytes:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def walk(fid: str, token: str, prefix: str = "") -> list[dict]:
    """Every file under a folder, with `path` named the way rclone saves it ('/' in names becomes '／')."""
    files, page = [], None
    while True:
        params = {"q": f"'{fid}' in parents and trashed=false", "fields": FIELDS, "pageSize": 1000,
                  "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
        if page:
            params["pageToken"] = page
        data = json.loads(api_get(f"{DRIVE_API}/files?{urllib.parse.urlencode(params)}", token))
        for f in data.get("files", []):
            path = prefix + f["name"].replace("/", "／")
            if f["mimeType"] == FOLDER_MIME:
                files += walk(f["id"], token, path + "/")
            else:
                files.append({**f, "path": path})
        page = data.get("nextPageToken")
        if not page:
            return files


def index_remote(fid: str, dest: str) -> None:
    sys.path.insert(0, str(Path(__file__).parent))
    from scan_media import IMAGE_EXTS, parse_time, time_from_name, write_index

    token = access_token()
    root = Path(dest)
    index_dir = root / ".index"
    thumbs = index_dir / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    entries, notes, links = [], {}, {}
    for f in walk(fid, token):
        local = root / f["path"]
        if f["mimeType"] == DOC_MIME:
            text = api_get(f"{DRIVE_API}/files/{f['id']}/export?mimeType=text/plain", token)
            notes[f"{f['path']} (Google Doc)"] = text.decode("utf-8-sig", errors="replace").strip()
            continue
        ext = Path(f["name"]).suffix.lower()
        if ext not in IMAGE_EXTS | VIDEO_EXTS:
            continue
        img, vid = f.get("imageMediaMetadata") or {}, f.get("videoMediaMetadata") or {}
        taken = (parse_time(img.get("time")) or time_from_name(f["name"])
                 or datetime.fromisoformat(f["createdTime"].replace("Z", "+00:00")).astimezone().replace(tzinfo=None))
        e = {"file": str(local), "kind": "video" if ext in VIDEO_EXTS else "photo", "taken": taken.isoformat(timespec="seconds"),
             "width": (img or vid).get("width"), "height": (img or vid).get("height"),
             "drive_id": f["id"], "drive_path": f["path"], "size_bytes": int(f.get("size") or 0), "local": local.exists()}
        if e["kind"] == "video":
            e["duration"] = round(int(vid.get("durationMillis") or 0) / 1000, 2)
        loc = img.get("location") or {}
        if "latitude" in loc:
            e["lat"], e["lon"] = round(loc["latitude"], 6), round(loc["longitude"], 6)
        if img.get("cameraModel"):
            e["camera"] = img["cameraModel"]
        links[e["file"]] = f.get("thumbnailLink")
        entries.append(e)

    def make_thumb(e: dict) -> Path:
        out = thumbs / f"{Path(e['file']).stem}.jpg"
        if not out.exists():
            link = links.get(e["file"])
            if link:
                out.write_bytes(api_get(re.sub(r"=s\d+$", "=s1280", link), token))
            else:
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=gray:s=640x360",
                                "-frames:v", "1", str(out)], check=True)
        return out

    write_index(entries, notes, index_dir, f"Google Drive folder {fid} (metadata only; clips show one frame)", make_thumb)


# ---------------------------------------------------------------- downloads


def remote_files(fid: str) -> list[dict]:
    out = subprocess.run(["rclone", "lsjson", "-R", "--files-only", *rclone_args(fid)], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(out.stderr)
    return sorted(json.loads(out.stdout), key=lambda f: f["Path"])


def list_folder(fid: str) -> None:
    files = remote_files(fid)
    for f in files:
        print(f"{human(f['Size']):>9}  {f['Path']}")
    print(f"\n{len(files)} files, {human(sum(max(f['Size'], 0) for f in files))} total")


def shrink_video(src: Path, out: Path) -> None:
    """Re-encode to HEVC at the same resolution, ~20 Mbps for 4K: plenty for 1080p and vertical crops."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", str(src)],
        capture_output=True, text=True, check=True,
    )
    s = json.loads(probe.stdout)["streams"][0]
    ten_bit = "10" in s.get("pix_fmt", "")
    mbps = max(6, round(20 * s["width"] * s["height"] / (3840 * 2160)))
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0", "-movflags", "+use_metadata_tags+faststart",
        "-c:v", "hevc_videotoolbox", "-b:v", f"{mbps}M", "-tag:v", "hvc1",
        *(["-profile:v", "main10", "-pix_fmt", "p010le"] if ten_bit else ["-pix_fmt", "yuv420p"]),
        "-c:a", "aac", "-b:a", "160k", str(out),
    ], check=True)


def download_files(fid: str, dest: str, files: list[dict], shrink: bool, keep_free_gb: float = 4) -> None:
    """One file at a time, skipping files already there. With shrink, clips are re-encoded and originals deleted."""
    root = Path(dest)
    root.mkdir(parents=True, exist_ok=True)
    for n, f in enumerate(files, 1):
        final = root / f["Path"]
        if final.exists():
            continue
        free = shutil.disk_usage(root).free
        if free - max(f["Size"], 0) < keep_free_gb * 1024**3:
            sys.exit(f"Stopping: only {human(free)} free. Free up space and re-run to continue.")
        final.parent.mkdir(parents=True, exist_ok=True)
        print(f"[{n}/{len(files)}] {f['Path']} ({human(max(f['Size'], 0))})", flush=True)
        tmp = final.with_name(f".partial-{final.name}")
        subprocess.run(["rclone", "copyto", f"{REMOTE}:{f['Path']}", str(tmp), *rclone_args(fid)[1:]], check=True)
        if shrink and Path(f["Path"]).suffix.lower() in VIDEO_EXTS:
            shrunk = final.with_name(f".shrunk-{final.name}")
            shrink_video(tmp, shrunk)
            tmp.unlink()
            shrunk.rename(final)
            print(f"    shrunk to {human(final.stat().st_size)}", flush=True)
        else:
            tmp.rename(final)
    print(f"Done. Saved to {dest}")


def select(files: list[dict], wanted: list[str]) -> list[dict]:
    names = {Path(w).name for w in wanted}
    chosen = [f for f in files if f["Path"] in wanted or Path(f["Path"]).name in names]
    missing = names - {Path(f["Path"]).name for f in chosen}
    if missing:
        sys.exit(f"Not in the Drive folder: {', '.join(sorted(missing))}")
    return chosen


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Index or download a Google Drive folder via the Drive API (rclone)")
    parser.add_argument("folder", help="Drive folder URL or ID")
    parser.add_argument("--dest", default="media/raw", help="Local folder (default media/raw)")
    parser.add_argument("--list", action="store_true", help="Only list files and sizes")
    parser.add_argument("--index", action="store_true", help="Read metadata and thumbnails into <dest>/.index without downloading")
    parser.add_argument("--only", nargs="+", metavar="FILE", help="Download only these files (names or paths)")
    parser.add_argument("--shrink", action="store_true", help="Re-encode clips to HEVC as they arrive and delete originals (saves ~80%% disk)")
    args = parser.parse_args()
    ensure_remote()
    fid = folder_id(args.folder)
    if args.list:
        list_folder(fid)
    elif args.index:
        index_remote(fid, args.dest)
    else:
        files = remote_files(fid)
        download_files(fid, args.dest, select(files, args.only) if args.only else files, args.shrink)
