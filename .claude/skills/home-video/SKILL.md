---
name: home-video
description: Make short marketing videos of a home from photos and video clips. Use when the user asks for a home overview, room tour, property video, build-process or construction-progress video, or a 15s/30s video for social media or a listing. Stitches clips together with cross-fades, animated titles and a brief human-sounding voiceover.
---

# Home video

Turns a folder of photos and clips into a finished 15s or 30s video using one of four templates. `templates/catalog.json` defines each one (goal, media, story order, voice, pace), and the web studio shows them to the customer:

| Template (`kind`) | Story | Storyboards |
|---|---|---|
| **1. Process + final** (`build`) | Music-only: brand/site hook, a quick construction act (~15%), then the finished home in details and wide rooms cut every 2 beats (~70%), ending on exterior and outdoor living | `build-15s.json`, `build-30s.json` |
| **2. Vibe final show** (`showcase`) | Music-only mood reel: a 5-cut flash teaser, then a fast cut every 1.5–2 beats, one hero angle revisited in different light, ending on a styled detail and a calm wide room | `showcase-15s.json`, `showcase-30s.json` |
| **3. Drone + process** (`drone`) | "This was dirt." on the earliest aerial, then drone clips in date order, then "This is the finish." | `drone-15s.json`, `drone-30s.json` |
| **4. Walk-through with narrative** (`walkthrough`) | Narrated tour in walking order (exterior → entry → living → kitchen → suite → …), best room last | `walkthrough-15s.json`, `walkthrough-30s.json` |

Templates 1 and 2 copy the reference reels described in `docs/reference-styles.md`: hard cuts on the beat, full-frame photos, music only, and `music` must be set (pick a track in `assets/music/`). Every template ends with `Comment BUILD`. **Highlight message:** when the user gives one, put it in `info.highlight` exactly as written. The templates show it as the hook title and on the end card (long text wraps automatically); also work it into the narration. `overview-*.json` is the older room-tour storyboard, kept for reference.

`scripts/make_video.py` renders a storyboard JSON into an MP4 that is exactly the storyboard's `duration`.

## Workflow

1. **Read the media before downloading it.**
   - **Google Drive folder** (even one shared with the user): `python3 .claude/skills/home-video/scripts/fetch_drive.py <folder URL> --index --dest media/drive-<folder id>` uses the Drive API to read every file's metadata (capture time, resolution, clip length, GPS, camera) and one thumbnail per shot, and Google Docs as notes. It writes `.index/` (below) in about 30 seconds, without downloading any video. The first run opens a browser for a one-time, read-only Google sign-in that the user approves. rclone's shared Google client ID is being retired during 2026; if sign-in starts failing, follow https://rclone.org/drive/#making-your-own-client-id and run `rclone config reconnect homevideo-gdrive:`.
   - **Local files**: `python3 .claude/skills/home-video/scripts/scan_media.py <folder>`. This shows 4 frames per clip instead of 1.
   - **Then group similar shots**: `python3 .claude/skills/home-video/scripts/similar_shots.py <folder>` (local files only, about a minute for 300 files, faster on re-runs). It rates each photo and each clip's middle frame for sharpness and exposure, and groups near-identical framings of the same scene. A different angle of the same room counts as a new scene.
2. **What the index contains** (`<folder>/.index/`):
   - `index.md`: one row per shot with time, length, resolution, drone altitude and gimbal angle (local scans), plus an approximate GPS location and any notes. Rows marked "(in Drive only)" aren't downloaded yet.
   - `sheet-<day>.jpg`: a contact sheet per shoot day, with numbered tiles.
   - Duplicates (the same shot saved twice, e.g. DJI Fly app re-exports) are listed once, keeping the camera original.
   - `scenes.md` (from `similar_shots.py`): one row per scene with its representative (the sharpest, best-exposed shot), the other shots of that scene, relative sharpness, exposure notes and an automatic quality hint. It can't see people, signs or house numbers; you check for those.
   - After picking shots, download only those: `fetch_drive.py <URL> --dest <folder> --only <file names> --shrink`. `--shrink` re-encodes clips to HEVC at full resolution (about 80% smaller) and deletes the originals; files already on disk are skipped. To choose `start` points, grab frames from the downloaded clip with ffmpeg; don't re-run `scan_media.py` over a Drive-indexed folder, which would replace the Drive index.
