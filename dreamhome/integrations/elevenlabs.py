"""Text-to-speech with word timings. Uses ElevenLabs /with-timestamps; falls back to macOS `say`
with proportional timing estimates so the pipeline still runs without an API key."""
import base64
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import httpx

from dreamhome.config import get_settings


@dataclass
class Word:
    text: str
    start: float
    end: float


def words_from_alignment(chars: list[str], starts: list[float], ends: list[float]) -> list[Word]:
    words, buf, w_start, w_end = [], "", None, 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if buf:
                words.append(Word(buf, w_start, w_end))
            buf, w_start = "", None
            continue
        if w_start is None:
            w_start = s
        buf += ch
        w_end = e
    if buf:
        words.append(Word(buf, w_start, w_end))
    return words


def _estimate_words(text: str, duration: float) -> list[Word]:
    tokens = text.split()
    weights = [len(t) + 2 for t in tokens]
    total = sum(weights) or 1
    t, out = 0.0, []
    for tok, w in zip(tokens, weights):
        d = duration * w / total
        out.append(Word(tok, t, t + d))
        t += d
    return out


def audio_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def synthesize(text: str, out_path: Path) -> list[Word]:
    """Write an mp3 to out_path and return word timings."""
    s = get_settings()
    out_path = Path(out_path)
    if s.elevenlabs_api_key and s.elevenlabs_voice_id:
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{s.elevenlabs_voice_id}/with-timestamps",
            headers={"xi-api-key": s.elevenlabs_api_key},
            json={"text": text, "model_id": "eleven_multilingual_v2", "output_format": "mp3_44100_128"},
            timeout=120,
        )
        r.raise_for_status()
        data = r.json()
        out_path.write_bytes(base64.b64decode(data["audio_base64"]))
        a = data["alignment"]
        return words_from_alignment(a["characters"], a["character_start_times_seconds"], a["character_end_times_seconds"])

    if shutil.which("say"):
        aiff = out_path.with_suffix(".aiff")
        subprocess.run(["say", "-r", "185", "-o", str(aiff), re.sub(r"\s+", " ", text)], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), str(out_path)], check=True)
        aiff.unlink(missing_ok=True)
    else:  # silent track sized to an average speaking rate
        dur = max(1.0, len(text.split()) / 2.6)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                        "-t", f"{dur:.2f}", str(out_path)], check=True)
    return _estimate_words(text, audio_duration(out_path))
