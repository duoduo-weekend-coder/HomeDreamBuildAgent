"""Claude vision picks and orders the shots for one reel."""
from pathlib import Path

from pydantic import BaseModel, Field

from dreamhome.config import get_settings
from dreamhome.integrations import llm
from dreamhome.reels.images import thumbnail_b64

MAX_CANDIDATES = 24  # images sent to the model per batch; larger batches are sampled evenly


class Shot(BaseModel):
    index: int = Field(description="Index of the image as labelled in the prompt")
    shot_note: str = Field(description="What the image shows, in a few plain words, e.g. 'drone view of framed second floor'")


class Selection(BaseModel):
    shots: list[Shot] = Field(description="Chosen images in playback order")
    reason: str


SELECT_PROMPT = """You are the video editor for {business}, a {industry}.
Pick {n_min}-{n_max} of the photos above for a 15-40 second vertical Instagram reel about {project} ({date}).
Job-site notes: {notes}

Choose for: sharp and well-lit, a variety of angles (drone/wide, mid, detail), a clear progress story,
and shots that make the build look clean and professional (on time, on budget, quality).
Skip near-duplicates, blurry or dark frames, screenshots, and close-ups of people's faces.
Order them so the strongest, most impressive frame comes first as the hook."""


def sample(paths: list[Path], k: int = MAX_CANDIDATES) -> list[Path]:
    if len(paths) <= k:
        return list(paths)
    step = len(paths) / k
    return [paths[int(i * step)] for i in range(k)]


def select_shots(images: list[Path], project: str, date: str, notes: str, n_min: int = 5, n_max: int = 8) -> tuple[list[Path], Selection]:
    from dreamhome.config import get_business

    biz = get_business()
    candidates = sample(images)
    if len(candidates) <= n_min:
        sel = Selection(shots=[Shot(index=i, shot_note=p.stem) for i, p in enumerate(candidates)], reason="used all photos")
        return candidates, sel

    content = []
    for i, p in enumerate(candidates):
        content.append({"type": "text", "text": f"Image {i}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": thumbnail_b64(p)}})
    content.append({"type": "text", "text": SELECT_PROMPT.format(
        business=biz["name"], industry=biz["industry"], n_min=n_min, n_max=n_max,
        project=project, date=date, notes=notes or "none")})

    resp = llm.client().messages.parse(
        model=get_settings().chat_model,
        max_tokens=4000,
        messages=[{"role": "user", "content": content}],
        output_format=Selection,
    )
    sel: Selection = resp.parsed_output
    sel.shots = [s for s in sel.shots if 0 <= s.index < len(candidates)][:n_max]
    return [candidates[s.index] for s in sel.shots], sel
