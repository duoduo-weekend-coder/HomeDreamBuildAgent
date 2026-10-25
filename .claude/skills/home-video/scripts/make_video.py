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
import hashlib
import json
import os
import shutil
import string
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}
FPS = 30
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}

DEFAULT_STYLE = {
    "font": "/System/Library/Fonts/Avenir Next.ttc",
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


def synthesize(text: str, provider: str, voice: str | None, out: Path) -> None:
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
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128",
            data=json.dumps(body).encode(),
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"},
        )
        mp3 = out.with_suffix(".mp3")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                mp3.write_bytes(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"ElevenLabs error {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3), str(out)])
        mp3.unlink()
    else:
        raise ValueError(f"Unknown voice provider {provider!r} (use auto, elevenlabs, openai, edge or say)")


def trimmed_narration(text: str, provider: str, voice: str | None, cache_dir: Path) -> Path:
    """Synthesize `text` (cached by provider/voice/text) with leading and trailing silence removed."""
    key = cache_key(provider, voice, text)
    final = cache_dir / f"voice-{key}.wav"
    if not final.exists():
        raw = cache_dir / f"voice-{key}-raw.wav"
        synthesize(text, provider, voice, raw)
        # Paid voices bill per character; log each generated (not cached) line for the job page.
        with open(cache_dir / "usage.jsonl", "a") as f:
            f.write(json.dumps({"provider": provider, "characters": len(text), "t": round(time.time())}) + "\n")
        trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse"
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", trim, "-ar", "48000", "-ac", "2", str(final)])
        raw.unlink()
    return final


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


def text_filters(shot: dict, dur: float, W: int, H: int, work: Path, idx: int, style: dict, is_card: bool) -> list[str]:
    """drawtext filters for the shot's kicker (small label), title and subtitle."""
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

    gap = round(base * 0.018)
    block_h = sum(size for _, size, _ in lines) + gap * (len(lines) - 1)
    vertical = H > W
    if is_card or shot.get("layout") == "center":
        top, centered = (H - block_h) / 2, True
    elif vertical:
        top, centered = H * 0.70 - block_h, True  # clear of Instagram / TikTok captions
    else:
        top, centered = H - H * 0.10 - block_h, False

    t_in = 0.35 if idx > 0 or not is_card else 0.2
    t_out = dur - 0.35
    filters, y = [], top
    for n, (key, size, color) in enumerate(lines):
        text = str(shot[key]).upper() if key == "kicker" else str(shot[key])
        tf = work / f"text-{idx:02d}-{key}.txt"
        tf.write_text(text, encoding="utf-8")
        start = t_in + 0.12 * n
        x = "(w-text_w)/2" if centered else f"{round(W * 0.06)}"
        y_expr = f"{round(y)}+{round(base * 0.02)}*(1-clip((t-{start})/0.45,0,1))"
        filters.append(
            f"drawtext=fontfile='{style['font']}':textfile='{tf}':fontsize={size}:fontcolor={color}"
            f":x={x}:y='{y_expr}':alpha='{fade_alpha(start, t_out)}'"
            f":shadowcolor=black@0.55:shadowx=0:shadowy={max(2, size // 18)}"
            + (":line_spacing=8" if key != "kicker" else "")
        )
        y += size + gap
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
        if source.suffix.lower() in {".heic", ".heif"}:
            jpg = work / f"src-{idx:02d}.jpg"
            run(["sips", "-s", "format", "jpeg", str(source), "--out", str(jpg)])
            source = jpg
        inputs = ["-i", str(source)]
        vf = [
            f"scale={2 * W}:{2 * H}:force_original_aspect_ratio=increase:flags=lanczos",
            f"crop={2 * W}:{2 * H}",
            zoompan_filter(shot.get("motion", "zoom_in"), frames, W, H, shot.get("motion_amount", 0.10)),
        ]
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
    if texts and not is_card:
        # Darken behind the titles so they stay readable on bright photos.
        centered = shot.get("layout") == "center"
        graph = f"[0:v]{','.join(vf)}[base];[1:v]format=rgba[scrim];[base][scrim]overlay=0:0,{','.join(texts)},format=yuv420p[out]"
        inputs += ["-loop", "1", "-i", str(scrim_image(W, H, work, centered))]
    else:
        graph = f"[0:v]{','.join(vf + texts)},format=yuv420p[out]"
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
        "-filter_complex", graph, "-map", "[out]", "-frames:v", str(frames), "-an", "-r", str(FPS),
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", str(out),
    ])
    return out


