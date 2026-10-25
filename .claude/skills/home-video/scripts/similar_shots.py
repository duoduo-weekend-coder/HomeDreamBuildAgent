#!/usr/bin/env python3
"""Rate every shot's sharpness and exposure, and group near-duplicates of the same scene.

For each photo (and the middle frame of each clip) it measures sharpness (variance of the
Laplacian of the sharpest 1/16 of a 1000 px copy) and exposure (mean brightness, clipped highlights, crushed
shadows). Shots of the same scene from almost the same position are grouped by ORB feature
matching (ratio test + RANSAC homography): a group needs many geometric inliers AND a
mostly overlapping, gently transformed frame, so a different angle of the same room starts
a new scene. The sharpest, best-exposed shot of each group is marked as its representative.

    python similar_shots.py <folder>

Writes <folder>/.index/scenes.json and scenes.md. Features are cached in
<folder>/.index/features/, so re-runs only process new or changed files.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
ANALYSIS_PX = 1000      # long side for sharpness / exposure
FEATURE_PX = 800        # long side for ORB
N_FEATURES = 2000
RATIO = 0.75            # Lowe ratio test
MIN_INLIERS = 60        # homography inliers needed to call two shots the same scene
MIN_INLIER_FRAC = 0.30  # inliers / ratio-test matches
MIN_OVERLAP = 0.55      # share of each frame covered by the other after warping
MAX_SCALE = 1.5         # zoom between the two framings
MAX_PERSP = 0.4         # perspective change (camera swung to a new angle)
LINKAGE = 0.5           # a shot joins a group only if it matches at least half of the group's pairs (stops chaining)
NEIGHBOURS = 12         # compare each shot with this many shots before it in capture order ...
GLOBAL_TOP = 6          # ... plus its most similar shots anywhere (tiny-image correlation)
CACHE_VERSION = 2       # bump when the cached measurements change


def load_gray(path: Path, tmp: Path) -> np.ndarray | None:
    ext = path.suffix.lower()
    src = path
    if ext in {".heic", ".heif"}:
        src = tmp / f"{path.stem}.jpg"
        subprocess.run(["sips", "-s", "format", "jpeg", "-Z", str(ANALYSIS_PX), str(path), "--out", str(src)],
                       capture_output=True, check=True)
    elif ext in VIDEO_EXTS:
        src = tmp / f"{path.stem}-mid.jpg"
        dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True).stdout.strip()
        mid = float(dur or 0) / 2
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{mid:.2f}", "-i", str(path), "-frames:v", "1",
                        "-vf", f"scale='min({ANALYSIS_PX},iw)':-2", str(src)], capture_output=True, check=True)
    img = cv2.imread(str(src), cv2.IMREAD_REDUCED_GRAYSCALE_2 if ext in {".jpg", ".jpeg"} else cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    s = ANALYSIS_PX / max(img.shape)
    if s < 1:
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return img


def analyse(img: np.ndarray, orb) -> dict:
    lap = cv2.Laplacian(img, cv2.CV_64F)
    # Judge the sharpest region (1/16 of the frame): plain white walls have no detail, but a sharp photo still
    # has crisp edges somewhere, while camera shake or missed focus softens all of them.
    h, w = img.shape
    tiles = [lap[y * h // 4:(y + 1) * h // 4, x * w // 4:(x + 1) * w // 4].var() for y in range(4) for x in range(4)]
    s = FEATURE_PX / max(img.shape)
    small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img
    kps, des = orb.detectAndCompute(small, None)
    tiny = cv2.resize(img, (32, 24), interpolation=cv2.INTER_AREA).astype(np.float32).ravel()
    return {
        "sharpness": float(lap.var()),
        "sharp_peak": float(max(tiles)),
        "mean": float(img.mean()),
        "clipped": float((img >= 250).mean()),
        "crushed": float((img <= 5).mean()),
        "size": small.shape[::-1],
        "pts": np.float32([k.pt for k in kps]) if kps else np.zeros((0, 2), np.float32),
        "des": des if des is not None else np.zeros((0, 32), np.uint8),
        "tiny": (tiny - tiny.mean()) / (tiny.std() + 1e-6),
        "aspect": img.shape[1] / img.shape[0],
    }


def features(path: Path, cache: Path, orb, tmp: Path) -> dict | None:
    st = path.stat()
    key = cache / f"{path.name}-{int(st.st_mtime)}-{st.st_size}-v{CACHE_VERSION}.npz"
    if key.exists():
        z = np.load(key, allow_pickle=False)
        f = {k: z[k] for k in z.files}
        for k in ("sharpness", "sharp_peak", "mean", "clipped", "crushed", "aspect"):
            f[k] = float(f[k])
        f["size"] = tuple(int(v) for v in f["size"])
        return f
    try:
        img = load_gray(path, tmp)
    except subprocess.CalledProcessError:
        img = None
    if img is None:
        print(f"note: could not read {path.name}", file=sys.stderr)
        return None
    f = analyse(img, orb)
    for old in cache.glob(f"{path.name}-*.npz"):
        old.unlink()
    np.savez_compressed(key, **f)
    return f


def same_scene(a: dict, b: dict, matcher) -> tuple[bool, dict]:
    if len(a["des"]) < 20 or len(b["des"]) < 20:
        return False, {}
    good = []
    for pair in matcher.knnMatch(a["des"], b["des"], k=2):
        if len(pair) == 2 and pair[0].distance < RATIO * pair[1].distance:
            good.append(pair[0])
    if len(good) < MIN_INLIERS:
        return False, {"matches": len(good)}
    src = a["pts"][[m.queryIdx for m in good]]
    dst = b["pts"][[m.trainIdx for m in good]]
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 6.0)
    if H is None:
        return False, {"matches": len(good)}
    inliers = int(mask.sum())
    info = {"matches": len(good), "inliers": inliers, "frac": round(inliers / len(good), 2)}
    if inliers < MIN_INLIERS or inliers / len(good) < MIN_INLIER_FRAC:
        return False, info
    # How gently does one frame map onto the other? Big zoom, strong perspective or little overlap = new angle.
    det = np.linalg.det(H[:2, :2])
    scale = np.sqrt(abs(det)) if det > 0 else 0
    persp = abs(H[2, 0]) * a["size"][0] + abs(H[2, 1]) * a["size"][1]
    overlap = min(_overlap(H, a["size"], b["size"]), _overlap(np.linalg.inv(H), b["size"], a["size"]))
    info.update(scale=round(float(scale), 2), persp=round(float(persp), 2), overlap=round(overlap, 2))
    ok = scale > 0 and 1 / MAX_SCALE <= scale <= MAX_SCALE and persp < MAX_PERSP and overlap >= MIN_OVERLAP
    return ok, info


def _overlap(H, size_a, size_b) -> float:
    """Share of frame B covered by frame A warped into B."""
    w, h = size_a
    corners = cv2.perspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2), H).reshape(-1, 2)
    W, Hh = size_b
    poly = corners.astype(np.float32)
    rect = np.float32([[0, 0], [W, 0], [W, Hh], [0, Hh]])
    try:
        area, _ = cv2.intersectConvexConvex(poly, rect)
    except cv2.error:
        return 0.0
    return float(area) / (W * Hh)


def exposure_notes(f: dict) -> list[str]:
    notes = []
    if f["mean"] < 60:
        notes.append("dark")
    elif f["mean"] > 200:
        notes.append("bright")
    if f["clipped"] > 0.08:
        notes.append(f"{f['clipped']:.0%} blown highlights")
    if f["crushed"] > 0.10:
        notes.append(f"{f['crushed']:.0%} crushed shadows")
    return notes


def score(f: dict, ref_sharp: float) -> float:
    sharp = min(f["sharp_peak"] / ref_sharp, 2.0) / 2
    expo = 1 - min(abs(f["mean"] - 125) / 125, 1) * 0.5 - min(f["clipped"] * 4, 0.6) - min(f["crushed"] * 3, 0.6)
    return sharp + expo


def hint(f: dict, ref_sharp: float) -> str:
    rel = f["sharp_peak"] / ref_sharp
    bad_expo = f["mean"] < 45 or f["mean"] > 215 or f["clipped"] > 0.3 or f["crushed"] > 0.3
    if rel < 0.03:
        return "weak (blurry)"
    if rel < 0.12:
        return "check (soft, or very plain)"
    if bad_expo:
        return "check (exposure)"
    return "ok"


def cluster(n: int, edges: dict[tuple[int, int], float]) -> list[list[int]]:
    """Average-linkage grouping: strongest matches first; two groups merge only if at least LINKAGE of
    their cross pairs matched, so A~B and B~C does not drag a different angle C in with A."""
    gid = list(range(n))
    members = {i: [i] for i in range(n)}
    for i, j in sorted(edges, key=lambda k: -edges[k]):
        gi, gj = gid[i], gid[j]
        if gi == gj:
            continue
        a, b = members[gi], members[gj]
        cross = sum((min(x, y), max(x, y)) in edges for x in a for y in b)
        if cross >= LINKAGE * len(a) * len(b):
            for x in b:
                gid[x] = gi
            a += b
            del members[gj]
    return sorted(members.values(), key=min)


def capture_order(files: list[Path], folder: Path) -> list[Path]:
    taken = {}
    idx = folder / ".index" / "index.json"
    if idx.exists():
        for e in json.loads(idx.read_text()).get("media", []):
            taken[Path(e["file"]).name] = e.get("taken", "")
    return sorted(files, key=lambda p: (taken.get(p.name, ""), p.name))


def run(folder: Path) -> dict:
    index_dir = folder / ".index"
    cache = index_dir / "features"
    cache.mkdir(parents=True, exist_ok=True)
    files = [p for p in folder.rglob("*") if p.is_file() and ".index" not in p.parts and not p.name.startswith(".")
             and p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS]
    files = capture_order(files, folder)
    orb = cv2.ORB_create(N_FEATURES)
    with tempfile.TemporaryDirectory() as tmp:
        feats = {}
        for i, p in enumerate(files, 1):
            f = features(p, cache, orb, Path(tmp))
            if f is not None:
                feats[p] = f
            if i % 50 == 0:
                print(f"  analysed {i}/{len(files)}", file=sys.stderr)
    paths = list(feats)
    n = len(paths)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    tiny = np.stack([feats[p]["tiny"] for p in paths]) if n else np.zeros((0, 768))
    corr = tiny @ tiny.T / tiny.shape[1] if n else np.zeros((0, 0))
    pairs = set()
    for i in range(n):
        for j in range(max(0, i - NEIGHBOURS), i):
            pairs.add((j, i))
        for j in np.argsort(-corr[i])[1:GLOBAL_TOP + 1]:
            pairs.add((min(i, int(j)), max(i, int(j))))
    edges, links = {}, []
    for i, j in sorted(pairs):
        a, b = feats[paths[i]], feats[paths[j]]
        if (a["aspect"] > 1) != (b["aspect"] > 1):
            continue  # portrait vs landscape is a different framing
        ok, info = same_scene(a, b, matcher)
        if ok:
            edges[(i, j)] = info["overlap"]
            links.append((paths[i].name, paths[j].name, info))

    ref_sharp = float(np.median([f["sharp_peak"] for f in feats.values()])) if n else 1.0
    scenes = []
    for members in cluster(n, edges):
        ranked = sorted(members, key=lambda i: -score(feats[paths[i]], ref_sharp))
        rep = feats[paths[ranked[0]]]
        scenes.append({
            "rep": str(paths[ranked[0]].relative_to(folder)),
            "members": [str(paths[i].relative_to(folder)) for i in ranked],
            "kind": "video" if paths[ranked[0]].suffix.lower() in VIDEO_EXTS else "photo",
            "sharpness": round(rep["sharpness"], 1),
            "sharp_rel": round(rep["sharp_peak"] / ref_sharp, 2),
            "mean": round(rep["mean"], 1),
            "clipped": round(rep["clipped"], 3),
            "crushed": round(rep["crushed"], 3),
            "exposure": exposure_notes(rep),
            "hint": hint(rep, ref_sharp),
            "member_hints": {str(paths[i].relative_to(folder)): hint(feats[paths[i]], ref_sharp) for i in ranked[1:]},
        })
    out = {"folder": str(folder), "shots": n, "scenes": scenes, "links": links,
           "params": {"min_inliers": MIN_INLIERS, "min_overlap": MIN_OVERLAP, "max_scale": MAX_SCALE, "max_persp": MAX_PERSP, "linkage": LINKAGE}}
    (index_dir / "scenes.json").write_text(json.dumps(out, indent=1))

    lines = [f"# Scenes: {folder}", "",
             f"{n} shots in {len(scenes)} scenes. The rep (first) is the sharpest, best-exposed shot of each group; "
             "use only the rep. A different angle of the same room is its own scene. Sharpness is relative to "
             "the folder's median shot (1.0 = typical). Hints are automatic (sharpness and exposure only; people, signs, "
             "house numbers and reflections are not detected); confirm them on the contact sheets.", "",
             "| # | rep | other members | sharpness | exposure | hint |", "|---|---|---|---|---|---|"]
    for k, s in enumerate(scenes, 1):
        others = ", ".join(Path(m).name + ("" if s["member_hints"][m] == "ok" else f" ({s['member_hints'][m].split(' ')[0]})")
                           for m in s["members"][1:])
        lines.append(f"| {k} | {s['rep']} | {others} | {s['sharp_rel']:.2f} | {', '.join(s['exposure']) or 'fine'} | {s['hint']} |")
    (index_dir / "scenes.md").write_text("\n".join(lines) + "\n")
    print(f"{n} shots -> {len(scenes)} scenes ({len(pairs)} pairs compared); see {index_dir / 'scenes.md'}")
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Rate shots and group near-duplicates of the same scene")
    parser.add_argument("folder", type=Path)
    args = parser.parse_args()
    if not args.folder.is_dir():
        sys.exit(f"error: {args.folder} is not a folder")
    run(args.folder)
