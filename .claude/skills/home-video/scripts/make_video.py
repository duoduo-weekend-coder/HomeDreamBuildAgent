#!/usr/bin/env python3
"""Render a home overview or build-process video from a storyboard JSON.

Each shot is a photo (animated with a slow pan or zoom), a video clip, an AI clip
generated from a photo (--ai), or a solid-colour title card. Shots are cross-faded,
titles are burned in, and a short narration is spoken over the shots. The finished
video is exactly the storyboard's `duration` long.

    python make_video.py storyboards/overview-15s.json
    python make_video.py storyboards/overview-15s.json --aspect 9:16 -o output/overview-15s-vertical.mp4
"""

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import string
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.request
from pathlib import Path

SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}
FPS = 30
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}

# Montserrat ExtraBold (static wght=800 instance of the SIL OFL variable font; licence in assets/OFL.txt).
FONT_PATH = Path(__file__).resolve().parent.parent / "assets" / "Montserrat-ExtraBold.ttf"
FALLBACK_FONT = "/System/Library/Fonts/Helvetica.ttc"

DEFAULT_STYLE = {
    "font": str(FONT_PATH),
    "text_color": "white",
    "accent_color": "#E8C98A",
    "card_color": "#1F2A24",
    "transition": "fade",
    "transition_duration": 0.5,
    "music_volume": 0.18,
}

# Spoken narration starts this long after its shot begins and must end this long
# before the next narration (or the end of the video).
NARRATION_LEAD = 0.25
NARRATION_GAP = 0.15
MAX_SPEEDUP = 1.15

DEFAULT_VOICES = {"elevenlabs": "21m00Tcm4TlvDq8ikWAM", "openai": "coral", "edge": "en-US-AvaNeural", "say": "Samantha"}
NARRATOR_STYLE = "Warm, confident real-estate narrator. Calm, unhurried pace, friendly and natural."


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd[:6])} ...\n{result.stderr[-2000:]}")
    return result.stdout


def media_duration(path: Path) -> float:
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).strip())


def find_file(value: str, storyboard_dir: Path) -> Path | None:
    for base in (Path.cwd(), storyboard_dir):
        p = (base / value).expanduser()
        if p.exists():
            return p
    return None


def cache_key(*parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:12]


TEXT_FIELDS = ("kicker", "title", "subtitle", "narration")


def fill_text(value, info: dict) -> str | None:
    """A text field is a string or a list of fallbacks; use the first whose {placeholders} are all known."""
    for option in [value] if isinstance(value, str) else value or []:
        fields = [f for _, f, _, _ in string.Formatter().parse(option) if f]
        if all(info.get(f) for f in fields):
            return option.format_map(info)
    return None


def apply_info(shots: list[dict], info: dict) -> None:
    for shot in shots:
        for key in TEXT_FIELDS:
            if key in shot:
                text = fill_text(shot[key], info)
                if text:
                    shot[key] = text
                else:
                    del shot[key]


# ---------------------------------------------------------------- narration


def load_dotenv(path: Path = Path(".env")) -> None:
    """Pick up API keys saved by the web interface (KEY=value lines) without overriding the real environment."""
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() and not line.lstrip().startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip('"'))


def tts_provider(requested: str) -> str:
    if requested != "auto":
        return requested
    if os.getenv("ELEVENLABS_API_KEY"):
        return "elevenlabs"
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if shutil.which("edge-tts"):
        return "edge"
    return "say"


