"""Automatic straightening for architecture photos.

Near-vertical edges (walls, door frames, window mullions) should be vertical. For each detected line we
measure its lean from vertical and fit  lean(x) = tilt + keystone * x_offset :
  * tilt     – camera roll; every vertical leans the same way
  * keystone – camera pitched up/down; verticals converge, lean grows with distance from centre
A single perspective warp removes both, then the frame is cropped to drop any empty corners."""
import math
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

MAX_TILT_DEG = 7.0       # larger leans are probably intentional (dutch angle) or misdetections
MAX_EDGE_LEAN_DEG = 12.0  # cap keystone correction at the frame edges
KEYSTONE_STRENGTH = 0.85  # full correction can look stretched; leave a hint of perspective
MIN_LINES = 6


@dataclass
class Correction:
    tilt_deg: float        # positive = verticals' tops lean right
    keystone_deg: float    # lean at the right frame edge minus centre; negative = converging upward
    lines: int
    applied: bool


def _lines(gray: np.ndarray) -> np.ndarray:
    h, w = gray.shape
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 50, 150)
    found = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=80, minLineLength=int(0.10 * h), maxLineGap=8)
    return np.empty((0, 4)) if found is None else found.reshape(-1, 4).astype(float)


def estimate(gray: np.ndarray) -> Correction:
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
        return Correction(0.0, 0.0, len(rows), False)
    lean, xo, wt = map(np.array, zip(*rows))
    # weighted least squares, then one pass of outlier rejection
    for _ in range(2):
        A = np.stack([np.ones_like(xo), xo], 1) * np.sqrt(wt)[:, None]
        tilt, key = np.linalg.lstsq(A, lean * np.sqrt(wt), rcond=None)[0]
        keep = np.abs(lean - (tilt + key * xo)) < 2.5
        if keep.sum() < MIN_LINES:
            break
        lean, xo, wt = lean[keep], xo[keep], wt[keep]
    return Correction(float(tilt), float(key), int(len(lean)), True)


def correct(img: Image.Image) -> tuple[Image.Image, Correction]:
    arr = np.asarray(img)
    small = cv2.resize(arr, None, fx=1200 / max(arr.shape[:2]), fy=1200 / max(arr.shape[:2]))
    c = estimate(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY))
    if not c.applied:
        return img, c
    tilt = max(-MAX_TILT_DEG, min(MAX_TILT_DEG, c.tilt_deg))
    key = max(-MAX_EDGE_LEAN_DEG, min(MAX_EDGE_LEAN_DEG, c.keystone_deg)) * KEYSTONE_STRENGTH
    if abs(tilt) < 0.3 and abs(key) < 0.5:
        c.applied = False
        return img, c
    h, w = arr.shape[:2]
    # shift of each top corner needed to make the vertical through it upright
    lean_l, lean_r = math.radians(tilt - key), math.radians(tilt + key)
    dx_l, dx_r = -math.tan(lean_l) * h, -math.tan(lean_r) * h
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[dx_l, 0], [w + dx_r, 0], [w, h], [0, h]])
    warped = cv2.warpPerspective(arr, cv2.getPerspectiveTransform(src, dst), (w, h), flags=cv2.INTER_CUBIC)
    # crop away the empty wedges the warp left at the top corners
    left, right = int(math.ceil(max(0.0, dx_l))), int(math.floor(min(w, w + dx_r)))
    warped = warped[:, left:right]
    return Image.fromarray(warped), c
