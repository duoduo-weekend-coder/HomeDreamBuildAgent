"""FFmpeg renderer: Ken Burns stills -> crossfades -> caption overlays -> voice + ducked music."""
import random
import subprocess
from dataclasses import dataclass
from pathlib import Path

from dreamhome.config import ROOT
from dreamhome.reels.captions import Caption, render_text_png
from dreamhome.reels.images import vertical_frame

W, H, FPS = 1080, 1920, 30
XFADE = 0.4
MUSIC_DIR = ROOT / "assets" / "music"


@dataclass
class ShotTiming:
    image: Path
    start: float
    duration: float


def pick_music() -> Path | None:
    tracks = [p for p in MUSIC_DIR.glob("*") if p.suffix.lower() in {".mp3", ".m4a", ".wav", ".aac"}]
    return random.choice(tracks) if tracks else None


# Camera moves applied to stills. `p` is eased progress 0->1 (slow start, slow finish).
EASE = "(0.5-0.5*cos(PI*on/{n}))"
MOVES = {
    "push_in":    ("1+0.22*{p}",       "iw/2-(iw/zoom/2)",            "ih/2-(ih/zoom/2)"),
    "pull_out":   ("1.22-0.22*{p}",    "iw/2-(iw/zoom/2)",            "ih/2-(ih/zoom/2)"),
    "pan_right":  ("1.18",             "(iw-iw/zoom)*{p}",            "ih/2-(ih/zoom/2)"),
    "pan_left":   ("1.18",             "(iw-iw/zoom)*(1-{p})",        "ih/2-(ih/zoom/2)"),
    "tilt_up":    ("1.18",             "iw/2-(iw/zoom/2)",            "(ih-ih/zoom)*(1-{p})"),
    "push_in_up": ("1+0.20*{p}",       "iw/2-(iw/zoom/2)",            "(ih/2-(ih/zoom/2))*(1-0.6*{p})"),
}
# hook pushes in, the reveal at the end pulls out, the middle alternates direction
SEQUENCE = ["pan_right", "push_in_up", "pan_left", "push_in", "tilt_up", "pan_right", "push_in"]


def move_for(i: int, n: int) -> str:
    if i == 0:
        return "push_in"
    if i == n - 1:
        return "pull_out"
    return SEQUENCE[(i - 1) % len(SEQUENCE)]


def _zoompan(move: str, frames: int) -> str:
    p = EASE.format(n=max(frames - 1, 1))
    z, x, y = (expr.format(p=p) for expr in MOVES[move])
    return f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={W}x{H}:fps={FPS}"


def build_command(shots: list[ShotTiming], captions: list[tuple[Path, Caption]], hook_png: Path | None,
                  voice: Path, music: Path | None, out: Path, total: float,
                  cards: list[tuple[Path, str, float, float]] = ()) -> list[str]:
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    filters = []
    n = len(shots)
    for s in shots:
        cmd += ["-i", str(s.image)]
    for i, s in enumerate(shots):
        length = s.duration + (XFADE if i < n - 1 else 0)
        frames = max(2, round(length * FPS))
        filters.append(f"[{i}:v]{_zoompan(move_for(i, n), frames)},setsar=1,format=yuv420p,trim=duration={length:.3f}[s{i}]")

    prev = "s0"
    for i in range(1, n):
        offset = shots[i].start  # see docstring in pipeline: clip i begins exactly when its narration starts
        filters.append(f"[{prev}][s{i}]xfade=transition=fade:duration={XFADE}:offset={offset:.3f}[x{i}]")
        prev = f"x{i}"

    idx = n
    overlays = []
    if hook_png:
        overlays.append((hook_png, "(W-w)/2", "H*0.12", 0.0, max(2.5, shots[0].duration)))
    for png, y, a, b in cards:
        overlays.append((png, "(W-w)/2", y, a, b))
    for png, cap in captions:
        overlays.append((png, "(W-w)/2", "H*0.70", cap.start, cap.end))
    for j, (png, x, y, a, b) in enumerate(overlays):
        cmd += ["-i", str(png)]
        filters.append(f"[{prev}][{idx}:v]overlay=x={x}:y={y}:enable='between(t,{a:.3f},{b:.3f})'[o{j}]")
        prev = f"o{j}"
        idx += 1

    cmd += ["-i", str(voice)]
    voice_idx = idx
    idx += 1
    if music:
        cmd += ["-stream_loop", "-1", "-i", str(music)]
        filters.append(f"[{voice_idx}:a]aresample=44100,apad,asplit=2[vo][sc]")
        filters.append(f"[{idx}:a]aresample=44100,volume=0.35,afade=t=in:d=1,"
                       f"afade=t=out:st={max(0, total - 1.5):.3f}:d=1.5[m]")
        filters.append("[m][sc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[md]")
        filters.append("[vo][md]amix=inputs=2:duration=first:normalize=0[a]")
    else:
        filters.append(f"[{voice_idx}:a]aresample=44100,apad[a]")

    cmd += ["-filter_complex", ";".join(filters), "-map", f"[{prev}]", "-map", "[a]",
            "-t", f"{total:.3f}", "-r", str(FPS),
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-profile:v", "high",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", str(out)]
    return cmd


MIN_SHOT = 1.2


def normalize_starts(starts: list[float], total: float) -> list[float]:
    """First shot starts at 0 and every shot gets at least MIN_SHOT seconds, so xfade offsets
    (which equal shot start times) are strictly increasing and each clip outlasts its transition."""
    out = [0.0]
    for s in starts[1:]:
        out.append(max(s, out[-1] + MIN_SHOT))
    # if pushing starts forward overran the end, squeeze back from the tail
    limit = total - MIN_SHOT
    for i in range(len(out) - 1, 0, -1):
        if out[i] > limit:
            out[i] = limit
        limit = out[i] - MIN_SHOT
    return out


def render(images: list[Path], segment_starts: list[float], voice_duration: float, captions: list[Caption],
           hook: str, voice: Path, workdir: Path, out: Path, music: Path | None = None,
           cards: list[tuple[str, float, float, str]] = ()) -> Path:
    """`cards` are extra on-screen text blocks: (text, start_s, end_s, y_expr) e.g. a stat card or CTA.
    A negative end means "until the end of the video"."""
    workdir.mkdir(parents=True, exist_ok=True)
    total = voice_duration + 0.8
    starts = normalize_starts(segment_starts, total)
    shots = []
    for i, img in enumerate(images):
        end = starts[i + 1] if i + 1 < len(images) else total
        frame = vertical_frame(img, workdir / f"frame_{i:02d}.jpg")
        shots.append(ShotTiming(frame, starts[i], end - starts[i]))
    cap_pngs = [(render_text_png(c.text.upper(), workdir / f"cap_{j:03d}.png"), c) for j, c in enumerate(captions)]
    hook_png = render_text_png(hook, workdir / "hook.png", size=92, banner=True) if hook else None
    card_pngs = [(render_text_png(t, workdir / f"card_{k:02d}.png", size=56, banner=True), y, a, total if b < 0 else b)
                 for k, (t, a, b, y) in enumerate(cards)]
    cmd = build_command(shots, cap_pngs, hook_png, voice, music if music is not None else pick_music(), out, total, card_pngs)
    subprocess.run(cmd, check=True)
    return out