def synthesize(text: str, provider: str, voice: str | None, out: Path) -> list[list] | None:
    """Write speech to `out` (wav). Returns [word, start, end] timings when the provider gives them (ElevenLabs)."""
    if provider == "elevenlabs" and not os.getenv("ELEVENLABS_API_KEY"):
        raise ValueError("ElevenLabs voice requested but ELEVENLABS_API_KEY is not set (add it in the web interface settings or .env)")
    voice = voice or (os.getenv("ELEVENLABS_VOICE_ID") if provider == "elevenlabs" else None) or DEFAULT_VOICES[provider]
    if provider == "say":
        aiff = out.with_suffix(".aiff")
        run(["say", "-v", voice, "-r", "170", "-o", str(aiff), text])
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), str(out)])
        aiff.unlink()
    elif provider == "edge":
        mp3 = out.with_suffix(".mp3")
        run(["edge-tts", "--voice", voice, "--rate=-5%", "--text", text, "--write-media", str(mp3)])
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3), str(out)])
        mp3.unlink()
    elif provider == "openai":
        body = {"model": "gpt-4o-mini-tts", "voice": voice, "input": text, "instructions": NARRATOR_STYLE, "response_format": "wav"}
        req = urllib.request.Request(
            "https://api.openai.com/v1/audio/speech",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            out.write_bytes(resp.read())
    elif provider == "elevenlabs":
        body = {"text": text, "model_id": "eleven_multilingual_v2", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps?output_format=mp3_44100_128",
            data=json.dumps(body).encode(),
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"},
        )
        mp3 = out.with_suffix(".mp3")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"ElevenLabs error {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None
        mp3.write_bytes(base64.b64decode(data["audio_base64"]))
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3), str(out)])
        mp3.unlink()
        a = data.get("alignment") or {}
        if a.get("characters"):
            return words_from_alignment(a["characters"], a["character_start_times_seconds"], a["character_end_times_seconds"])
    else:
        raise ValueError(f"Unknown voice provider {provider!r} (use auto, elevenlabs, openai, edge or say)")


def trimmed_narration(text: str, provider: str, voice: str | None, cache_dir: Path) -> Path:
    """Synthesize `text` (cached by provider/voice/text) with leading and trailing silence removed."""
    key = cache_key(provider, voice, text)
    final = cache_dir / f"voice-{key}.wav"
    if not final.exists():
        raw = cache_dir / f"voice-{key}-raw.wav"
        words = synthesize(text, provider, voice, raw)
        # Paid voices bill per character; log each generated (not cached) line for the job page.
        with open(cache_dir / "usage.jsonl", "a") as f:
            f.write(json.dumps({"provider": provider, "characters": len(text), "t": round(time.time())}) + "\n")
        if words:
            # Word times are relative to the raw audio; shift them by the leading silence we cut.
            lead = leading_silence(raw)
            words = [[w, round(max(0.0, s - lead), 3), round(max(0.0, e - lead), 3)] for w, s, e in words]
            final.with_suffix(".words.json").write_text(json.dumps(words))
        trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse"
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", trim, "-ar", "48000", "-ac", "2", str(final)])
        raw.unlink()
    return final


