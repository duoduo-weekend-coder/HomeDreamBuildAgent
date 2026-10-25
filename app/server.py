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
ASPECTS = {"16:9": "16x9", "9:16": "9x16", "1:1": "1x1", "4:5": "4x5"}
VOICES = {"edge", "elevenlabs", "openai", "say", "auto"}

jobs: dict[str, "Job"] = {}
work_queue: "queue.Queue[tuple[Job, str]]" = queue.Queue()
lock = threading.Lock()


ENV_FILE = ROOT / ".env"
ELEVEN_API = "https://api.elevenlabs.io/v1"


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
            item = {"name": p.name, "url": f"/files/jobs/{self.id}/output/{p.name}?v={int(p.stat().st_mtime)}",
                    "size": p.stat().st_size}
            for key, suffix in (("metadata_md", ".metadata.md"), ("metadata_json", ".metadata.json")):
                meta = p.with_name(p.stem + suffix)
                if meta.exists():
                    item[key] = f"/files/jobs/{self.id}/output/{meta.name}?v={int(meta.stat().st_mtime)}"
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
    template_text = "\n\n".join(template_brief(k, r["lengths"]) for k in r["kinds"] if k in TEMPLATES)
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
Give every storyboard a "caption": a short Instagram caption (1-2 sentences plus 3-5 hashtags) that only states what
the footage shows. Rendering also writes <video>.metadata.json and <video>.metadata.md (the acquisition-agent
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

    final = None
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
                    job.add("tool", describe_tool(c["name"], c.get("input", {})), tool=c["name"])
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


def template_brief(kind: str, lengths: list[int]) -> str:
    t = TEMPLATES[kind]
    files = ", ".join(f".claude/skills/home-video/templates/{t['files'][str(n)]}" for n in lengths)
    story = "\n".join(f"  {i}. {line}" for i, line in enumerate(t["story"], 1))
    return (f"Template \"{t['label']}\" ({kind}): {t['goal']}\n"
            f"Start from: {files}\nMedia to use: {t['media']}\nStory:\n{story}\n"
            f"Voiceover: {t['voice']}\nPace: {t['pace']}"
            + (f"\nMusic (required): {t['music'].rstrip('.')}. Use a matching track from assets/music/ and set \"music\" to it; "
               "if none fits or the folder is empty, render without music and say so in the summary." if t.get("music") else "")
            + (f"\nStyle reference: {t['reference']} (summarised in docs/reference-styles.md)." if t.get("reference") else ""))


def highlight_rule(highlight: str) -> str:
    if not highlight:
        return "No highlight message was given: leave info.highlight empty."
    return f"""Highlight message from the user (MUST appear in every video): "{highlight}"
- Put it in info.highlight exactly as written; the templates show it as the hook title and on the end card.
- If the template has narration, weave its meaning into it too, without adding claims the user didn't make.
- After rendering, check a frame shows the message in full (not cut off) and mention that in the summary."""


def job_summary(job: Job) -> dict:
    r = job.request
    return {"id": job.id, "status": job.status, "created": job.created, "cost": round(job.cost, 2),
            "elevenlabs_characters": job.voice_characters().get("elevenlabs", 0),
            "title": r.get("info", {}).get("home_name") or "Untitled home",
            "kinds": r["kinds"], "lengths": r["lengths"], "aspects": r["aspects"], "videos": len(job.outputs())}


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
    return {"source": source, "kinds": kinds, "lengths": lengths, "aspects": aspects, "voice": voice,
            "info": info, "highlight": str(body.get("highlight", "")).strip()[:120],
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
        if parts == ["api", "templates"]:
            return self.send_json(TEMPLATES)
        if parts == ["api", "settings"]:
            env = read_env_file()
            return self.send_json({"elevenlabs_configured": bool(env.get("ELEVENLABS_API_KEY")),
                                   "elevenlabs_voice_id": env.get("ELEVENLABS_VOICE_ID", ""),
                                   "elevenlabs_voice_name": env.get("ELEVENLABS_VOICE_NAME", "")})
        if parts == ["api", "voices"]:
            key = read_env_file().get("ELEVENLABS_API_KEY")
            if not key:
                return self.send_json({"error": "Add your ElevenLabs API key first."}, 400)
            try:
                data = eleven_get("/voices", key)
            except (ValueError, OSError) as e:
                return self.send_json({"error": str(e)}, 502)
            voices = [{"id": v["voice_id"], "name": v["name"], "category": v.get("category", ""),
                       "labels": ", ".join(str(x) for x in (v.get("labels") or {}).values()), "preview": v.get("preview_url")}
                      for v in data.get("voices", [])]
            return self.send_json(sorted(voices, key=lambda v: (v["category"] != "cloned", v["name"])))
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

    def send_file(self, path: Path) -> None:
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
        self.send_header("Cache-Control", "no-cache")
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