3. **Tag every shot once, in `shots.md`.** If a media folder already has a `catalog.md`, reuse it instead of re-tagging. Otherwise look at every contact sheet (Read tool; zoom with ffmpeg crops if a sheet is large) alongside `scenes.md`, and write `shots.md` in the media folder with one line per scene, giving:
   - its number and representative file, plus the other shots of the scene;
   - what it shows: the room or exterior view, or the construction stage (e.g. "orbit of framed house, 40 m, golden light", "top-down of slab");
   - a quality grade: **hero** (best, for the hook and the last slot), **good**, **ok** (filler), **weak** (don't use) or **exclude** (never post);
   - problems: people or faces, blur, signs, house numbers, clutter, reflections (the photographer in a mirror or window), plus shaky, overexposed or D-Log flat colour;
   - for clips, which time ranges are usable. The sheets show 4 frames per clip (10/37/63/90%), so pull extra frames with ffmpeg only where it matters.

   For build videos, the shoot dates *are* the construction order; say which stage each day shows.
4. **Copy the matching template** to `storyboards/<kind>-<length>.json` and fill it in:
   - Point each `source` at the best shot for that slot. For clips, set `start` to the strongest moment (from the contact-sheet timestamps). Drop slots with no good media and give their time to neighbours; keep the end card.
   - Use one shot per scene (its representative), and never a weak or exclude shot. Put hero shots in the hook and the last slot. Fix a privacy problem with `"crop": [l, t, r, b]` or `"blur": [[l, t, r, b], ...]` (fractions of the original photo) if that still leaves a good shot; otherwise drop the shot.
   - Rewrite titles to match what's actually in each shot.
   - Fill `info` (`home_name`, `location`, `specs`, `builder`, `highlight`) from what the user said, the notes or the folder names. **All of these are optional.** Leave a field empty if it isn't known, and never invent one. Text fields can be a list of fallbacks: `["Welcome to {home_name}.", "Welcome home."]` uses the first option whose `{fields}` are all known, and a field whose options are all unknown is simply left out.
   - The templates assume a mix of exterior and interior shots. If the media is all aerial or all exterior (typical for drone footage), make the overview an exterior and neighbourhood tour, and tell the user that a room tour needs interior footage.
5. **Keep the narration brief.** That means about 2.3 spoken words per second of free time: roughly **20–25 words for 15s** and **40–50 for 30s**, spread across 4–6 lines. A line keeps playing over the shots after it that have no narration of their own, which is how a longer sentence covers two shots. If a line is too long, the script stops and names it. Shorten that line; don't remove shots.
6. **Render** from the project root:
   ```bash
   python3 .claude/skills/home-video/scripts/make_video.py storyboards/overview-15s.json
   python3 .claude/skills/home-video/scripts/make_video.py storyboards/overview-15s.json --aspect 9:16
   ```
   `--aspect 9:16` gives a vertical cut for Reels, TikTok and Shorts. `1:1` and `4:5` also work. Output goes to `output/`.
7. **Check the result**: confirm the reported length, then pull a few frames and look at them: `ffmpeg -ss 5 -i output/x.mp4 -frames:v 1 /tmp/check.jpg`. Look for titles covering key features, wrong stages or rooms, and awkward crops in vertical cuts. Fix those with `motion`, `start`, `layout` or a different shot.
8. **Metadata comes with every video.** Rendering writes `<video>.metadata.json`, a complete `VideoMetadata` snapshot for the acquisition agent's `POST /api/content/posts`, and `<video>.metadata.md`, the same information for people, next to each video. It includes edited-video segments with narration transcripts, each segment's raw source with its Google Drive file ID and original-footage time range, and footage capture dates. Give every storyboard a `"caption"` (an Instagram caption stating only what the footage shows). Re-rendering bumps `revision` only when something changed, and keeps `instagramMediaId`, `permalink` and `video.driveFileId` once they've been filled in. To rebuild metadata for an existing video: `python3 .claude/skills/home-video/scripts/video_metadata.py <storyboard> <video.mp4> --aspect <ratio>`.
9. **Share** with the user: every rendered file, plus the narration script, so they can approve the wording.

Use `--placeholders` to preview a storyboard before all the media exists. Missing files become grey cards labelled with the expected filename.

## Storyboard fields

Top level: `duration` (seconds), `aspect` (`16:9` `9:16` `1:1` `4:5`), `info` (optional home details, used by `{placeholders}`), `voice`, `music` (path or null), optional `style`. `music_start` (seconds into the track; default: the best excerpt from `library.json`, see Music), `beat_sync` (with `music`: detect the tempo and cut on the beat; `bpm`/`beat_offset` override detection), `captions` (default `true`): burn in the narration word by word (max 3 words per caption, synced to ElevenLabs word timings, estimated for other voices). Text is white Montserrat ExtraBold with a soft shadow; with captions on, titles move to the top of the frame.

Per shot:

| Field | Meaning |
|---|---|
| `source` | Photo or clip path, or `"card"` for a solid-colour title card |
| `duration` | Seconds on screen, including the 0.5s cross-fade. Lengths are rescaled automatically so the total is exact |
| `motion` | For photos: `zoom_in` `zoom_out` `pan_left` `pan_right` `pan_up` `pan_down` `none`. Vary it from shot to shot |
| `start`, `speed` | For clips: in-point in seconds, and playback speed (e.g. `0.75` for slow motion, `4` for a timelapse feel) |
| `kicker` | Small accent label above the title, e.g. "Kitchen" or "Step 3". Like `title`, `subtitle` and `narration`, it may be a list of fallbacks (step 4) |
| `title`, `subtitle` | On-screen text. Keep titles to 2–5 words |
| `layout` | `center` to centre the text; titles sit lower-left by default (centred in vertical cuts) |
| `narration` | Spoken line starting at this shot |
| `transition` | ffmpeg xfade name for the cut into this shot (`fade`, `smoothleft`, `circleopen`…) |
| `ai_prompt` | With `--ai`: turn this photo into a short AI video clip (see below) |
| `color` | Background colour for a `card` |
| `beats` | With `beat_sync`: the shot lasts this many beats of the music (e.g. `2`, or `0.5` for a flash cut), so cuts land on the beat. Leave it off the final holds; they stretch to fill the length |
| `straighten` | Photos only, default `true`: level the horizon and make verticals plumb (tilt + keystone fitted from vertical edges, one perspective warp, then crop) |
| `fit` | Photos only: `auto` (default), `cover` (fill and crop) or `contain` (whole photo on a blurred copy of itself; `auto` picks it for e.g. landscape photos in 9:16) |
| `crop` | Photos only: `[l, t, r, b]` box to keep, in fractions of the original photo, e.g. to cut out a road sign |
| `blur` | Photos only: list of `[l, t, r, b]` boxes to blur, e.g. house numbers. Applied first, so the privacy edit is never skipped |

`style` overrides: `font`, `text_color`, `accent_color`, `card_color`, `transition` (an xfade name, or `cut` for hard cuts), `transition_duration`, `music_volume` (use ~0.9 for music-only reels), `fit` (default framing for every photo, e.g. `cover` for full-bleed reels).

## Voice

`voice.provider` is `auto`, `elevenlabs`, `openai`, `edge` or `say`, and `voice.voice` picks a voice within it. `auto` picks the most natural voice available:

1. `ELEVENLABS_API_KEY` set → ElevenLabs (most natural). It uses the voice in `ELEVENLABS_VOICE_ID`, or `voice.voice`. Both are read from the environment or the project's `.env`, which the web interface's Voice settings write.
2. `OPENAI_API_KEY` set → OpenAI `gpt-4o-mini-tts`, read in a warm narrator style
3. `edge-tts` installed (`pip install edge-tts`) → Microsoft neural voices, free
4. otherwise macOS `say` (robotic, for drafts only)

Tell the user which voice was used. If it was `say`, say that it's a draft voice.

Narration audio is cached in `output/.cache`, so re-rendering after a title change doesn't pay for speech again. Music is turned down automatically while the narrator speaks.

## Music

Tracks live in `assets/music/` (not committed). `assets/music/library.md` lists each one's tempo, tone, energy, the
templates it suits and its license; pick from it, and never use a track whose license is unknown in a video that will
be published without telling the user. The renderer starts the music at the best excerpt recorded for the
template and length (a lift where the process turns into the finished home; a loud, steady section for the vibe reel)
and, with `beat_sync`, on a beat. New tracks: `python3 .claude/skills/home-video/scripts/music_library.py <folder> --into assets/music`.

## AI clips (optional, paid)

`scripts/generate_clip.py` is adapted from deer-flow's video-generation skill. It turns a still photo into a short moving shot (Google Veo 3.1 with `GEMINI_API_KEY`, or MiniMax Hailuo with `MINIMAX_API_KEY`), using the photo as the first frame so the real room stays recognisable. To use it, add an `ai_prompt` to a photo shot and render with `--ai`, for example:

```json
"ai_prompt": "Slow, smooth cinematic dolly forward through this living room, natural daylight, no people, architecture unchanged"
```

Each clip costs money and takes a few minutes, so ask the user before using `--ai`. Clips are cached in `output/.cache`. Check every generated clip for warped walls or invented furniture before you deliver it. Without `--ai`, photos get the free pan/zoom treatment.