def leading_silence(path: Path) -> float:
    """Seconds of silence (below -45 dB) at the start of `path`, matching the trim in trimmed_narration."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path), "-af", "silencedetect=n=-45dB:d=0.01", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"silence_start: (-?[\d.]+)\D+?silence_end: ([\d.]+)", result.stderr)
    return float(m.group(2)) if m and float(m.group(1)) <= 0.01 else 0.0


def words_from_alignment(chars: list[str], starts: list[float], ends: list[float]) -> list[list]:
    """ElevenLabs character alignment -> [word, start, end] (same parsing as dreamhome/integrations/elevenlabs.py)."""
    words, buf, w_start, w_end = [], "", None, 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if buf:
                words.append([buf, w_start, w_end])
            buf, w_start = "", None
            continue
        if w_start is None:
            w_start = s
        buf += ch
        w_end = e
    if buf:
        words.append([buf, w_start, w_end])
    return words


def narration_words(text: str, audio: Path) -> list[list]:
    """[word, start, end] in seconds of the trimmed clip: real timings when cached (ElevenLabs), else an
    estimate that spreads the words over the clip in proportion to their length."""
    cached = audio.with_suffix(".words.json")
    if cached.exists():
        return json.loads(cached.read_text())
    tokens = text.split()
    weights = [len(t) + 2 for t in tokens]
    duration, total, t, out = media_duration(audio), sum(weights) or 1, 0.0, []
    for tok, w in zip(tokens, weights):
        d = duration * w / total
        out.append([tok, t, t + d])
        t += d
    return out


def chunk_words(words: list[list], max_words: int = 3, max_chars: int = 18) -> list[list]:
    """Group timed words into short caption lines [text, start, end]; never run across punctuation."""
    out, cur = [], []
    for w in words:
        if cur and len(" ".join(x[0] for x in cur + [w])) > max_chars:
            out.append([" ".join(x[0] for x in cur), cur[0][1], cur[-1][2]])
            cur = []
        cur.append(w)
        if len(cur) >= max_words or w[0][-1] in ".,!?;:":
            out.append([" ".join(x[0] for x in cur), cur[0][1], cur[-1][2]])
            cur = []
    if cur:
        out.append([" ".join(x[0] for x in cur), cur[0][1], cur[-1][2]])
    return out


# ---------------------------------------------------------------- shots


def ease(frames: int) -> str:
    p = f"(on/{max(frames - 1, 1)})"
    return f"({p}*{p}*(3-2*{p}))"


def zoompan_filter(motion: str, frames: int, W: int, H: int, amount: float = 0.10) -> str:
    e = ease(frames)
    cx, cy = "iw/2-iw/zoom/2", "ih/2-ih/zoom/2"
    z_still = f"{1 + amount}"
    options = {
        "zoom_in": (f"1+{amount}*{e}", cx, cy),
        "zoom_out": (f"{1 + amount}-{amount}*{e}", cx, cy),
        "pan_right": (z_still, f"(iw-iw/zoom)*{e}", cy),
        "pan_left": (z_still, f"(iw-iw/zoom)*(1-{e})", cy),
        "pan_down": (z_still, cx, f"(ih-ih/zoom)*{e}"),
        "pan_up": (z_still, cx, f"(ih-ih/zoom)*(1-{e})"),
        "none": ("1", "0", "0"),
    }
    if motion not in options:
        raise ValueError(f"Unknown motion {motion!r}; use one of {', '.join(options)}")
    z, x, y = options[motion]
    return f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={W}x{H}:fps={FPS}"


def fade_alpha(t_in: float, t_out: float, f: float = 0.35) -> str:
    return f"if(lt(t,{t_in}),0,if(lt(t,{t_in + f}),(t-{t_in})/{f},if(lt(t,{t_out - f}),1,if(lt(t,{t_out}),({t_out}-t)/{f},0))))"


def drawtext(font: str, textfile: Path, size: int, color: str, x: str, y: str, extra: str = "") -> str:
    return f"drawtext=fontfile='{font}':textfile='{textfile}':fontsize={size}:fontcolor={color}:x={x}:y='{y}'{extra}"


def shadowed_text(src: str, texts: list[dict], W: int, H: int, dur: float, out: str) -> list[str]:
    """Filter-graph lines that draw `texts` over stream `src` as white text with a soft blurred drop shadow
    (like dreamhome/reels/captions.py: shadow alpha 0.9, blur ~size/8, nudged down ~size/22), no box or scrim.
    Each text is a dict of drawtext() arguments plus "extra" options (alpha/enable/line spacing...)."""
    size = max(t["size"] for t in texts)
    canvas = f"color=c=black:s={W}x{H}:r={FPS}:d={dur:.3f}"
    mask = ",".join(
        drawtext(t["font"], t["textfile"], t["size"], "white", t["x"], f"{t['y']}+{max(2, t['size'] // 22)}",
                 t["extra"] + f":borderw={max(2, t['size'] // 10)}:bordercolor=white") for t in texts
    )  # the border widens the shadow into a soft dark halo, so white text reads even on white walls
    label = out.strip("[]")
    return [
        f"{canvas},format=gray,{mask},gblur=sigma={max(3, size / 7):.1f},lut=c0=min(255\,val*1.3)[{label}_m]",
        f"{canvas},format=yuva420p[{label}_k]",
        f"[{label}_k][{label}_m]alphamerge[{label}_s]",
        f"{src}[{label}_s]overlay=0:0,"
        + ",".join(drawtext(t["font"], t["textfile"], t["size"], t["color"], t["x"], t["y"], t["extra"]) for t in texts)
        + out,
    ]


def text_filters(shot: dict, dur: float, W: int, H: int, work: Path, idx: int, style: dict, is_card: bool) -> list[dict]:
    """Text specs (for shadowed_text) for the shot's kicker (small label), title and subtitle."""
    base = min(W, H)
    lines = []  # (key, size, color)
    if shot.get("kicker"):
        lines.append(("kicker", round(base * 0.034), style["accent_color"]))
    if shot.get("title"):
        lines.append(("title", round(base * (0.085 if is_card else 0.068)), style["text_color"]))
    if shot.get("subtitle"):
        lines.append(("subtitle", round(base * 0.036), style["text_color"]))
    if not lines:
        return []

    # Wrap long text (e.g. a user's highlight message) to fit the frame; ~0.62em per character in Montserrat ExtraBold.
    spacing = 8
    texts = {}
    for key, size, _ in lines:
        text = str(shot[key]).upper() if key == "kicker" else str(shot[key])
        width = max(8, int(W * 0.86 / (size * 0.62)))
        texts[key] = "\n".join(textwrap.fill(part, width) for part in text.split("\n"))
    # drawtext advances each line by the font's line height (~1.22em for Montserrat) plus line_spacing.
    heights = {key: round(size * 1.22) * (texts[key].count("\n") + 1) + spacing * texts[key].count("\n") for key, size, _ in lines}

    gap = round(base * 0.018)
    block_h = sum(heights.values()) + gap * (len(lines) - 1)
    vertical = H > W
    captions = style.get("_captions", False)  # burned-in voiceover captions sit in the lower part of the frame
    if is_card or shot.get("layout") == "center":
        top, centered = (H - block_h) / 2, True
        if captions and top + block_h > H * 0.60:
            top = max(H * 0.06, H * 0.60 - block_h)
    elif vertical:
        # clear of Instagram / TikTok UI; above the captions' band when they are on
        top, centered = (H * 0.10, True) if captions else (H * 0.70 - block_h, True)
    elif captions:
        top, centered = H * 0.08, False
    else:
        top, centered = H - H * 0.10 - block_h, False

    t_in = 0.35 if idx > 0 or not is_card else 0.2
    t_out = dur - 0.35
    filters, y = [], top
    for n, (key, size, color) in enumerate(lines):
        tf = work / f"text-{idx:02d}-{key}.txt"
        tf.write_text(texts[key], encoding="utf-8")
        start = t_in + 0.12 * n
        x = "(w-text_w)/2" if centered else f"{round(W * 0.06)}"
        y_expr = f"{round(y)}+{round(base * 0.02)}*(1-clip((t-{start})/0.45,0,1))"
        filters.append({
            "font": style["font"], "textfile": tf, "size": size, "color": color, "x": x, "y": y_expr,
            "extra": f":alpha='{fade_alpha(start, t_out)}'"
            + (f":line_spacing={spacing}" if key != "kicker" else "")
            + (":text_align=C" if centered else ""),
        })
        y += heights[key] + gap
    return filters


