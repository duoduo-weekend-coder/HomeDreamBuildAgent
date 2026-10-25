#!/usr/bin/env python3
"""Local web interface for the home-video skill.

A form collects what to make; each submission becomes a job that runs a headless
Claude agent (`claude -p`) in this project with the home-video skill. The page shows
the agent's progress live, plays the finished videos, and sends feedback back to the
same agent session for revisions.

    python3 app/server.py          # then open http://localhost:8000
"""

import json
import mimetypes
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
APP = Path(__file__).resolve().parent
JOBS = ROOT / "jobs"
PORT = int(os.getenv("PORT", "8000"))
SKILL_SCRIPTS = ".claude/skills/home-video/scripts"

# The agent may only edit files in this project and run the video tools.
ALLOWED_TOOLS = [
    "Read", "Write", "Edit", "Glob", "Grep", "Skill",
    f"Bash(python3 {SKILL_SCRIPTS}/*)",
    "Bash(ffmpeg *)", "Bash(ffprobe *)", "Bash(exiftool *)", "Bash(mdls *)",
    "Bash(mkdir *)", "Bash(ls *)", "Bash(cp *)", "Bash(mv *)", "Bash(df *)", "Bash(head *)", "Bash(cat *)",
]

# The 4 video templates the customer picks from; defined once in the skill and shared with the web page.
TEMPLATES = json.loads((ROOT / ".claude/skills/home-video/templates/catalog.json").read_text())
KINDS = {k: t["label"] for k, t in TEMPLATES.items()} | {"overview": "Overview (older jobs)"}
MUSIC_DIR = ROOT / "assets/music"


def music_library() -> dict:
    """Tracks in assets/music that are on this Mac (from library.json, see music_library.py) and the
    recommended track per template."""
    try:
        lib = json.loads((MUSIC_DIR / "library.json").read_text())
    except (OSError, ValueError):
        return {"tracks": [], "defaults": {}}
    tracks = [{"file": name, "title": t.get("title", name), "artist": t.get("artist", ""), "bpm": t.get("bpm"),
               "tone": t.get("tone", ""), "energy": t.get("energy", ""), "suits": t.get("suits", []),
               "license": t.get("license", "unknown"), "starts": t.get("starts", {})}
              for name, t in lib.get("tracks", {}).items() if (MUSIC_DIR / name).exists()]
    files = {t["file"] for t in tracks}
    return {"tracks": tracks, "defaults": {k: v for k, v in lib.get("defaults", {}).items() if v in files}}
ASPECTS = {"16:9": "16x9", "9:16": "9x16", "1:1": "1x1", "4:5": "4x5"}
VOICES = {"edge", "elevenlabs", "openai", "say", "auto"}

jobs: dict[str, "Job"] = {}
work_queue: "queue.Queue[tuple[Job, str]]" = queue.Queue()
lock = threading.Lock()


ENV_FILE = ROOT / ".env"
ELEVEN_API = "https://api.elevenlabs.io/v1"
# The studio's default narrator. Always offered in Voice settings, even if the key can't list the account's voices.
DEFAULT_VOICE = {"id": "a0L48LDiuC3RCS8LXA36", "name": "Olena", "category": "default", "labels": "studio default", "preview": None}


def read_env_file() -> dict:
    values = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() and not line.lstrip().startswith("#"):
                values[key.strip()] = value.strip().strip('"')
    return values


def write_env_file(updates: dict) -> None:
    values = {**read_env_file(), **updates}
    ENV_FILE.write_text("".join(f"{k}={v}\n" for k, v in values.items() if v))
    ENV_FILE.chmod(0o600)


def eleven_request(req: urllib.request.Request, permission: str, timeout: int = 20) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(body)["detail"]
            message = detail.get("message") if isinstance(detail, dict) else str(detail)
        except (ValueError, KeyError, TypeError):
            message = body[:200]
        hint = f" Check the key's permissions include {permission}." if e.code in (401, 403) and "permission" in body else ""
        raise ValueError(f"ElevenLabs said: {message}.{hint}") from None


