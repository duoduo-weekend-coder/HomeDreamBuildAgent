# Reference reel styles

Two reference reels in `data/others_video_reference/` (gitignored) were analysed: cuts detected with FFmpeg `scdet`, a frame from every shot, frames inside shots for camera movement, and the audio for tempo and cut-on-beat alignment. Their styles now drive two of the studio's templates (`.claude/skills/home-video/templates/catalog.json`).

## `both_process_and_final.mp4` → template **Process + final** (`build`)

48 s, 720×1280, 30 shots.

| | What the reference does |
|---|---|
| Structure | **Brand hook** 0–0.9 s: the site with the builder's sign (name, phone). **Process** 0.9–6 s (~12%): framing shell, then slow walks through stud walls with a centred vanishing point. **Final** 6–40 s (~70%): finished interiors, alternating close-up details (gold faucet, range knobs, marble sink, light fixture) with wide rooms. **Finale** 40–48 s: exterior architecture and outdoor living, held longest. |
| Rhythm | Median shot 1.5 s (0.7–4.1 s). Cuts follow the music: 45% land within one frame of a beat at 80 bpm (chance: 12%), i.e. **a cut every 2 beats**. The last shots are held 2.2–2.7 s. |
| Camera | Slow, smooth gimbal moves: push-ins, gentle arcs around details, dolly through framing. |
| Transitions | Hard cuts only. |
| Text and voice | None on screen, no narration; music only (steady, about −16 dB). |
| Framing | Full-bleed vertical; no letterboxing. |

## `vibe.mp4` → template **Vibe final show** (`showcase`)

36 s, 720×1280, 37 shots.

| | What the reference does |
|---|---|
| Structure | **Flash teaser** 0–1.2 s: 5 cuts of 0.23 s (7 frames) each, previewing later shots. **Main run**: home staging in progress, rooms filling with furniture and art. **Same angle revisited** several times (blank wall → painting hung; bare sofa → styled), so the change itself is the story. **Wind-down**: a styled detail close-up (vases, book), then the finished living room as the last shot. |
| Rhythm | Very fast: median 0.83 s (0.23–3.2 s). Cuts follow the action, not the beat (beat alignment at chance level). |
| Camera | Mostly locked off (tripod or still phone) while people move through the frame; a few handheld pushes. Warm, natural golden-hour light. |
| Transitions | Hard cuts; a slide at the very end. |
| Text and voice | None on screen, no narration; upbeat music only. |
| Framing | Full-bleed vertical. |

## What the renderer gained for these styles

- `"style": {"transition": "cut"}`: hard cuts (per shot too). Shots can be as short as 0.2 s with hard cuts.
- `"beat_sync": true` and per-shot `"beats"`: the renderer finds the music's tempo and first beat, starts the music on a beat, and sets each shot to that many beats, so cuts land on the music. Unlocked shots (the final holds) stretch to fill the length and are rounded to half-beats; if the tempo makes the locked shots too long or short, half-beats are added or removed. `"bpm"` and `"beat_offset"` override detection for a known track.
- `"style": {"fit": "cover"}`: every photo fills the vertical frame.
- `"captions": false` and no narration: music-only reels.

Measured on test renders with a 100 bpm track: every cut lands on a beat or half-beat (process: 9/9, vibe: 14/14), and both videos are exactly 15.00 s.

## Adapting them to Dream Home Build

- **Highlight message**: the references have no text, but the studio promises the user's message appears. It shows twice: over the first long shot and over the final hold, with "Comment BUILD" beneath. Nothing else is written on screen.
- **Music** is required: both styles are music-led. Use a licensed or royalty-free track from `assets/music/` that matches the template's `music` note in `catalog.json`. The references' own tracks can't be reused.
- **Vibe without staging footage**: we have no footage of people styling the home, so the "same angle revisited" beat uses the same angle in different light (e.g. DSC00873 evening fireplace vs DSC00964 daylight). Filming a short staging session on the next finished home would give the real thing.
- **Process + final across houses**: our construction clips and the White House photos may come from different houses. The reel doesn't claim they are one build; say "our builds" in captions unless the builder confirms.
