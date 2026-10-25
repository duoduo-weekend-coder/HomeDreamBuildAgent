#!/usr/bin/env python3
"""Generate one short AI video clip, optionally starting from a photo.

Adapted from bytedance/deer-flow skills/public/video-generation/scripts/generate.py:
- the photo is used as the clip's first frame, so the real room stays recognisable
- stdlib only (no `requests`), with a hard timeout on every provider's polling loop

Providers are picked from the environment:
  GEMINI_API_KEY set           -> Google Veo 3.1 (default)
  only MINIMAX_API_KEY set     -> MiniMax Hailuo
  VIDEO_GENERATION_PROVIDER    -> force "gemini" or "minimax"
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

GEMINI_MODEL = os.getenv("GEMINI_VIDEO_MODEL", "veo-3.1-generate-preview")
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
MINIMAX_DEFAULT_HOST = "https://api.minimaxi.com"
POLL_INTERVAL = 5
POLL_TIMEOUT = 15 * 60

MIME_TYPES = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}

NEGATIVE_PROMPT = "people, text, watermark, logo, distorted architecture, warped walls, flicker, fast motion"


def _guess_mime(image_path: str) -> str:
    ext = os.path.splitext(image_path)[1].lower()
    try:
        return MIME_TYPES[ext]
    except KeyError:
        raise ValueError(f"Unsupported image extension for {image_path!r}. Supported: {', '.join(MIME_TYPES)}") from None


def _b64(path: str) -> str:
    return base64.b64encode(Path(path).read_bytes()).decode("utf-8")


def _http(method: str, url: str, headers: dict, body: dict | None = None, timeout: int = 60) -> bytes:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url.split('?')[0]} failed: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:500]}") from None


def _json(method: str, url: str, headers: dict, body: dict | None = None, timeout: int = 60) -> dict:
    return json.loads(_http(method, url, headers, body, timeout))


def _save(content: bytes, output_file: str) -> None:
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    Path(output_file).write_bytes(content)


def resolve_provider() -> str:
    override = os.getenv("VIDEO_GENERATION_PROVIDER")
    if override:
        return override.strip().lower()
    if os.getenv("GEMINI_API_KEY"):
        return "gemini"
    if os.getenv("MINIMAX_API_KEY"):
        return "minimax"
    raise ValueError("No video provider credentials found. Set GEMINI_API_KEY (Veo) or MINIMAX_API_KEY (Hailuo).")


def _generate_gemini(prompt: str, image: str | None, output_file: str, aspect_ratio: str) -> None:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise ValueError("GEMINI_API_KEY is not set")
    instance = {"prompt": prompt}
    if image:
        instance["image"] = {"mimeType": _guess_mime(image), "bytesBase64Encoded": _b64(image)}
    body = {
        "instances": [instance],
        "parameters": {"aspectRatio": aspect_ratio if aspect_ratio in ("16:9", "9:16") else "16:9", "negativePrompt": NEGATIVE_PROMPT},
    }
    headers = {"x-goog-api-key": key, "Content-Type": "application/json"}
    op = _json("POST", f"{GEMINI_BASE}/models/{GEMINI_MODEL}:predictLongRunning", headers, body)
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        data = _json("GET", f"{GEMINI_BASE}/{op['name']}", headers, timeout=30)
        if data.get("done"):
            if "error" in data:
                raise RuntimeError(f"Veo generation failed: {data['error']}")
            samples = data["response"]["generateVideoResponse"].get("generatedSamples") or []
            if not samples:
                raise RuntimeError(f"Veo returned no video (possibly filtered): {json.dumps(data['response'])[:500]}")
            _save(_http("GET", samples[0]["video"]["uri"], {"x-goog-api-key": key}, timeout=300), output_file)
            return
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"Veo operation {op['name']} did not finish within {POLL_TIMEOUT}s")


def _check_base_resp(payload: dict) -> None:
    base = payload.get("base_resp") or {}
    if base.get("status_code", 0) != 0:
        raise RuntimeError(f"MiniMax error {base.get('status_code')}: {base.get('status_msg')}")


def _generate_minimax(prompt: str, image: str | None, output_file: str) -> None:
    key = os.getenv("MINIMAX_API_KEY")
    if not key:
        raise ValueError("MINIMAX_API_KEY is not set")
    host = os.getenv("MINIMAX_API_HOST", MINIMAX_DEFAULT_HOST).rstrip("/")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    body = {"model": os.getenv("MINIMAX_VIDEO_MODEL", "MiniMax-Hailuo-2.3"), "prompt": prompt}
    if image:
        body["first_frame_image"] = f"data:{_guess_mime(image)};base64,{_b64(image)}"
    payload = _json("POST", f"{host}/v1/video_generation", headers, body)
    _check_base_resp(payload)
    task_id = payload["task_id"]
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        q = urllib.parse.urlencode({"task_id": task_id})
        payload = _json("GET", f"{host}/v1/query/video_generation?{q}", headers, timeout=30)
        status = payload.get("status")
        if status == "Success":
            q = urllib.parse.urlencode({"file_id": payload["file_id"]})
            file_info = _json("GET", f"{host}/v1/files/retrieve?{q}", headers, timeout=30)
            _check_base_resp(file_info)
            _save(_http("GET", file_info["file"]["download_url"], {}, timeout=300), output_file)
            return
        if status == "Fail":
            _check_base_resp(payload)
            raise RuntimeError(f"MiniMax video task {task_id} failed")
        _check_base_resp(payload)
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"MiniMax task {task_id} did not finish within {POLL_TIMEOUT}s")


def generate_clip(prompt: str, image: str | None, output_file: str, aspect_ratio: str = "16:9") -> str:
    provider = resolve_provider()
    if provider in ("gemini", "google"):
        _generate_gemini(prompt, image, output_file, aspect_ratio)
    elif provider == "minimax":
        _generate_minimax(prompt, image, output_file)
    else:
        raise ValueError(f"Unknown video provider: {provider!r} (use 'gemini' or 'minimax')")
    return output_file


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate one AI video clip with Veo or MiniMax")
    parser.add_argument("--prompt", required=True, help="Text prompt describing the shot")
    parser.add_argument("--image", help="Photo to use as the first frame")
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--aspect-ratio", default="16:9", help="16:9 or 9:16 (Veo only)")
    args = parser.parse_args()
    try:
        print(f"Saved {generate_clip(args.prompt, args.image, args.output_file, args.aspect_ratio)}")
    except Exception as e:
        print(f"Error while generating video: {e}", file=sys.stderr)
        sys.exit(1)
