"""Turns word timings into caption chunks and renders them as transparent PNGs.
(Homebrew FFmpeg ships without libass/drawtext, so captions are composited with `overlay`.)"""
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from dreamhome.config import ROOT
from dreamhome.integrations.elevenlabs import Word

FONT_WEIGHT = 800  # Montserrat ExtraBold, matches the reference style
FONT_CANDIDATES = [
    ROOT / "assets" / "fonts" / "Montserrat.ttf",  # variable font, SIL OFL (assets/fonts/OFL.txt)
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]


@dataclass
class Caption:
    text: str
    start: float
    end: float


def chunk_words(words: list[Word], max_words: int = 3, max_chars: int = 18) -> list[Caption]:
    """Group words into short punchy lines; break after punctuation."""
    out: list[Caption] = []
    cur: list[Word] = []
    for w in words:
        cur.append(w)
        text = " ".join(x.text for x in cur)
        if len(cur) >= max_words or len(text) >= max_chars or w.text[-1] in ".,!?;:":
            out.append(Caption(text, cur[0].start, cur[-1].end))
            cur = []
    if cur:
        out.append(Caption(" ".join(x.text for x in cur), cur[0].start, cur[-1].end))
    # hold each caption until the next one starts so the screen never flickers empty mid-sentence
    for a, b in zip(out, out[1:]):
        if b.start - a.end < 0.35:
            a.end = b.start
    return out


def _font(size: int) -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if p.exists():
            font = ImageFont.truetype(str(p), size)
            try:
                font.set_variation_by_axes([FONT_WEIGHT])
            except OSError:  # static font without a weight axis
                pass
            return font
    return ImageFont.load_default(size)


def render_text_png(text: str, out: Path, size: int = 84, max_width: int = 960, banner: bool = False) -> Path:
    """White heavy text, no box or outline, with a soft drop shadow so it stays readable on bright photos.
    `banner` is kept for call-site compatibility and only adds a little extra letter spacing room."""
    font = _font(size)
    draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    # greedy wrap; explicit newlines force a break
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            trial = f"{line} {word}".strip()
            if draw.textlength(trial, font=font) <= max_width or not line:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    pad = size // 2
    line_h = int(size * 1.18)
    w = int(max(draw.textlength(l, font=font) for l in lines)) + pad * 2
    h = line_h * len(lines) + pad * 2
    text_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(text_layer)
    y = pad
    for l in lines:
        d.text(((w - d.textlength(l, font=font)) / 2, y), l, font=font, fill="white")
        y += line_h
    alpha = text_layer.getchannel("A")
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    shadow.putalpha(alpha.point(lambda a: a * 0.9))
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(3, size // 8)))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    img.alpha_composite(shadow, (0, max(2, size // 22)))
    img.alpha_composite(text_layer)
    img.save(out)
    return out
