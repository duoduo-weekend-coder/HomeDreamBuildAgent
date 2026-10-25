"""Image loading/normalisation shared by the selector and renderer."""
import base64
import io
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()  # iPhone photos
except ImportError:  # pragma: no cover
    pass


def open_rgb(path: Path) -> Image.Image:
    img = Image.open(path)
    return ImageOps.exif_transpose(img).convert("RGB")


def thumbnail_b64(path: Path, max_side: int = 768) -> str:
    img = open_rgb(path)
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return base64.standard_b64encode(buf.getvalue()).decode()


def vertical_frame(path: Path, out: Path, size: tuple[int, int] = (2160, 3840), straighten: bool = True) -> Path:
    """Fit any photo into a 9:16 frame (oversized so Ken Burns has room to zoom).
    Portrait photos are cover-cropped; landscape/drone shots sit on a blurred copy of themselves
    instead of losing two thirds of the picture. Tilted/keystoned photos are straightened first.
    Frames are 2x the output size so zoompan's integer pixel steps don't cause visible jitter."""
    img = open_rgb(path)
    if straighten:
        from dreamhome.reels.straighten import correct

        img, _ = correct(img)
    w, h = size
    if img.width / img.height <= 0.8:
        frame = ImageOps.fit(img, size, Image.LANCZOS)
    else:
        frame = ImageOps.fit(img, size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
        fg = ImageOps.contain(img, (w, int(h * 0.62)), Image.LANCZOS)
        frame.paste(fg, ((w - fg.width) // 2, (h - fg.height) // 2))
    frame.save(out, "JPEG", quality=92)
    return out