def render_shot(shot: dict, idx: int, dur: float, W: int, H: int, work: Path, style: dict, source: Path | None) -> Path:
    out = work / f"shot-{idx:02d}.mp4"
    is_card = source is None
    frames = round(dur * FPS)
    if is_card:
        color = shot.get("color", style["card_color"])
        inputs = ["-f", "lavfi", "-i", f"color=c={color}:s={W}x{H}:r={FPS}:d={dur:.3f}"]
        vf = []
    elif source.suffix.lower() in IMAGE_EXTS:
        # Privacy crop/blur, straightening and framing -> a ready 2W x 2H frame (see prep_photo.py).
        try:
            sys.path.insert(0, str(Path(__file__).parent))
            from prep_photo import prepare

            source = prepare(source, W, H, shot, Path(style.get("_cache_dir", work)))
            vf = []
        except Exception as e:
            if shot.get("crop") or shot.get("blur"):
                raise  # never render a photo without its privacy edits
            print(f"warning: photo prep failed for {source.name} ({e}); using plain scale/crop", file=sys.stderr)
            if source.suffix.lower() in {".heic", ".heif"}:
                jpg = work / f"src-{idx:02d}.jpg"
                run(["sips", "-s", "format", "jpeg", str(source), "--out", str(jpg)])
                source = jpg
            vf = [
                f"scale={2 * W}:{2 * H}:force_original_aspect_ratio=increase:flags=lanczos",
                f"crop={2 * W}:{2 * H}",
            ]
        inputs = ["-i", str(source)]
        vf.append(zoompan_filter(shot.get("motion", "zoom_in"), frames, W, H, shot.get("motion_amount", 0.10)))
    else:
        start = float(shot.get("start", 0))
        speed = float(shot.get("speed", 1.0))
        inputs = ["-ss", f"{start:.3f}", "-i", str(source)]
        vf = [
            f"setpts=PTS/{speed}" if speed != 1.0 else "null",
            f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos",
            f"crop={W}:{H}",
            f"fps={FPS}",
            f"tpad=stop_mode=clone:stop_duration={dur:.3f}",
        ]
    vf += ["setsar=1"]
    texts = text_filters(shot, dur, W, H, work, idx, style, is_card)
    if texts:
        # White text with a soft blurred shadow keeps titles readable on bright photos without a dark scrim.
        graph = ";".join([f"[0:v]{','.join(vf)}[base]", *shadowed_text("[base]", texts, W, H, dur, "[txt]"), "[txt]format=yuv420p[out]"])
    else:
        graph = f"[0:v]{','.join(vf)},format=yuv420p[out]"
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
        "-filter_complex", graph, "-map", "[out]", "-frames:v", str(frames), "-an", "-r", str(FPS),
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", str(out),
    ])
    return out