def eleven_get(path: str, key: str) -> dict:
    return eleven_request(urllib.request.Request(f"{ELEVEN_API}{path}", headers={"xi-api-key": key}), "Voices (read)")


AUDIO_EXTS = {"audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3"}
MAX_AUDIO_BYTES = 20 * 1024 * 1024


def transcribe(audio: bytes, content_type: str, key: str) -> str:
    """Speech to text with ElevenLabs Scribe, for the page's mic buttons where the browser can't do it itself."""
    mime = content_type.split(";")[0].strip() or "audio/webm"
    boundary = uuid.uuid4().hex
    fields = {"model_id": "scribe_v1", "tag_audio_events": "false"}
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()
    ) + (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.{AUDIO_EXTS.get(mime, "webm")}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{ELEVEN_API}/speech-to-text", data=body, method="POST",
                                 headers={"xi-api-key": key, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    return eleven_request(req, "Speech to Text", timeout=60).get("text", "").strip()


def agent_env() -> dict:
    """A clean environment so the agent runs as a standalone CLI with the user's own login."""
    keep = ("HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL", "ELEVENLABS_API_KEY", "OPENAI_API_KEY",
            "GEMINI_API_KEY", "MINIMAX_API_KEY")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(read_env_file())  # API keys saved from the settings panel
    home = os.environ.get("HOME", "")
    env["PATH"] = f"{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return env


def read_metadata(path: Path) -> dict:
    """Caption, narration lines and shot list from a video's metadata file, for the page to show as text."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    files = {a.get("id"): a.get("fileName", "") for a in data.get("rawAssets", [])}
    segments = data.get("segments", [])
    return {
        "caption": data.get("caption") or "",
        "duration": data.get("durationSeconds"),
        "narration": [s["transcript"] for s in segments if s.get("transcript")],
        "shots": [{"start": s.get("startSeconds"), "end": s.get("endSeconds"), "text": s.get("description", ""),
                   "files": [files.get(i, i) for i in s.get("rawAssetIds", [])]} for s in segments],
    }


def make_poster(video: Path) -> Path | None:
    """A still from one second in, cached next to the video, used as the player poster and job thumbnail."""
    poster = video.parent / ".posters" / f"{video.stem}.jpg"
    if poster.exists() and poster.stat().st_mtime >= video.stat().st_mtime:
        return poster
    ffmpeg = shutil.which("ffmpeg", path=agent_env()["PATH"])
    if not ffmpeg:
        return None
    poster.parent.mkdir(exist_ok=True)
    tmp = poster.with_name(f".{video.stem}.{uuid.uuid4().hex[:6]}.jpg")
    for at in ("1", "0"):  # very short or still-rendering files may not reach one second
        subprocess.run([ffmpeg, "-v", "error", "-y", "-ss", at, "-i", str(video), "-frames:v", "1",
                        "-vf", "scale=540:-2", "-q:v", "4", str(tmp)], capture_output=True, timeout=30)
        if tmp.exists() and tmp.stat().st_size:
            tmp.replace(poster)
            return poster
    tmp.unlink(missing_ok=True)
    return None


def tool_stage(name: str, inp: dict, rendered: bool) -> int:
    """Which step of the job a tool call belongs to, for the progress shown while the customer waits:
    1 reading footage, 2 choosing shots, 3 writing the storyboard, 4 rendering, 5 checking.
    Frames saved to checks/ before the first render are of source clips, so they count as choosing shots."""
    target = inp.get("command", "") if name == "Bash" else inp.get("file_path", "")
    if "summary.md" in target or ".metadata." in target or (rendered and "/checks/" in target):
        return 5
    if "make_video.py" in target:
        return 4
    if "/storyboards/" in target:
        return 3
    if "/checks/" in target or "--only" in target or "/thumbs/" in target or (name in ("Write", "Edit") and "shots.md" in target):
        return 2
    return 1


class Job:
    def __init__(self, job_id: str, request: dict):
        self.id = job_id
        self.dir = JOBS / job_id
        self.request = request
        self.status = "queued"
        self.session_id: str | None = None
        self.created = time.time()
        self.cost = 0.0
        self.events: list[dict] = []
        self.proc: subprocess.Popen | None = None

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        data = {k: getattr(self, k) for k in ("id", "request", "status", "session_id", "created", "cost")}
        (self.dir / "job.json").write_text(json.dumps(data, indent=2))

    def add(self, kind: str, text: str = "", **extra) -> None:
        event = {"kind": kind, "text": text, "t": time.time(), **extra}
        with lock:
            self.events.append(event)
        with open(self.dir / "events.jsonl", "a") as f:
            f.write(json.dumps(event) + "\n")

    def outputs(self) -> list[dict]:
        out = self.dir / "output"
        if not out.exists():
            return []
        items = []
        for p in sorted(out.glob("*.mp4")):
            version = int(p.stat().st_mtime)
            item = {"name": p.name, "url": f"/files/jobs/{self.id}/output/{p.name}?v={version}",
                    "poster": f"/api/poster/{self.id}/{p.name}?v={version}", "size": p.stat().st_size}
            for key, suffix in (("metadata_md", ".metadata.md"), ("metadata_json", ".metadata.json")):
                meta = p.with_name(p.stem + suffix)
                if meta.exists():
                    item[key] = f"/files/jobs/{self.id}/output/{meta.name}?v={int(meta.stat().st_mtime)}"
            item.update(read_metadata(p.with_name(p.stem + ".metadata.json")))
            items.append(item)
        return items

    def voice_characters(self) -> dict:
        """Characters sent to each voice service, from the usage log make_video.py keeps per output folder."""
        totals: dict[str, int] = {}
        log = self.dir / "output" / ".cache" / "usage.jsonl"
        if log.exists():
            for line in log.read_text().splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                totals[entry["provider"]] = totals.get(entry["provider"], 0) + int(entry.get("characters", 0))
        return totals

    def summary(self) -> str:
        p = self.dir / "summary.md"
        return p.read_text() if p.exists() else ""

    @classmethod
    def load(cls, folder: Path) -> "Job":
        data = json.loads((folder / "job.json").read_text())
        job = cls(data["id"], data["request"])
        job.status, job.session_id = data["status"], data.get("session_id")
        job.created, job.cost = data.get("created", 0), data.get("cost", 0.0)
        if (folder / "events.jsonl").exists():
            job.events = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines() if line]
        if job.status in ("queued", "running"):
            job.status = "interrupted"
        return job


# ---------------------------------------------------------------- prompts


def drive_folder_id(source: str) -> str | None:
    m = re.search(r"/folders/([A-Za-z0-9_-]+)", source)
    return m.group(1) if m else None


def outside_source_dir(source: str) -> Path | None:
    """A local footage folder outside the project. The agent needs it added with --add-dir: in dontAsk mode,
    reads and shell commands that touch paths outside the working directory are otherwise denied."""
    if drive_folder_id(source):
        return None
    path = Path(source).expanduser()
    if not path.is_absolute():
        path = ROOT / path
    path = path.resolve()
    if not path.exists() or path == ROOT or ROOT in path.parents:
        return None
    return path if path.is_dir() else path.parent


def first_prompt(job: Job) -> str:
    r = job.request
    source = r["source"].strip()
    fid = drive_folder_id(source)
    if fid:
        media = f"media/drive-{fid}"
        source_steps = f"""Footage is in this Google Drive folder: {source}
Don't download everything. First read it from Drive metadata:
  python3 {SKILL_SCRIPTS}/fetch_drive.py {source} --index --dest {media}
(skip this if {media}/.index/index.json exists and was written today). That writes {media}/.index/index.md and
contact sheets with one thumbnail per shot. Review them, pick shots, then download only those:
  python3 {SKILL_SCRIPTS}/fetch_drive.py {source} --dest {media} --shrink --only <file names>
Files already on disk are skipped. To choose `start` points in a downloaded clip, grab a few frames with ffmpeg;
don't re-run scan_media.py over {media}, which would replace the Drive index."""
    else:
        media = source
        source_steps = f"""Footage is already on this Mac in: {source}
Scan it with scan_media.py (reuse {media}/.index if it exists and the file count matches), then run
similar_shots.py on it (reuse {media}/.index/scenes.json if it exists)."""

    videos = []
    for kind in r["kinds"]:
        for length in r["lengths"]:
            for aspect in r["aspects"]:
                videos.append(f"- {KINDS[kind]}, {length}s, {aspect} -> jobs/{job.id}/output/{kind}-{length}s-{ASPECTS[aspect]}.mp4")
    template_text = "\n\n".join(template_brief(k, r["lengths"], r.get("music", "auto")) for k in r["kinds"] if k in TEMPLATES)
    highlight = r.get("highlight", "").strip()

    info = {k: v.strip() for k, v in r.get("info", {}).items() if v and v.strip()}
    info_text = "\n".join(f"- {k}: {v}" for k, v in info.items()) or "- none given (leave every info field empty)"
    notes = r.get("notes", "").strip()

    return f"""Use the home-video skill to make finished marketing videos. You are running unattended from a web form,
so nobody can answer questions: make sensible choices yourself and explain them in the summary.

{source_steps}
Media folder: {media}. If {media}/shots.md exists, reuse it; otherwise write it after reviewing the contact sheets.
Reuse any catalog.md in the media folder or its subfolders (hand-checked quality grades, never-post list,
privacy crop/blur values) instead of re-tagging those shots. For shots it doesn't cover, give each shot in shots.md a
room or construction stage, a quality grade (hero/good/ok/weak/exclude) and any problems (faces, blur, signs,
house numbers, clutter, reflections).
Storyboards: one representative shot per scene, never weak or exclude shots, hero shots for the hook and the final
slot; fix privacy problems with the shot's `crop`/`blur` fields or leave the shot out. Photos are straightened and
framed automatically, and captions are burned in word by word from the voiceover.

Make these videos (exact output paths):
{chr(10).join(videos)}

Each video follows one of the studio's templates. Start from the template file named below, copied into
jobs/{job.id}/storyboards/, and keep its story order, pacing and text style:

{template_text}

Write storyboards to jobs/{job.id}/storyboards/ and render each with -o set to the path above.
Every video gets a voiceover and subtitles: keep "captions": true and write each shot's "narration" for the footage
actually on screen (the template lines are placeholders; keep about the same length so it fits). Never end on a colour
"card": the last shot is real footage carrying the template's closing text ({{slogan}} above {{website}}, with {{cta}} "DM us, link in bio" beneath) and the closing
line "{{slogan}}. Find us at {{website_spoken}}." (brand values come from templates/brand.json; leave the placeholders in).
Give every storyboard a "caption", the post description: 2-3 sentences on what the video shows (only true things),
then the slogan and the website on their own line, then 3-5 hashtags. Put each video's narration script and
description in the summary. Rendering also writes <video>.metadata.json and <video>.metadata.md (the acquisition-agent
metadata contract) next to each video; check they exist.

Home details for the storyboard `info` block (use only these, never invent any):
{info_text}

Voice: set "voice": {{"provider": "{r.get('voice', 'edge')}"}} in every storyboard.
{highlight_rule(highlight)}
{f"Extra instructions from the user: {notes}" if notes else ""}

Rules for this unattended run:
- Run every command from the project root as one plain command: no `cd`, no `&&` chains. Only the home-video
  scripts, ffmpeg/ffprobe, exiftool and basic file commands are allowed.
- Do not use --ai (paid AI clips).
- Prefer real video clips (drone moves, pans) over stills wherever a good clip exists for a slot: these are videos
  stitched together. Use stills only to fill stages that have no usable clip, and pick each clip's best moment with `start`.
- If the footage can't support a requested video (e.g. no interior shots for a room tour), make the best honest version
  and say so in the summary.
- Check frames of every finished video before you finish. Save check images in jobs/{job.id}/checks/ (you can't
  delete files, and that keeps them out of the way).

Finish by writing jobs/{job.id}/summary.md with: each video file and its metadata files, its narration script and
caption, which footage you used, and anything the user should know. Your final reply: 2-4 plain sentences for the person waiting on the web page."""


def feedback_prompt(job: Job, text: str) -> str:
    return f"""The user watched the videos and sent this feedback from the web page:

\"\"\"{text}\"\"\"

Update the storyboards in jobs/{job.id}/storyboards/ and re-render the affected videos to the same output paths
(overwrite them). Rendering updates each video's metadata files and bumps their revision. Same rules as before. Update jobs/{job.id}/summary.md. Final reply: 1-3 plain sentences."""


# ---------------------------------------------------------------- agent runner


def describe_tool(name: str, inp: dict) -> str:
    if name == "Bash":
        return inp.get("description") or inp.get("command", "")[:160]
    if name in ("Read", "Write", "Edit"):
        path = inp.get("file_path", "")
        return f"{name} {path.replace(str(ROOT) + '/', '')}"
    if name == "Skill":
        return f"Loaded skill {inp.get('skill', '')}"
    return f"{name} {json.dumps(inp)[:120]}"


def run_agent(job: Job, prompt: str) -> None:
    cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--permission-mode", "dontAsk", "--allowedTools", *ALLOWED_TOOLS]
    extra_dir = outside_source_dir(job.request.get("source", ""))
    if extra_dir:
        cmd += ["--add-dir", str(extra_dir)]
    if job.session_id:
        cmd += ["--resume", job.session_id]
    job.status = "running"
    job.save()
    job.add("status", "Agent started")
    try:
        job.proc = subprocess.Popen(cmd, cwd=ROOT, env=agent_env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, start_new_session=True)
    except FileNotFoundError:
        job.status = "failed"
        job.add("error", "The `claude` command was not found. Install Claude Code and sign in with `claude` once.")
        job.save()
        return

    final, rendered = None, False
    for line in job.proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            job.add("log", line[:500])
            continue
        kind = e.get("type")
        if kind == "system" and e.get("subtype") == "init":
            job.session_id = e.get("session_id")
            job.save()
        elif kind == "assistant":
            for c in e.get("message", {}).get("content", []):
                if c.get("type") == "text" and c["text"].strip():
                    job.add("say", c["text"].strip())
                elif c.get("type") == "tool_use":
                    stage = tool_stage(c["name"], c.get("input", {}), rendered)
                    rendered = rendered or stage == 4
                    job.add("tool", describe_tool(c["name"], c.get("input", {})), tool=c["name"], stage=stage)
        elif kind == "user":
            content = e.get("message", {}).get("content", [])
            for c in content if isinstance(content, list) else []:
                if c.get("type") == "tool_result" and c.get("is_error"):
                    text = c.get("content")
                    text = text if isinstance(text, str) else json.dumps(text)
                    job.add("tool_error", text[:400])
        elif kind == "result":
            final = e
    code = job.proc.wait()
    job.proc = None

    if job.status == "cancelled":
        job.add("status", "Cancelled")
    elif final and final.get("subtype") == "success" and not final.get("is_error"):
        job.cost += final.get("total_cost_usd") or 0
        job.status = "done"
        job.add("done", final.get("result", ""), seconds=round((final.get("duration_ms") or 0) / 1000))
    else:
        job.status = "failed"
        reason = (final or {}).get("result") or (final or {}).get("subtype") or f"agent exited with code {code}"
        job.add("error", str(reason)[:1000])
    job.save()


def worker() -> None:
    while True:
        job, prompt = work_queue.get()
        if job.status == "cancelled":
            continue
        try:
            run_agent(job, prompt)
        except Exception as ex:  # keep the worker alive whatever happens to one job
            job.status = "failed"
            job.add("error", f"Server error: {ex}")
            job.save()


# ---------------------------------------------------------------- HTTP


def music_line(kind: str, choice: str) -> str:
    """Prompt line naming the track for this template: the user's pick, none, or the template's recommended track."""
    if choice == "none":
        return '\nMusic: none, the user chose no music. Set "music": null.'
    track = music_library()["defaults"].get(kind) if choice == "auto" else choice
    if track:
        who = "the user's choice" if choice != "auto" else "this template's recommended track"
        return (f'\nMusic: set "music": "assets/music/{track}" ({who}). Leave out music_start; the renderer starts '
                "at the track's best excerpt.")
    if TEMPLATES[kind].get("music"):
        return f"\nMusic: no track in assets/music suits this template ({TEMPLATES[kind]['music']}); render without music and say so."
    return ""


def template_brief(kind: str, lengths: list[int], music: str = "auto") -> str:
    t = TEMPLATES[kind]
    files = ", ".join(f".claude/skills/home-video/templates/{t['files'][str(n)]}" for n in lengths)
    story = "\n".join(f"  {i}. {line}" for i, line in enumerate(t["story"], 1))
    return (f"Template \"{t['label']}\" ({kind}): {t['goal']}\n"
            f"Start from: {files}\nMedia to use: {t['media']}\nStory:\n{story}\n"
            f"Voiceover: {t['voice']}\nPace: {t['pace']}"
            + music_line(kind, music)
            + (f"\nStyle reference: {t['reference']} (summarised in docs/reference-styles.md)." if t.get("reference") else ""))


def highlight_rule(highlight: str) -> str:
    if not highlight:
        return "No highlight message was given: leave info.highlight empty."
    return f"""Highlight message from the user (MUST appear in every video): "{highlight}"
- Put it in info.highlight exactly as written; the templates show it as the opening title and speak it in the
  first narration line. Keep both, and don't add claims the user didn't make.
- After rendering, check a frame shows the message in full (not cut off) and mention that in the summary."""


def job_title(request: dict) -> str:
    """The home name, else its location, else the footage folder's name."""
    info = request.get("info", {})
    if info.get("home_name") or info.get("location"):
        return info.get("home_name") or info["location"]
    source = request.get("source", "").strip()
    if drive_folder_id(source):
        return "Drive footage"
    name = re.sub(r"[_-]+", " ", Path(source).expanduser().name).strip()
    return name[:1].upper() + name[1:] if name else "Untitled home"


def job_stage(job: Job) -> int:
    """How far the current run has got (see tool_stage), for the house drawn on a running job's tile."""
    stage = 0
    for e in job.events:
        if e["kind"] == "feedback" or (e["kind"] == "status" and e["text"] == "Queued"):
            stage = 0
        elif e["kind"] == "status" and e["text"] == "Agent started":
            stage = 1
        elif e["kind"] == "tool":
            stage = max(stage, e.get("stage", 1))
    return stage


def job_summary(job: Job) -> dict:
    r = job.request
    outputs = job.outputs()
    return {"id": job.id, "status": job.status, "created": job.created, "cost": round(job.cost, 2),
            "elevenlabs_characters": job.voice_characters().get("elevenlabs", 0),
            "title": job_title(r), "home": r.get("info", {}).get("home_name") or r.get("info", {}).get("location") or "",
            "kinds": r["kinds"], "lengths": r["lengths"], "aspects": r["aspects"],
            "videos": len(outputs), "poster": outputs[0]["poster"] if outputs else None, "stage": job_stage(job)}


def validate(body: dict) -> dict:
    source = str(body.get("source", "")).strip()
    if not source:
        raise ValueError("Add a Google Drive folder link or a folder path.")
    if not drive_folder_id(source) and not (ROOT / source).exists() and not Path(source).expanduser().exists():
        raise ValueError("That isn't a Google Drive folder link or an existing folder on this Mac.")
    kinds = [k for k in body.get("kinds", []) if k in TEMPLATES]
    lengths = [int(n) for n in body.get("lengths", []) if int(n) in (15, 30)]
    aspects = [a for a in body.get("aspects", []) if a in ASPECTS]
    if not (kinds and lengths and aspects):
        raise ValueError("Pick at least one template, length and format.")
    voice = body.get("voice", "edge") if body.get("voice") in VOICES else "edge"
    info = {k: str(body.get("info", {}).get(k, ""))[:120] for k in ("home_name", "location", "specs", "builder")}
    music = str(body.get("music", "auto"))
    if music not in ("auto", "none") and music not in {t["file"] for t in music_library()["tracks"]}:
        raise ValueError("That music track isn't in assets/music.")
    return {"source": source, "kinds": kinds, "lengths": lengths, "aspects": aspects, "voice": voice,
            "info": info, "highlight": str(body.get("highlight", "")).strip()[:120], "music": music,
            "notes": str(body.get("notes", ""))[:2000]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, data, status: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if url.path == "/":
            return self.send_file(APP / "index.html")
        if parts[:2] == ["api", "jobs"] and len(parts) == 2:
            with lock:
                items = sorted(jobs.values(), key=lambda j: -j.created)
            return self.send_json([job_summary(j) for j in items])
        if parts[:2] == ["api", "jobs"] and len(parts) == 3:
            job = jobs.get(parts[2])
            if not job:
                return self.send_json({"error": "No such job"}, 404)
            since = int(parse_qs(url.query).get("since", ["0"])[0])
            with lock:
                events = job.events[since:]
            return self.send_json({**job_summary(job), "request": job.request, "events": events, "next": since + len(events),
                                   "outputs": job.outputs(), "summary": job.summary()})
        if parts[:2] == ["api", "poster"] and len(parts) == 4:
            job = jobs.get(parts[2])
            video = job.dir / "output" / Path(unquote(parts[3])).name if job else None
            poster = make_poster(video) if video and video.suffix == ".mp4" and video.is_file() else None
            if not poster:
                return self.send_json({"error": "No poster"}, 404)
            return self.send_file(poster, cache=True)  # the URL changes whenever the video does
        if parts[:1] == ["assets"] and len(parts) == 2:
            target = APP / "assets" / Path(unquote(parts[1])).name
            if not target.is_file():
                return self.send_json({"error": "Not found"}, 404)
            return self.send_file(target, cache=True)
        if parts == ["api", "templates"]:
            return self.send_json(TEMPLATES)
        if parts == ["api", "music"]:
            return self.send_json(music_library())
        if parts[:3] == ["api", "music", "file"] and len(parts) == 4:
            name = unquote(parts[3])  # only tracks listed in the library, so no path tricks
            if name not in {t["file"] for t in music_library()["tracks"]}:
                return self.send_json({"error": "No such track"}, 404)
            return self.send_file(MUSIC_DIR / name)
        if parts == ["api", "settings"]:
            env = read_env_file()
            return self.send_json({"elevenlabs_configured": bool(env.get("ELEVENLABS_API_KEY")),
                                   "elevenlabs_voice_id": env.get("ELEVENLABS_VOICE_ID") or DEFAULT_VOICE["id"],
                                   "elevenlabs_voice_name": env.get("ELEVENLABS_VOICE_NAME")
                                   or ("" if env.get("ELEVENLABS_VOICE_ID") else DEFAULT_VOICE["name"])})
        if parts == ["api", "voices"]:
            key = read_env_file().get("ELEVENLABS_API_KEY")
            if not key:
                return self.send_json({"error": "Add your ElevenLabs API key first."}, 400)
            try:
                data, note = eleven_get("/voices", key), ""
            except (ValueError, OSError) as e:
                data, note = {}, f"Only the default voice is listed. {e}"
            voices = [{"id": v["voice_id"], "name": v["name"], "category": v.get("category", ""),
                       "labels": ", ".join(str(x) for x in (v.get("labels") or {}).values()), "preview": v.get("preview_url")}
                      for v in data.get("voices", [])]
            voices = sorted(voices, key=lambda v: (v["category"] != "cloned", v["name"]))
            ours = next((v for v in voices if v["id"] == DEFAULT_VOICE["id"]), None)
            voices = [{**DEFAULT_VOICE, "preview": ours and ours["preview"]}] + [v for v in voices if v is not ours]
            return self.send_json({"voices": voices, "note": note})
        if parts and parts[0] == "files":
            target = (ROOT / unquote("/".join(parts[1:]))).resolve()
            if JOBS.resolve() not in target.parents or not target.is_file():
                return self.send_json({"error": "Not found"}, 404)
            return self.send_file(target)
        self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "transcribe"]:
            key = read_env_file().get("ELEVENLABS_API_KEY")
            length = int(self.headers.get("Content-Length") or 0)
            if not key:
                return self.send_json({"error": "Voice input in this browser needs an ElevenLabs key (Voice settings)."}, 400)
            if not 0 < length <= MAX_AUDIO_BYTES:
                return self.send_json({"error": "Recording is empty or too long."}, 400)
            audio = self.rfile.read(length)
            try:
                text = transcribe(audio, self.headers.get("Content-Type", ""), key)
            except (ValueError, OSError) as e:
                return self.send_json({"error": str(e)}, 502)
            return self.send_json({"text": text})
        try:
            body = self.read_json()
        except json.JSONDecodeError:
            return self.send_json({"error": "Bad JSON"}, 400)
        if parts == ["api", "settings"]:
            updates = {}
            key = str(body.get("elevenlabs_api_key", "")).strip()
            if key:
                try:
                    eleven_get("/voices", key)  # check the key works before saving it
                except (ValueError, OSError) as e:
                    return self.send_json({"error": f"That key didn't work: {e}"}, 400)
                updates["ELEVENLABS_API_KEY"] = key
            if "elevenlabs_voice_id" in body:
                updates["ELEVENLABS_VOICE_ID"] = re.sub(r"[^A-Za-z0-9]", "", str(body["elevenlabs_voice_id"]))
                updates["ELEVENLABS_VOICE_NAME"] = re.sub(r"[\r\n=]", "", str(body.get("elevenlabs_voice_name", "")))[:60]
            if body.get("remove_elevenlabs"):
                write_env_file({"ELEVENLABS_API_KEY": "", "ELEVENLABS_VOICE_ID": "", "ELEVENLABS_VOICE_NAME": ""})
            elif updates:
                write_env_file(updates)
            return self.send_json({"ok": True})
        if parts == ["api", "jobs"]:
            try:
                request = validate(body)
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            job = Job(time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4], request)
            job.save()
            with lock:
                jobs[job.id] = job
            job.add("status", "Queued")
            work_queue.put((job, first_prompt(job)))
            return self.send_json(job_summary(job), 201)
        if len(parts) == 4 and parts[:2] == ["api", "jobs"]:
            job = jobs.get(parts[2])
            if not job:
                return self.send_json({"error": "No such job"}, 404)
            if parts[3] == "cancel":
                job.status = "cancelled"
                if job.proc:
                    os.killpg(job.proc.pid, signal.SIGTERM)
                job.save()
                return self.send_json(job_summary(job))
            if parts[3] == "feedback":
                text = str(body.get("text", "")).strip()[:2000]
                if not text:
                    return self.send_json({"error": "Write some feedback first."}, 400)
                if job.status in ("queued", "running"):
                    return self.send_json({"error": "Wait for the current run to finish."}, 409)
                if not job.session_id:
                    return self.send_json({"error": "This job has no agent session to continue."}, 409)
                job.status = "queued"
                job.save()
                job.add("feedback", text)
                work_queue.put((job, feedback_prompt(job, text)))
                return self.send_json(job_summary(job))
        self.send_json({"error": "Not found"}, 404)

    def send_file(self, path: Path, cache: bool = False) -> None:
        """Serve a file, honouring Range requests (Safari needs them to play video)."""
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix in (".md", ".json"):
            ctype = "text/plain; charset=utf-8"  # show in the browser instead of downloading
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "max-age=604800" if cache else "no-cache")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)


def main() -> None:
    JOBS.mkdir(exist_ok=True)
    for folder in JOBS.iterdir():
        if (folder / "job.json").exists():
            job = Job.load(folder)
            jobs[job.id] = job
            job.save()
    if not shutil.which("claude", path=agent_env()["PATH"]):
        print("warning: `claude` not found on PATH; jobs will fail until Claude Code is installed")
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Home video studio running at http://localhost:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
