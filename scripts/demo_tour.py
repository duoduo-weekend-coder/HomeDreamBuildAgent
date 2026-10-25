"""Full walkthrough of the White House: every unique scene once, in tour order, DUMMY facts.
Scenes come from data/image_index/whitehouse_scenes.json (near-duplicates merged, unusable photos excluded).
Usage: uv run python scripts/demo_tour.py"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


from PIL import ImageFilter  # noqa: E402

from dreamhome.config import MEDIA_DIR, ROOT  # noqa: E402
from dreamhome.integrations.elevenlabs import Word, audio_duration, synthesize  # noqa: E402
from dreamhome.reels import renderer  # noqa: E402
from dreamhome.reels.captions import chunk_words  # noqa: E402
from dreamhome.reels.images import open_rgb  # noqa: E402

WH = Path("/Users/chenge/Downloads/whitehouse")
SHOT_S = 1.3  # base time per photo
FACTS = {"city": "SEATTLE, WA", "beds": 4, "baths": 3.5, "sqft": "3,200", "months": 10}  # dummy

# (title, photo numbers in walking order, voiceover lines — shots are split evenly across lines)
SECTIONS = [
    ("EXTERIOR", [995], ["Seattle. Four bedrooms, built in ten months, on schedule. Let's walk through."]),
    ("ENTRY", [958], ["Double doors open onto the main floor."]),
    ("LIVING ROOM", [880, 883, 886, 964, 873, 961, 875, 878, 876],
     ["A floating steel staircase and a black marble fireplace.", "Two-storey windows bring the trees right inside."]),
    ("MAIN FLOOR", [864, 859, 861, 866, 863, 959], ["The main floor stays open and bright, with room to grow."]),
    ("KITCHEN", [846, 852, 849, 856, 858, 872, 850, 853, 855, 854, 868, 874, 869, 870],
     ["The kitchen is the heart of it: a stone island under a linear pendant.",
      "Custom cabinets, built-in ovens, and a butler's pantry behind."]),
    ("STAIRCASE", [887, 888, 895, 889, 891, 892, 894, 903, 900],
     ["Oak treads and steel rails carry you up.", "Every landing gets its own window."]),
    ("UPSTAIRS", [904, 905, 907, 910, 983, 909, 931, 896, 897, 898, 899, 982],
     ["Upstairs, a loft looks over the living room.", "And the chandelier hangs right at eye level."]),
    ("PRIMARY SUITE", [913, 914, 915, 927, 916, 917, 918, 919, 920],
     ["The primary suite has a walk-in closet,", "a freestanding tub, and a frameless glass shower."]),
    ("BEDROOMS", [906, 932, 933, 934, 940], ["Three more bedrooms, each with big windows."]),
    ("BATHROOMS", [935, 936, 922, 938, 955], ["Every bathroom gets a floating vanity and stone tops."]),
    ("LAUNDRY", [930, 929], ["Laundry has its own sink and storage."]),
    ("LOWER LEVEL", [890, 893, 942, 945, 947, 949, 950, 951, 952, 953],
     ["Downstairs is built for weekends.", "A wet bar with a wine fridge, plus a guest bedroom."]),
    ("GARAGE", [993], ["A finished garage."]),
    ("BACKYARD", [970, 980, 981, 973, 974, 977], ["Out back, a covered patio and stacked balconies over the trees."]),
    ("ROOFTOP", [987, 988, 991, 990, 989],
     ["And the best part? A private rooftop deck. Comment BUILD to see how we built it."]),
]
# Per-photo crop (fractions of width, height) applied before framing, e.g. to cut a road-work sign.
CROPS = {995: (0.04, 0.0, 0.50, 1.0)}
# Regions to blur (fractions of the original photo), e.g. house numbers for privacy.
BLURS = {995: [(0.238, 0.615, 0.272, 0.725)]}


def photo(n: int, work: Path) -> Path:
    src = WH / f"DSC00{n}.JPG"
    if n not in CROPS and n not in BLURS:
        return src
    img = open_rgb(src)
    for l, t, r, b in BLURS.get(n, []):
        box = (int(l * img.width), int(t * img.height), int(r * img.width), int(b * img.height))
        img.paste(img.crop(box).filter(ImageFilter.GaussianBlur(25)), box)
    l, t, r, b = CROPS.get(n, (0, 0, 1, 1))
    out = work / f"prep_{n}.jpg"
    img.crop((int(l * img.width), int(t * img.height), int(r * img.width), int(b * img.height))).save(out, quality=95)
    return out


def check_coverage() -> None:
    scenes = json.loads((ROOT / "data/image_index/whitehouse_scenes.json").read_text())["scenes"]
    reps = {int(s["rep"][5:8]) for s in scenes}
    used = [n for _, nums, _ in SECTIONS for n in nums]
    assert len(used) == len(set(used)), "a photo is used twice"
    missing, extra = reps - set(used), set(used) - reps
    assert not missing and not extra, f"missing scenes {sorted(missing)}, non-scene photos {sorted(extra)}"


def section_audio(lines: list[str], n_shots: int, work: Path, tag: str):
    """Voice per line, each padded to the time its shots need. Returns (audio, words, per-shot starts, total)."""
    per_line = [n_shots // len(lines) + (1 if i < n_shots % len(lines) else 0) for i in range(len(lines))]
    parts, words, starts, t = [], [], [], 0.0
    for i, (line, k) in enumerate(zip(lines, per_line)):
        mp3 = work / f"{tag}_{i}.mp3"
        ws = synthesize(line, mp3)
        dur = max(k * SHOT_S, audio_duration(mp3) + 0.5)
        words += [Word(w.text, w.start + t, w.end + t) for w in ws]
        starts += [t + j * dur / k for j in range(k)]
        parts.append((mp3, dur))
        t += dur
    audio = work / f"{tag}.m4a"
    inputs = sum((["-i", str(p)] for p, _ in parts), [])
    chains = "".join(f"[{i}:a]aresample=44100,apad,atrim=duration={d:.3f}[a{i}];" for i, (_, d) in enumerate(parts))
    concat = "".join(f"[a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[out]"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", chains + concat,
                    "-map", "[out]", "-c:a", "aac", "-b:a", "160k", str(audio)], check=True)
    return audio, words, starts, t


def main() -> None:
    check_coverage()
    work = MEDIA_DIR / "demo_tour"
    work.mkdir(parents=True, exist_ok=True)
    pieces = []
    for idx, (title, nums, lines) in enumerate(SECTIONS, 1):
        tag = f"s{idx:02d}"
        audio, words, starts, total = section_audio(lines, len(nums), work, tag)
        if idx == 1:
            f = FACTS
            cards = [(f"{f['city']}\n{f['beds']} BED · {f['baths']} BATH · {f['sqft']} SQ FT", 0.0, -1, "H*0.08"),
                     (f"BUILT IN {f['months']} MONTHS\nON TIME", 0.5, -1, "H*0.24")]
        else:
            cards = [(f"{idx - 1}. {title}", 0.0, min(2.2, total), "H*0.10")]
        if idx == len(SECTIONS):
            cards.append(('COMMENT "BUILD"\nTO SEE HOW WE BUILT IT', max(0.0, total - 4.0), -1, "H*0.24"))
        out = work / f"{tag}.mp4"
        renderer.render(images=[photo(n, work) for n in nums], segment_starts=starts,
                        voice_duration=total - 0.8, captions=chunk_words(words), hook="", voice=audio,
                        workdir=work / tag, out=out, cards=cards)
        pieces.append(out)
        print(f"{idx:2d}. {title:14s} {len(nums):2d} photos {total:5.1f}s", flush=True)
    listing = work / "pieces.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in pieces))
    final = MEDIA_DIR / "demo_tour.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
                    "-c", "copy", "-movflags", "+faststart", str(final)], check=True)
    print(final, f"{audio_duration(final):.1f}s")


if __name__ == "__main__":
    main()