def scrim_image(W: int, H: int, work: Path, centered: bool) -> Path:
    path = work / f"scrim-{'center' if centered else 'lower'}.png"
    if not path.exists():
        if centered:
            alpha = "120*clip(1-hypot((X-W/2)/(W*0.55),(Y-H/2)/(H*0.45)),0,1)"
        else:
            alpha = "150*pow(clip((Y-H*0.45)/(H*0.55),0,1),1.6)"
        run([
            "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=black:s={W}x{H}",
            "-vf", f"format=rgba,geq=r=0:g=0:b=0:a='{alpha}'", "-frames:v", "1", str(path),
        ])
    return path


# ---------------------------------------------------------------- assembly


def fit_durations(shots: list[dict], target: float, T: float) -> list[float]:
    durs = [float(s.get("duration", 3)) for s in shots]
    needed = target + T * (len(durs) - 1)
    if abs(sum(durs) - needed) > 0.01:
        scale = needed / sum(durs)
        print(f"note: scaling shot lengths by {scale:.3f} so the video is exactly {target:g}s")
        durs = [d * scale for d in durs]
    if min(durs) < 2 * T + 0.5:
        raise ValueError(f"A shot is only {min(durs):.2f}s long; use fewer shots or a shorter transition")
    return durs


def shot_starts(durs: list[float], T: float) -> list[float]:
    starts, t = [], 0.0
    for d in durs:
        starts.append(t)
        t += d - T
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


def render(storyboard_path: Path, aspect: str | None, output: Path | None, use_ai: bool, placeholders: bool) -> Path:
    load_dotenv()
    sb = json.loads(storyboard_path.read_text())
    style = {**DEFAULT_STYLE, **sb.get("style", {})}
    if not Path(style["font"]).exists():
        style["font"] = "/System/Library/Fonts/Helvetica.ttc"
    aspect = aspect or sb.get("aspect", "16:9")
    W, H = SIZES[aspect]
    total = float(sb["duration"])
    T = float(style["transition_duration"])
    shots = sb["shots"]
    apply_info(shots, sb.get("info", {}))
    sb_dir = storyboard_path.parent
    output = output or Path("output") / f"{storyboard_path.stem}{'' if aspect == '16:9' else '-' + aspect.replace(':', 'x')}.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    cache_dir = output.parent / ".cache"
    cache_dir.mkdir(exist_ok=True)

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

    durs = fit_durations(shots, total, T)
    starts = shot_starts(durs, T)
    voice_cfg = sb.get("voice", {})
    provider = tts_provider(voice_cfg.get("provider", "auto"))
    voice = voice_cfg.get("voice") if voice_cfg.get("provider", "auto") != "auto" else None
    shown_voice = voice or (os.getenv("ELEVENLABS_VOICE_ID") if provider == "elevenlabs" else None) or DEFAULT_VOICES[provider]
    print(f"rendering {len(shots)} shots at {W}x{H}, {total:g}s, voice: {provider} ({shown_voice})")
    narration = plan_narration(shots, starts, total, provider, voice, cache_dir)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        segments = [render_shot(s, i, durs[i], W, H, work, style, sources[i]) for i, s in enumerate(shots)]

        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
        for seg in segments:
            cmd += ["-i", str(seg)]
        graph, last, length = [], "[0:v]", durs[0]
        for k in range(1, len(segments)):
            transition = shots[k].get("transition", style["transition"])
            graph.append(f"{last}[{k}:v]xfade=transition={transition}:duration={T}:offset={length - T:.3f}[v{k}]")
            last, length = f"[v{k}]", length + durs[k] - T
        graph.append(f"{last}format=yuv420p[vout]")

        n_in = len(segments)
        voice_labels = []
        for k, (audio, begin, tempo) in enumerate(narration):
            cmd += ["-i", str(audio)]
            ms = round(begin * 1000)
            graph.append(f"[{n_in}:a]aformat=sample_rates=48000:channel_layouts=stereo,atempo={tempo:.3f},adelay={ms}:all=1[n{k}]")
            voice_labels.append(f"[n{k}]")
            n_in += 1
        music = find_file(sb["music"], sb_dir) if sb.get("music") else None
        if sb.get("music") and music is None:
            raise FileNotFoundError(f"Music file not found: {sb['music']}")

        if voice_labels:
            graph.append(f"{''.join(voice_labels)}amix=inputs={len(voice_labels)}:normalize=0,apad[voice]")
        if music:
            cmd += ["-stream_loop", "-1", "-i", str(music)]
            graph.append(
                f"[{n_in}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{total},volume={style['music_volume']},"
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
