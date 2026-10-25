"""Claude writes the hook, per-shot voiceover, and Instagram caption."""
from pydantic import BaseModel, Field

from dreamhome.config import get_business, get_settings
from dreamhome.integrations import llm


class Script(BaseModel):
    hook: str = Field(description="On-screen title + first spoken line, max 8 words")
    narration: list[str] = Field(description="One short spoken line per shot, in shot order, 6-14 words each")
    cta: str = Field(description="Closing spoken call to action, max 10 words")
    caption: str = Field(description="Instagram caption, 2-4 short lines, no hashtags")
    hashtags: list[str]
    value_highlighted: str = Field(description="Which brand value this reel emphasises")

    @property
    def voiceover(self) -> str:
        return " ".join([self.hook, *self.narration, self.cta])


SCRIPT_PROMPT = """You write short-form video scripts for {name}, a {industry} in {location}.
Brand values: {values}. Tone: {tone}.
Facts you may use (do not invent others): {facts}

Reel: {series}. Project: {project}. Date of photos: {date}.
Job-site notes from the builder: {notes}
Shots in order:
{shots}

Write a voiceover that sounds like the builder talking to a future homeowner. Lead with a hook that makes
people stop scrolling (e.g. "This is day 1 of Lot 2" or "Framing done. Two days early."). Weave in one of
the brand values with something concrete from the notes; never claim specific numbers, dates, or prices that
are not in the notes. Write exactly {n} narration lines, one per shot.
The closing call to action must invite viewers to message us; base it on: "{cta}".
The caption should end with the same call to action. Use 5-8 hashtags; include some of: {hashtags}."""


def write_script(project: str, date: str, notes: str, shot_notes: list[str], series: str = "") -> Script:
    biz = get_business()
    prompt = SCRIPT_PROMPT.format(
        name=biz["name"], industry=biz["industry"], location=biz["location"],
        values=", ".join(biz["values"]), tone=biz["tone"], facts=" ".join(biz.get("facts", [])),
        series=series or "construction progress update", project=project, date=date, notes=notes or "none",
        shots="\n".join(f"{i + 1}. {s}" for i, s in enumerate(shot_notes)), n=len(shot_notes),
        cta=biz["reel_cta"], hashtags=" ".join(biz["reels"]["hashtags"]),
    )
    resp = llm.client().messages.parse(
        model=get_settings().script_model,
        max_tokens=4000,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": prompt}],
        output_format=Script,
    )
    script: Script = resp.parsed_output
    # keep exactly one line per shot so audio segments map onto images
    lines = script.narration[: len(shot_notes)]
    while len(lines) < len(shot_notes):
        lines.append("")
    script.narration = lines
    return script
