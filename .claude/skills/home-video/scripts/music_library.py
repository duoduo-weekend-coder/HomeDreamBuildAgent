#!/usr/bin/env python3
"""Measure a folder of music tracks and pick the best excerpt of each for every template and length.

    python3 .claude/skills/home-video/scripts/music_library.py ~/Downloads/songlib --into assets/music

Copies the tracks into --into (if given) and writes library.json + library.md there. For each track it records
tempo, loudness, brightness and energy shape, which templates it suits, and `starts`: the second to start the
music for each template and length, aligned to a bar. make_video.py reads `starts` automatically when a
storyboard's music file sits next to library.json and has no `music_start`.

Excerpt rules:
- showcase (vibe): steady, loud section that starts on a lift (a section change), so the flash teaser hits.
- build (process + final): quieter opening for the construction act, then a clear lift about 15-30% in,
  where the finished home starts.
- everything else: the loudest steady window.
Windows never include the intro silence or the track's final fade.
"""
import argparse
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from make_video import music_beat  # noqa: E402

AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"}
RATE = 22050
STEP = 0.5  # seconds per loudness frame
LENGTHS = (15, 30)


def loudness(path: Path) -> tuple[np.ndarray, float]:
    """dB per half second, and median spectral centroid (Hz) as a brightness measure."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    hop = int(RATE * STEP)
    frames = x[: len(x) // hop * hop].reshape(-1, hop)
    db = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-9)
    win = frames[:, :4096] * np.hanning(4096)
    spec = np.abs(np.fft.rfft(win, axis=1))
    freqs = np.fft.rfftfreq(4096, 1 / RATE)
    centroid = (spec * freqs).sum(1) / (spec.sum(1) + 1e-9)
    loud = db > np.median(db) - 10
    return db, float(np.median(centroid[loud])) if loud.any() else 0.0


def window(db: np.ndarray, t: float, length: float) -> np.ndarray:
    return db[int(t / STEP): int((t + length) / STEP)]


def score(db: np.ndarray, t: float, length: float, kind: str) -> float:
    w = window(db, t, length)
    if len(w) < length / STEP * 0.95 or w.min() < -40:  # runs past the end, or into silence
        return -1e9
    base = w.mean() - 0.5 * w.std()
    before = window(db, max(0.0, t - 2), 2)
    lift_at_start = (window(db, t, 2).mean() - before.mean()) if len(before) else 0.0
    if kind == "showcase":
        return base + 0.7 * np.clip(lift_at_start, 0, 6)
    if kind == "build":
        cut = int(len(w) * 0.2)
        lift = w[cut: cut + int(len(w) * 0.35)].mean() - w[:cut].mean()
        return w.mean() + 1.2 * np.clip(lift, 0, 8) - 0.3 * w[cut:].std()
    return base


def analyse(path: Path) -> dict:
    db, brightness = loudness(path)
    duration = len(db) * STEP
    # Tempo from the loudest minute (intros are often beatless), and a beat grid over the whole track.
    loud_start = max(0.0, float(np.argmax(np.convolve(db, np.ones(int(60 / STEP)), "valid"))) * STEP) if duration > 70 else 0.0
    period, _ = music_beat(path, loud_start, 60)
    _, phase = music_beat(path, 0.0, duration)
    bar = 4 * period
    end_limit = duration - 3.0  # stay clear of the final fade
    starts = {}
    for kind in ("showcase", "build", "default"):
        starts[kind] = {}
        for length in LENGTHS:
            candidates = np.arange(phase, end_limit - length, bar)
            if not len(candidates):
                continue
            best = max(candidates, key=lambda t: score(db, float(t), length, kind))
            starts[kind][str(length)] = round(float(best), 2)
    thirds = np.array_split(db[db > -40], 3)
    shape = "builds" if thirds[2].mean() - thirds[0].mean() > 4 else "steady" if db[db > -40].std() < 2.5 else "varied"
    bpm = 60 / period
    tone = "warm" if brightness < 1500 else "bright" if brightness > 2200 else "balanced"
    suits = []
    if bpm >= 95:
        suits.append("showcase")
    if bpm <= 100 and (tone != "bright" or shape == "builds"):
        suits.append("build")
    if 75 <= bpm <= 120:
        suits += ["walkthrough", "drone"]
    return {"duration": round(duration, 1), "bpm": round(bpm, 1), "loudness_db": round(float(np.median(db[db > -40])), 1),
            "brightness_hz": round(brightness), "tone": tone, "energy": shape, "suits": suits, "starts": starts}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--into", type=Path, help="copy the tracks here and write library.json next to them")
    args = ap.parse_args()
    dest = args.into or args.folder
    dest.mkdir(parents=True, exist_ok=True)
    lib_path = dest / "library.json"
    lib = json.loads(lib_path.read_text()) if lib_path.exists() else {"tracks": {}}
    for src in sorted(p for p in args.folder.iterdir() if p.suffix.lower() in AUDIO_EXTS):
        target = dest / src.name
        if args.into and (not target.exists() or target.stat().st_size != src.stat().st_size):
            shutil.copy2(src, target)
        info = analyse(target)
        lib["tracks"][src.name] = {**lib["tracks"].get(src.name, {}), **info}
        print(f"{src.name[:50]:50s} {info['bpm']:6.1f} bpm  {info['tone']:8s} {info['energy']:7s} suits {', '.join(info['suits'])}")
    lib["generated"] = date.today().isoformat()
    lib_path.write_text(json.dumps(lib, indent=2) + "\n")
    rows = ["# Music library", "",
            "Written by `music_library.py`. `starts` = where the music begins for each template and length (seconds).",
            "Check each track's license before publishing (`license` field; fill it in by hand).", "",
            "| Track | bpm | tone | energy | suits | license | build 15/30 | showcase 15/30 |", "|---|---|---|---|---|---|---|---|"]
    for name, t in lib["tracks"].items():
        b, s = t["starts"].get("build", {}), t["starts"].get("showcase", {})
        rows.append(f"| {name} | {t['bpm']} | {t['tone']} | {t['energy']} | {', '.join(t['suits'])} | {t.get('license', '?')} | "
                    f"{b.get('15', '-')} / {b.get('30', '-')} | {s.get('15', '-')} / {s.get('30', '-')} |")
    (dest / "library.md").write_text("\n".join(rows) + "\n")
    print(f"wrote {lib_path}")


if __name__ == "__main__":
    main()
