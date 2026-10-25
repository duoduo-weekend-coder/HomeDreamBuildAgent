"""Thin wrapper around the Anthropic client so every module shares one instance."""
from functools import lru_cache

import anthropic

from dreamhome.config import get_settings


@lru_cache
def client() -> anthropic.Anthropic:
    key = get_settings().anthropic_api_key
    return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()


def text_of(response) -> str:
    return "".join(b.text for b in response.content if b.type == "text").strip()
