#!/usr/bin/env python3
"""Prepare a photo for a video frame: privacy edits, straightening, framing.

Per shot (all coordinates are fractions 0-1 of the original, EXIF-rotated photo):
  crop: [l, t, r, b]              keep only this box (e.g. to cut off a house number)
  blur: [[l, t, r, b], ...]       Gaussian-blur these boxes (faces, plates, addresses)
  fit: "auto" | "cover" | "contain"
  straighten: true | false        fix tilted / converging verticals (default true)

The result is a JPEG at 2W x 2H (zoompan supersamples), cached by content of the
request so re-renders are instant.

    python3 prep_photo.py photo.jpg --aspect 9:16 -o out.jpg [--no-straighten] [--fit contain]
"""

import argparse
import hashlib
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

VERSION = 1  # bump when the output for the same inputs changes

SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}

# Straightening (ported from dreamhome/reels/straighten.py)
MAX_TILT_DEG = 7.0        # larger leans are probably intentional (dutch angle) or misdetections
MAX_EDGE_LEAN_DEG = 12.0  # cap keystone correction at the frame edges
KEYSTONE_STRENGTH = 0.85  # full correction can look stretched; leave a hint of perspective
MIN_LINES = 6

# "auto" fit: cover when the photo's aspect is within this fraction of the frame's.
# A 3:4 photo in a 9:16 frame (exactly 25% off) is still covered, like the old renderer.
AUTO_COVER_TOLERANCE = 0.26


# ---------------------------------------------------------------- loading

def open_rgb(path: Path) -> Image.Image:
    path = Path(path)
    try:
        img = Image.open(path)
        img.load()
    except Exception:
        if path.suffix.lower() not in {".heic", ".heif"}:
            raise
        # Pillow without pillow-heif can't read HEIC; macOS sips can.
        with tempfile.TemporaryDirectory() as tmp:
            jpg = Path(tmp) / "src.jpg"
            subprocess.run(["sips", "-s", "format", "jpeg", str(path), "--out", str(jpg)],
                           check=True, capture_output=True)
            img = Image.open(jpg)
            img.load()
    return ImageOps.exif_transpose(img).convert("RGB")


# ---------------------------------------------------------------- privacy edits

def _box(frac, w: int, h: int) -> tuple[int, int, int, int]:
    l, t, r, b = (float(v) for v in frac)
    if not (0 <= l < r <= 1 and 0 <= t < b <= 1):
        raise ValueError(f"box {list(frac)} must be fractions [left, top, right, bottom] with left<right, top<bottom")
    return round(l * w), round(t * h), round(r * w), round(b * h)


def apply_privacy(img: Image.Image, crop=None, blur=None) -> Image.Image:
    w, h = img.size
    radius = max(3.0, 25 * max(w, h) / 6000)
    for frac in blur or []:
        box = _box(frac, w, h)
        img.paste(img.crop(box).filter(ImageFilter.GaussianBlur(radius)), box[:2])
    if crop:
        img = img.crop(_box(crop, w, h))
    return img


# ---------------------------------------------------------------- straightening

def _lines(gray):
    import cv2
    import numpy as np

    h, w = gray.shape
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 50, 150)
    found = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=80, minLineLength=int(0.10 * h), maxLineGap=8)
    return np.empty((0, 4)) if found is None else found.reshape(-1, 4).astype(float)


def estimate(gray) -> tuple[float, float, int, bool]:
    """Fit lean(x) = tilt + keystone * x over near-vertical lines. Returns (tilt, keystone, lines, ok)."""
    import numpy as np

    h, w = gray.shape
    rows = []
    for x1, y1, x2, y2 in _lines(gray):
        if y1 > y2:  # make (x1, y1) the top end
            x1, y1, x2, y2 = x2, y2, x1, y1
        length = math.hypot(x2 - x1, y2 - y1)
        lean = math.degrees(math.atan2(x1 - x2, y2 - y1))  # >0: top leans right
        if abs(lean) < 15:
            rows.append((lean, ((x1 + x2) / 2 - w / 2) / (w / 2), length))
    if len(rows) < MIN_LINES:
        return 0.0, 0.0, len(rows), False
    lean, xo, wt = map(np.array, zip(*rows))
    for _ in range(2):  # weighted least squares, then one pass of outlier rejection
        A = np.stack([np.ones_like(xo), xo], 1) * np.sqrt(wt)[:, None]
        tilt, key = np.linalg.lstsq(A, lean * np.sqrt(wt), rcond=None)[0]
        keep = np.abs(lean - (tilt + key * xo)) < 2.5
        if keep.sum() < MIN_LINES:
            break
        lean, xo, wt = lean[keep], xo[keep], wt[keep]
    return float(tilt), float(key), int(len(lean)), True


