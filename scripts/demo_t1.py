"""Render template T1 (finished-home payoff) from White House photos with DUMMY facts.
Usage: uv run python scripts/demo_t1.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dreamhome.config import MEDIA_DIR  # noqa: E402
from dreamhome.integrations.elevenlabs import audio_duration, synthesize  # noqa: E402
from dreamhome.reels import renderer  # noqa: E402
from dreamhome.reels.captions import chunk_words  # noqa: E402
from dreamhome.reels.pipeline import segment_starts  # noqa: E402

WH = Path("/Users/chenge/Downloads/whitehouse")
# Dummy facts; replace with real numbers from the builder.
FACTS = {"city": "SEATTLE, WA", "beds": 4, "baths": 3.5, "sqft": "3,200", "months": 10}

# Template T1 slots: exterior -> living -> kitchen -> primary suite -> lower level -> best view last
SHOTS = [
    ("DSC00973.JPG", "Seattle. Four bedrooms. Built in ten months, and delivered on schedule."),
    ("DSC00961.JPG", "Two-storey windows pull the forest right inside."),
    ("DSC00883.JPG", "A black marble fireplace anchors the living room."),
    ("DSC00850.JPG", "A stone island and custom cabinets in the kitchen."),
    ("DSC00918.JPG", "The primary bath gets a freestanding tub."),
    ("DSC00947.JPG", "Downstairs, a wet bar for game night."),
    ("DSC00987.JPG", "And the best part?"),
    ("DSC00989.JPG", "A private rooftop deck. Comment BUILD to see how we built it."),
]


def main() -> None:
    work = MEDIA_DIR / "demo_t1"
    work.mkdir(parents=True, exist_ok=True)
    segments = [line for _, line in SHOTS]
    voice = work / "voice.mp3"
    words = synthesize(" ".join(segments), voice)
    starts = segment_starts(segments, words)
    dur = audio_duration(voice)
    f = FACTS
    cards = [
        (f"{f['city']}\n{f['beds']} BED · {f['baths']} BATH · {f['sqft']} SQ FT", 0.0, starts[1], "H*0.10"),
        (f"BUILT IN {f['months']} MONTHS\nON TIME", 0.6, starts[1], "H*0.27"),
        ('COMMENT "BUILD"\nTO SEE HOW WE BUILT IT', starts[-1], -1, "H*0.12"),
    ]
    out = MEDIA_DIR / "demo_t1.mp4"
    renderer.render(
        images=[WH / name for name, _ in SHOTS],
        segment_starts=starts,
        voice_duration=dur,
        captions=chunk_words(words),
        hook="",
        voice=voice,
        workdir=work,
        out=out,
        cards=cards,
    )
    print(out, f"{dur + 0.8:.1f}s")


if __name__ == "__main__":
    main()
