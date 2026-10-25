"""Deterministic checks around the CRM agent. The system prompt already forbids pricing; these catch
the cases where the model slips anyway, and force a human handoff on sensitive topics."""
import re

PRICE_PATTERNS = [
    r"\$\s?\d",
    r"\b\d[\d,.]*\s?(k|K|m|M)\b(?!\s?(sq|square))",
    r"\bper\s+(square|sq\.?)\s*(foot|feet|ft)\b",
    r"/\s?(sq\.?\s?ft|sf)\b",
    r"\b\d[\d,.]*\s*(dollars|usd|bucks)\b",
    r"\b(costs?|price[ds]?|runs?)\s+(about|around|roughly|approximately)\s+\d",
]
PRICE_RE = re.compile("|".join(PRICE_PATTERNS), re.IGNORECASE)

ESCALATE_RE = re.compile(
    r"\b(lawyer|attorney|lawsuit|sue|legal action|lien|refund|warranty claim|complaint|"
    r"speak to (a|an) (human|person)|real person|talk to (someone|a human|a person))\b",
    re.IGNORECASE,
)

SAFE_FALLBACK = ("Great question. Pricing depends on the lot, plans, and finishes, so our builder gives "
                 "real numbers on a quick call rather than guessing here. Want me to find a time that works for you?")


def mentions_price(text: str) -> bool:
    return bool(PRICE_RE.search(text))


def needs_human(text: str) -> bool:
    return bool(ESCALATE_RE.search(text))