def straighten(img: Image.Image) -> tuple[Image.Image, tuple[float, float] | None]:
    """One perspective warp removing camera roll and keystone; returns (image, (tilt, keystone) or None)."""
    import cv2
    import numpy as np

    arr = np.asarray(img)
    s = 1200 / max(arr.shape[:2])
    small = cv2.resize(arr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    tilt, key, _, ok = estimate(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY))
    if not ok:
        return img, None
    tilt = max(-MAX_TILT_DEG, min(MAX_TILT_DEG, tilt))
    key = max(-MAX_EDGE_LEAN_DEG, min(MAX_EDGE_LEAN_DEG, key)) * KEYSTONE_STRENGTH
    if abs(tilt) < 0.3 and abs(key) < 0.5:
        return img, None
    h, w = arr.shape[:2]
    # shift of each top corner needed to make the vertical through it upright
    lean_l, lean_r = math.radians(tilt - key), math.radians(tilt + key)
    dx_l, dx_r = -math.tan(lean_l) * h, -math.tan(lean_r) * h
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[dx_l, 0], [w + dx_r, 0], [w, h], [0, h]])
    warped = cv2.warpPerspective(arr, cv2.getPerspectiveTransform(src, dst), (w, h), flags=cv2.INTER_CUBIC)
    # crop away the empty wedges the warp left at the top corners
    left, right = int(math.ceil(max(0.0, dx_l))), int(math.floor(min(w, w + dx_r)))
    return Image.fromarray(np.ascontiguousarray(warped[:, left:right])), (tilt, key)


# ---------------------------------------------------------------- framing

def choose_fit(fit: str, img_w: int, img_h: int, W: int, H: int) -> str:
    if fit in ("cover", "contain"):
        return fit
    if fit != "auto":
        raise ValueError(f"fit must be auto, cover or contain, not {fit!r}")
    a, b = img_w / img_h, W / H
    return "cover" if min(a, b) / max(a, b) >= 1 - AUTO_COVER_TOLERANCE else "contain"


def frame(img: Image.Image, W: int, H: int, fit: str) -> Image.Image:
    """Return a 2W x 2H frame. contain = whole photo on a blurred, darkened copy of itself."""
    size = (2 * W, 2 * H)
    cover = ImageOps.fit(img, size, Image.LANCZOS)
    if choose_fit(fit, img.width, img.height, W, H) == "cover":
        return cover
    bg = cover.filter(ImageFilter.GaussianBlur(40 * size[0] / 2160))
    bg = ImageEnhance.Brightness(bg).enhance(0.78)
    # In a tall frame leave room above/below (titles sit in the lower third); otherwise use the full frame.
    box = (size[0], int(size[1] * 0.62)) if H > W else (int(size[0] * 0.96), int(size[1] * 0.96))
    fg = ImageOps.contain(img, box, Image.LANCZOS)
    bg.paste(fg, ((size[0] - fg.width) // 2, (size[1] - fg.height) // 2))
    return bg


# ---------------------------------------------------------------- entry points

def prepare(source: Path, W: int, H: int, shot: dict, cache_dir: Path) -> Path:
    source = Path(source).resolve()
    crop, blur = shot.get("crop"), shot.get("blur") or []
    fit = shot.get("fit", "auto")
    do_straighten = bool(shot.get("straighten", True))
    key = json.dumps([str(source), source.stat().st_mtime, W, H, crop, blur, fit, do_straighten, VERSION])
    out = Path(cache_dir) / f"photo-{hashlib.sha1(key.encode()).hexdigest()[:16]}.jpg"
    if out.exists():
        return out
    img = apply_privacy(open_rgb(source), crop, blur)
    if do_straighten:
        img, corr = straighten(img)
        if corr:
            print(f"straighten {source.name}: tilt {corr[0]:+.1f}°, keystone {corr[1]:+.1f}°")
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp.jpg")
    frame(img, W, H, fit).save(tmp, "JPEG", quality=95)
    tmp.replace(out)
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("photo", type=Path)
    p.add_argument("--aspect", default="16:9", choices=SIZES)
    p.add_argument("-o", "--output", type=Path, required=True)
    p.add_argument("--no-straighten", action="store_true")
    p.add_argument("--fit", default="auto", choices=["auto", "cover", "contain"])
    p.add_argument("--crop", type=json.loads, help="JSON [l, t, r, b] fractions")
    p.add_argument("--blur", type=json.loads, help="JSON [[l, t, r, b], ...] fractions")
    a = p.parse_args()
    W, H = SIZES[a.aspect]
    shot = {"fit": a.fit, "straighten": not a.no_straighten, "crop": a.crop, "blur": a.blur}
    with tempfile.TemporaryDirectory() as tmp:
        result = prepare(a.photo, W, H, shot, Path(tmp))
        a.output.parent.mkdir(parents=True, exist_ok=True)
        Image.open(result).save(a.output, "JPEG", quality=95)
    print(a.output)


if __name__ == "__main__":
    sys.exit(main())