# ---------------------------------------------------------------- assembly


def overlaps(shots: list[dict], style: dict, T: float) -> list[float]:
    """Seconds each shot overlaps the one before it: T for a cross-fade, 0 for a hard cut ("transition": "cut")."""
    return [0.0] + [0.0 if shots[k].get("transition", style["transition"]) == "cut" else T for k in range(1, len(shots))]


def music_beat(path: Path) -> tuple[float, float]:
    """(beat period, first-beat offset) in seconds, from the music's onset strength (spectral flux autocorrelation)."""
    import numpy as np

    raw = subprocess.run(["ffmpeg", "-v", "error", "-t", "60", "-i", str(path), "-ac", "1", "-ar", "22050", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    hop, n = 512, 2048
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * np.hanning(n)
    rise = np.maximum(0, np.diff(np.log1p(np.abs(np.fft.rfft(frames, axis=1))), axis=0))
    def norm(f):
        return (f - f.mean()) / (f.std() + 1e-9)
    low = int(250 * n / 22050)  # kick drum band: cuts belong on the downbeat, not the hi-hat
    flux = norm(rise.sum(1)) + 2 * norm(rise[:, 1:low].sum(1))
    rate = 22050 / hop
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    lags = np.arange(len(ac)) / rate
    window = (lags > 60 / 180) & (lags < 60 / 70)  # 70-180 bpm
    rough = float(lags[window][np.argmax(ac[window])])
    # Refine: the period and phase whose beat grid lands on the most onset energy over the whole excerpt.
    # Frame i covers samples [i*hop, i*hop+n); its flux rises when an onset enters the window's centre.
    times = np.arange(len(flux)) * hop / 22050 + (n / 2 + hop) / 22050
    best = (-1e9, rough, 0.0)
    for period in np.arange(rough * 0.97, rough * 1.03, 0.0005):
        beats = np.arange(0, times[-1] - period, period)
        for phase in np.arange(0, period, 0.005):
            score = np.interp(beats + phase, times, flux).sum()
            if score > best[0]:
                best = (score, float(period), float(phase))
    return best[1], best[2]


def fit_durations(shots: list[dict], target: float, ov: list[float], beat: float | None = None) -> list[float]:
    """Shot lengths that make the video exactly `target` seconds. With a beat, shots that give "beats" keep that many
    beats (so hard cuts land on the music) and the others stretch to fill the rest; put those at the end."""
    locked = [bool(beat and s.get("beats")) for s in shots]
    durs = [float(s["beats"]) * beat if lock else float(s.get("duration", 3)) for s, lock in zip(shots, locked)]
    needed = target + sum(ov)
    if any(locked):
        # The track's tempo isn't known when the storyboard is written, so add or remove half-beats on the
        # longest (or shortest) locked shots until the unlocked shots land between 0.6x and 2x their planned length.
        free_plan = sum(d for d, lock in zip(durs, locked) if not lock)
        lo, hi = (0.6 * free_plan, 2 * free_plan) if free_plan else (0.0, 0.0)
        for _ in range(200):
            room = needed - sum(d for d, lock in zip(durs, locked) if lock)
            if room < lo:
                k = max((i for i in range(len(durs)) if locked[i] and durs[i] > 0.9 * beat), key=lambda i: durs[i], default=None)
                step = -0.5 * beat
            elif room > hi + (0.5 * beat if not free_plan else 0):
                k = min((i for i in range(len(durs)) if locked[i]), key=lambda i: durs[i], default=None)
                step = 0.5 * beat
            else:
                break
            if k is None:
                break
            durs[k] += step
        if not free_plan:  # everything is locked: the last shot takes up the remainder
            durs[-1] += needed - sum(durs)
    if abs(sum(durs) - needed) > 0.01:
        fixed = sum(d for d, lock in zip(durs, locked) if lock)
        free = sum(durs) - fixed
        if free > 0 and needed - fixed >= 0.4 * free:
            scale = (needed - fixed) / free
            durs = [d if lock else d * scale for d, lock in zip(durs, locked)]
            if any(locked):
                print(f"note: {sum(locked)} shots locked to the beat ({beat:.3f}s); scaling the rest by {scale:.3f}")
        else:
            scale = needed / sum(durs)
            durs = [d * scale for d in durs]
            if any(locked):
                print(f"warning: the beat-locked shots don't fit {target:g}s, so cuts may drift off the beat")
        if not any(locked):
            print(f"note: scaling shot lengths by {scale:.3f} so the video is exactly {target:g}s")
    free_idx = [i for i, lock in enumerate(locked) if not lock]
    if any(locked) and len(free_idx) > 1:
        # Keep the stretched shots on the beat too: whole half-beats each, the last one takes the remainder.
        half = beat / 2
        for i in free_idx[:-1]:
            durs[i] = max(2 * half, round(durs[i] / half) * half)
        durs[free_idx[-1]] += needed - sum(durs)
    for k, d in enumerate(durs):
        out = ov[k + 1] if k + 1 < len(ov) else 0.0
        if d < ov[k] + out + (0.5 if ov[k] or out else 0.2):
            raise ValueError(f"Shot {k + 1} is only {d:.2f}s long; use fewer shots, hard cuts, or a shorter transition")
    return durs


def timeline(sb: dict, shots: list[dict], style: dict, sb_dir: Path, verbose: bool = False):
    """(durations, starts, overlaps, music path, music start offset) for a storyboard; shared with video_metadata.py."""
    total, T = float(sb["duration"]), float(style["transition_duration"])
    ov = overlaps(shots, style, T)
    music = find_file(sb["music"], sb_dir) if sb.get("music") else None
    if sb.get("music") and music is None:
        raise FileNotFoundError(f"Music file not found: {sb['music']}")
    beat, beat_offset = None, 0.0
    if music and sb.get("beat_sync"):
        if sb.get("bpm"):
            beat, beat_offset = 60 / float(sb["bpm"]), float(sb.get("beat_offset", 0))
        else:
            beat, beat_offset = music_beat(music)
        if verbose:
            print(f"music: {60 / beat:.0f} bpm, first beat at {beat_offset:.2f}s; cutting on the beat")
    durs = fit_durations(shots, total, ov, beat)
    return durs, shot_starts(durs, ov), ov, music, beat_offset


def shot_starts(durs: list[float], ov: list[float]) -> list[float]:
    starts, t = [], 0.0
    for k, d in enumerate(durs):
        starts.append(t)
        t += d - (ov[k + 1] if k + 1 < len(ov) else 0.0)
    return starts


def plan_narration(shots, starts, total, provider, voice, cache_dir) -> list[tuple[Path, float, float]]:
    """Return (audio, start_time, tempo) per narrated shot. A line may run across later shots that have no narration."""
    narrated = [i for i, s in enumerate(shots) if s.get("narration")]
    plan, problems = [], []
    for n, i in enumerate(narrated):
        audio = trimmed_narration(shots[i]["narration"], provider, voice, cache_dir)
        begin = starts[i] + (0.4 if i == 0 else NARRATION_LEAD)
        end = starts[narrated[n + 1]] + NARRATION_LEAD if n + 1 < len(narrated) else total - 0.3
        window = end - begin - NARRATION_GAP
        length = media_duration(audio)
        tempo = 1.0
        if length > window:
            tempo = length / window
            if tempo > MAX_SPEEDUP:
                problems.append(f'shot {i + 1}: "{shots[i]["narration"]}" takes {length:.1f}s but only {window:.1f}s is free')
                continue
        plan.append((audio, begin, tempo))
    if problems:
        raise ValueError("Narration too long. Shorten these lines, or remove narration from a neighbouring shot:\n  " + "\n  ".join(problems))
    return plan


def plan_captions(shots: list[dict], narration: list[tuple[Path, float, float]], total: float) -> list[list]:
    """Short caption lines [text, start, end] in video time, synced word by word to the narration.
    A narration clip placed at `begin` and sped up by `tempo` says a word at clip time t at begin + t / tempo."""
    texts = [s["narration"] for s in shots if s.get("narration")]
    captions = []
    for text, (audio, begin, tempo) in zip(texts, narration):
        words = [[w, begin + s / tempo, begin + e / tempo] for w, s, e in narration_words(text, audio)]
        line = chunk_words(words)
        # Hold each caption until the next one starts so the screen doesn't flicker empty mid-sentence.
        for a, b in zip(line, line[1:]):
            if b[1] - a[2] < 0.35:
                a[2] = b[1]
        if line:
            line[-1][2] += 0.3
        captions += line
    for a, b in zip(captions, captions[1:]):
        a[2] = min(a[2], b[1])
    return [[t, round(s, 3), round(min(e, total), 3)] for t, s, e in captions if s < total]


def caption_texts(captions: list[list], W: int, H: int, work: Path, style: dict) -> list[dict]:
    """Text specs (for shadowed_text) that show each caption only while it is being spoken."""
    size = round(min(W, H) * 0.062)
    center_y = H * (0.66 if H > W else 0.82)
    specs = []
    for n, (text, start, end) in enumerate(captions):
        tf = work / f"caption-{n:03d}.txt"
        tf.write_text(text.upper(), encoding="utf-8")
        specs.append({
            "font": style["font"], "textfile": tf, "size": size, "color": style["text_color"],
            "x": "(w-text_w)/2", "y": f"{round(center_y - size / 2)}",
            "extra": f":enable='between(t,{start:.3f},{end:.3f})'",
        })
    return specs


def render(storyboard_path: Path, aspect: str | None, output: Path | None, use_ai: bool, placeholders: bool) -> Path:
    load_dotenv()
    sb = json.loads(storyboard_path.read_text())
    style = {**DEFAULT_STYLE, **sb.get("style", {})}
    if not Path(style["font"]).exists():
        style["font"] = FALLBACK_FONT
    aspect = aspect or sb.get("aspect", "16:9")
    W, H = SIZES[aspect]
    total = float(sb["duration"])
    T = float(style["transition_duration"])
    shots = sb["shots"]
    apply_info(shots, sb.get("info", {}))
    for shot in shots:  # a storyboard-wide photo framing default, e.g. "cover" for full-bleed reels
        if style.get("fit"):
            shot.setdefault("fit", style["fit"])
    sb_dir = storyboard_path.parent
    output = output or Path("output") / f"{storyboard_path.stem}{'' if aspect == '16:9' else '-' + aspect.replace(':', 'x')}.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    cache_dir = output.parent / ".cache"
    cache_dir.mkdir(exist_ok=True)
    style["_cache_dir"] = cache_dir

    # Resolve every source up front so a missing file fails before any rendering.
    sources, missing = [], []
    for i, shot in enumerate(shots):
        if shot.get("source") in (None, "card"):
            sources.append(None)
            continue
        path = find_file(shot["source"], sb_dir)
        if path is None:
            if not placeholders:
                missing.append(f"shot {i + 1}: {shot['source']}")
            shot["color"] = "#3A3F44"
            shot["kicker"] = f"missing: {Path(shot['source']).name}"
        sources.append(path)
    if missing:
        raise FileNotFoundError("Missing media (or run with --placeholders to preview):\n  " + "\n  ".join(missing))

    if use_ai:
        sys.path.insert(0, str(Path(__file__).parent))
        from generate_clip import generate_clip

        for i, shot in enumerate(shots):
            src = sources[i]
            if shot.get("ai_prompt") and src is not None and src.suffix.lower() in IMAGE_EXTS:
                clip = cache_dir / f"ai-{cache_key(str(src), shot['ai_prompt'], aspect)}.mp4"
                if not clip.exists():
                    print(f"generating AI clip for shot {i + 1} from {src.name} (this can take a few minutes)...")
                    generate_clip(shot["ai_prompt"], str(src), str(clip), aspect)
                sources[i] = clip

    durs, starts, ov, music, beat_offset = timeline(sb, shots, style, sb_dir, verbose=True)
    voice_cfg = sb.get("voice", {})
    provider = tts_provider(voice_cfg.get("provider", "auto"))
    voice = voice_cfg.get("voice") if voice_cfg.get("provider", "auto") != "auto" else None
    shown_voice = voice or (os.getenv("ELEVENLABS_VOICE_ID") if provider == "elevenlabs" else None) or DEFAULT_VOICES[provider]
    print(f"rendering {len(shots)} shots at {W}x{H}, {total:g}s, voice: {provider} ({shown_voice})")
    narration = plan_narration(shots, starts, total, provider, voice, cache_dir)
    captions = plan_captions(shots, narration, total) if sb.get("captions", True) else []
    style["_captions"] = bool(captions)  # titles move out of the captions' way

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        segments = [render_shot(s, i, durs[i], W, H, work, style, sources[i]) for i, s in enumerate(shots)]

        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
        for seg in segments:
            cmd += ["-i", str(seg)]
        graph, last, length = [], "[0:v]", durs[0]
        for k in range(1, len(segments)):
            if ov[k] == 0:  # hard cut
                graph.append(f"{last}[{k}:v]concat=n=2:v=1:a=0[v{k}]")
            else:
                transition = shots[k].get("transition", style["transition"])
                graph.append(f"{last}[{k}:v]xfade=transition={transition}:duration={ov[k]}:offset={length - ov[k]:.3f}[v{k}]")
            last, length = f"[v{k}]", length + durs[k] - ov[k]
        if captions:
            # Burned-in captions synced to the voiceover (most viewers watch muted).
            graph += shadowed_text(last, caption_texts(captions, W, H, work, style), W, H, total, "[capt]")
            last = "[capt]"
        graph.append(f"{last}format=yuv420p[vout]")

        n_in = len(segments)
        voice_labels = []
        for k, (audio, begin, tempo) in enumerate(narration):
            cmd += ["-i", str(audio)]
            ms = round(begin * 1000)
            graph.append(f"[{n_in}:a]aformat=sample_rates=48000:channel_layouts=stereo,atempo={tempo:.3f},adelay={ms}:all=1[n{k}]")
            voice_labels.append(f"[n{k}]")
            n_in += 1
        if voice_labels:
            graph.append(f"{''.join(voice_labels)}amix=inputs={len(voice_labels)}:normalize=0,apad[voice]")
        if music:
            cmd += ["-stream_loop", "-1", "-i", str(music)]
            graph.append(
                f"[{n_in}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim={beat_offset:.3f}:{beat_offset + total:.3f},"
                f"asetpts=PTS-STARTPTS,volume={style['music_volume']},"
                f"afade=t=in:d=1,afade=t=out:st={total - 1.5}:d=1.5[mus]"
            )
            n_in += 1
            if voice_labels:
                graph.append("[voice]asplit=2[vmix][vkey]")
                graph.append("[mus][vkey]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[duck]")
                graph.append("[vmix][duck]amix=inputs=2:normalize=0[mix]")
            else:
                graph.append("[mus]apad[mix]")
        elif voice_labels:
            graph.append("[voice]anull[mix]")
        if voice_labels or music:
            graph.append(f"[mix]atrim=0:{total},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]")
        else:
            cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            graph.append(f"[{n_in}:a]atrim=0:{total}[aout]")

        cmd += [
            "-filter_complex", ";".join(graph), "-map", "[vout]", "-map", "[aout]", "-t", f"{total:.3f}",
            "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output),
        ]
        run(cmd)
    print(f"saved {output} ({media_duration(output):.2f}s)")
    try:
        from video_metadata import write_metadata

        json_path, md_path = write_metadata(storyboard_path, output, aspect)
        print(f"metadata {md_path.name} (revision {json.loads(json_path.read_text())['revision']})")
    except Exception as e:  # the video is fine; say why its metadata is missing
        print(f"warning: metadata not written: {e}", file=sys.stderr)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Render a home video from a storyboard JSON")
    parser.add_argument("storyboard", type=Path)
    parser.add_argument("--aspect", choices=SIZES, help="Override the storyboard's aspect ratio")
    parser.add_argument("-o", "--output", type=Path)
    parser.add_argument("--ai", action="store_true", help="Turn photos with an ai_prompt into AI video clips (paid API)")
    parser.add_argument("--placeholders", action="store_true", help="Render missing media as grey cards instead of failing")
    args = parser.parse_args()
    try:
        render(args.storyboard, args.aspect, args.output, args.ai, args.placeholders)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
