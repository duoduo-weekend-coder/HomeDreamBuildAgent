# Reel templates

These templates come from teammate research on the most-engaged Seattle real-estate reels: Devon Leathers, Naomi, Sam Nasralla, and hook guides such as Tatiana Londono's. The research was adapted to a **builder** account. The CRM bot never quotes prices, so the realtor trick of opening on a price is replaced by a **schedule / budget-discipline / quality number**.

Media references point to the local catalogs:
- `vNN` = drone clip in `data/video_index/catalog.md`
- `DSCxxxxx` = White House photo in `data/image_index/whitehouse_catalog.md`

## Rules every reel follows

1. **Hook in 0–3 s with a concrete number or a question.** Use a city plus a duration, size, or stat ("Built in 11 months. On schedule."). Never open with "welcome" or a company intro.
2. **Length is 15–30 s.** Never go over 45 s; completion rate is the main signal for reaching non-followers. That means 6–9 shots at 2–4 s each.
3. **On-screen text the whole time.** Show a big "stat card" text in the hook, plus burned-in captions for every spoken word, because most viewers watch muted.
4. **Tour order looks like a real walk-through.** Exterior → main-floor kitchen/living → primary suite → other bedrooms → lower level / outdoor → best view or room **last**. Never jump between rooms at random.
5. **The CTA is one word to comment, shown on screen** and also spoken: `Comment BUILD`, `Comment GUIDE`, `DM us`. The comment keyword feeds the CRM agent, which sends a private-reply DM.
6. **Caption follows 3-3-3:** 3 lines of hook, 3 lines of value, 3 lines of CTA, at most 9 lines. The hook must sit inside the first 125 characters, which is where Instagram truncates.
7. **People on camera:** a person walking viewers in gets about 1.8× the engagement of empty shots. Use a builder/host clip when one exists. Otherwise, drone fly-ins (v02, v15) are the closest substitute for "walking in".
8. **Only true claims.** Durations, "on time", "on budget", sizes, and locations must come from the builder (via `business.yaml` facts or per-project notes). Never let the model invent them.

---

## T1 — Finished-home payoff ("this is what we build")

**Goal:** credibility. **Source:** White House photos. **Length:** about 25 s. **CTA:** `Comment BUILD to see how we built it`.

| t (s) | Shot | On-screen text | Voiceover idea |
|---|---|---|---|
| 0–3 | DSC00973 rear exterior (or 995 with the sign cropped out) | **{CITY} · {BEDS} BED / {BATHS} BATH · {SQFT} SQ FT**, then **BUILT IN {N} MONTHS. ON TIME.** | "We built this in {N} months, and handed over the keys on schedule." |
| 3–6 | DSC00961 two-storey window wall (daylight) | captions | open living, light |
| 6–9 | DSC00883 or DSC00873 fireplace + stairs | captions | the fireplace wall |
| 9–12 | DSC00850 or DSC00846 kitchen | captions | the kitchen |
| 12–15 | DSC00918 tub / DSC00919 shower | captions | primary suite |
| 15–18 | DSC00947 wet bar | captions | lower level |
| 18–22 | DSC00987 spiral stair, then DSC00989 roof deck (**best last**) | captions | "and the best part…" |
| 22–25 | DSC00991 rooftop gate | **COMMENT "BUILD"** | "Comment BUILD and we'll show you how we built it." |

**Needed from the builder:** city, beds/baths/sqft, actual build duration, and confirmation that it was delivered on time and on budget.

## T2 — Day-N build series (Mon–Fri serial)

**Goal:** consistency and followers. **Source:** drone clips. **Length:** 15–20 s each, 5 reels. **CTA:** `Follow for tomorrow: {next stage}`.

Structure of each reel:
1. Flash the finished house for 1 s as the hook: DSC00961 or DSC00989, with the text **"DAY {N}: HOW WE GET HERE"**.
2. Go back to that day's stage footage.
3. End with **"TOMORROW: {next stage}"**.

| Reel | Stage | Clips | Hook text |
|---|---|---|---|
| Mon | Site clearing → footings | v22, v18 | DAY 1: FROM BARE DIRT |
| Tue | Foundation done | v18, v23 (first half) | DAY 2: FOUNDATION SET |
| Wed | Wall framing, crew on site | v20, v14 | DAY 3: WALLS GOING UP |
| Thu | Sheathed shell + fly-in | v02, v15 | DAY 4: WALK INSIDE THE FRAME |
| Fri | Weatherproofed + roof | v12, v16 | DAY 5: SEALED BEFORE WINTER |

**Caveat:** the clips come from **different houses** (subjects A/B/C/F/W). Present them as "our builds" or as one stage per day. Don't claim it is one lot's timeline unless the builder confirms which footage belongs to which lot.

## T3 — From-dirt-to-done reveal

**Goal:** proof of the three values. **Source:** drone clips, then White House photos. **Length:** about 20 s. **CTA:** `DM us "BUILD"`.

| t (s) | Shots | On-screen text |
|---|---|---|
| 0–3 | v22 bare lot top-down | **THIS WAS DIRT.** |
| 3–12 | Fast cuts at 1–1.5 s each: v18 → v20 → v02 → v12 | ON TIME · ON BUDGET · QUALITY (one per cut group) |
| 12–17 | DSC00973, then DSC00961 | **THIS IS THE FINISH.** |
| 17–20 | DSC00989 | **DM "BUILD"** |

Only call it "the same house" if the builder confirms the drone footage shows the White House. Otherwise use the text "Every build starts here."

## T4 — "3 mistakes before you build" (education → leads)

**Goal:** turn viewers into CRM leads. **Source:** a host clip (Olena on camera) plus B-roll. **Length:** 20–30 s. **CTA:** `Comment GUIDE`, then the CRM agent DMs a short checklist and offers a consultation slot.

| t (s) | Shot | Text |
|---|---|---|
| 0–3 | Host to camera (or v04 wide establishing shot if no host clip) | **3 MISTAKES PEOPLE MAKE BEFORE BUILDING A HOME** |
| 3–10 | B-roll v18 | 1. {mistake one, one line} |
| 10–17 | B-roll v14 | 2. {mistake two} |
| 17–24 | B-roll v12 | 3. {mistake three} |
| 24–28 | DSC00961 | **COMMENT "GUIDE"** |

**Needed:** the three mistakes must come from the builder (Claude can draft them, and the builder approves), plus a 10–15 s selfie-style host clip for best results.

---

## What this changes in the build plan (proposed, not yet implemented)

1. **Video clips as shots.** The renderer currently takes only stills. Drone clips are the best material, so add trimmed clip segments (start/duration), cropped to 9:16 with the same blurred-fill treatment.
2. **Catalog-driven shot selection.** Pick shots from `catalog.json` by template slot (room, tags, quality ≠ weak/exclude) instead of sending every photo to Claude vision. Claude writes the text; the template fixes the order.
3. **Template field.** `Script.template` ∈ {T1, T2, T3, T4}. Each template supplies the slot list, the hook-text pattern, and the CTA keyword. Add a big stat-card overlay that is separate from the captions.
4. **Duration cap.** Target 15–30 s and trim narration to fit.
5. **3-3-3 caption** with the hook inside 125 characters.
6. **Comment keywords → CRM.** Add `cta_keywords: {BUILD: ..., GUIDE: ...}` to `business.yaml`. The webhook detects the keyword and opens the DM with a matching first message.
7. **Facts file per project** (city, size, months, on-time/on-budget confirmed), so the hooks can use real numbers.
