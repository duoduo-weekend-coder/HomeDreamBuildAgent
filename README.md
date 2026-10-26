# HomeDreamBuildAgent

## Instagram acquisition workspace

The [acquisition agent](acquisition/README.md) is a separate, runnable Node.js application for Instagram DMs and comment replies, low-friction project discovery, customer records in Google Drive, Google Calendar consultations and human handoffs. Its dashboard includes conversation management, project stages, conversion insights and dismissible team notifications.

```bash
cd acquisition
npm start
```

Requires Node.js 22.13+; opens at http://localhost:3000. The default demo runs without credentials. For live services, copy `acquisition/.env.example` to `acquisition/.env` and follow the [account setup guide](acquisition/docs/account-setup.md). Real credentials, customer records, browser sessions, recordings and original media are excluded from Git. The [video metadata contract](acquisition/docs/video-metadata.md) describes the input supported by the acquisition agent; producer metadata must match that contract before import.

The video studio below remains at port 8000 with its own configuration.

## Video studio

Turns a folder of construction photos and drone footage into short marketing videos for a home: a 15s or 30s **build-process** video or **overview** (surroundings and room tour), horizontal or vertical, with animated titles, cross-fades and a brief narrated voiceover. Each video comes with a metadata file describing its timeline and source footage.

A local web page collects what to make. Each request runs a headless agent (the Claude Code CLI) with the `home-video` skill, which reads the footage, picks shots, writes a storyboard and narration, renders the videos and checks them. You can send feedback from the page and the same agent revises the videos.

## Requirements

- macOS with [Homebrew](https://brew.sh)
- `brew install ffmpeg rclone exiftool`
- Python 3.11+ (standard library only)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` on your PATH)
- Optional voices: an ElevenLabs API key (added in the page's **Voice settings**), or the free Microsoft voices via `pipx install edge-tts`; macOS `say` is the draft fallback

## Run

```bash
python3 app/server.py
```

Then open http://localhost:8000. Paste a Google Drive folder link (or a local folder path), choose the kind, lengths and formats, and click **Make videos**. The first Drive request opens a browser for a one-time, read-only Google sign-in through rclone.

## How it works

| Piece | What it does |
| --- | --- |
| `app/server.py` | Local web server (127.0.0.1 only). Queues jobs and runs the agent with a restricted tool allow-list. |
| `app/index.html` | The page: request form, live agent progress, video players, feedback, voice settings. |
| `.claude/skills/home-video/SKILL.md` | The workflow the agent follows. |
| `scripts/fetch_drive.py` | Reads Drive metadata and thumbnails without downloading (`--index`), then downloads only chosen files (`--only`, optional `--shrink` to HEVC). |
| `scripts/scan_media.py` | Indexes local footage: capture time, GPS, drone data, duplicates, contact sheets. |
| `scripts/make_video.py` | Renders a storyboard JSON to an exact-length MP4: pan/zoom on stills, clip trimming, titles, cross-fades, narration, music ducking. |
| `scripts/video_metadata.py` | Writes `<video>.metadata.json` (VideoMetadata snapshot) and `<video>.metadata.md` next to each render. |
| `scripts/generate_clip.py` | Optional paid AI clips from a photo (Veo or MiniMax), adapted from [bytedance/deer-flow](https://github.com/bytedance/deer-flow)'s video-generation skill. |
| `templates/` | Storyboard templates for overview and build videos, 15s and 30s. |

## Privacy

API keys live in `.env` (created by the Voice settings panel, readable only by you). Footage (`media/`), renders and job history (`jobs/`) stay on your machine. All of these are git-ignored.

## Post a finished video to Instagram

Open **Instagram settings** in the studio. Connect a Business or Creator Instagram account linked to a Facebook Page, using a Meta app configured for **Facebook Login for Business**. Enter the Instagram account ID and a Page access token with `instagram_basic`, `instagram_content_publish`, and `pages_read_engagement`. Credentials are saved locally in `.env` under `IG_STUDIO_*`, separately from the reels/CRM integration.

Select a completed video, click **Post to Instagram**, review the caption and account, then **Publish Reel**. The studio uploads that MP4 directly to Meta; no public video link or tunnel is needed. The page shows progress and a link to the published Reel. See [Meta's upload guide](https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads) for account access requirements.

Posting history stays in each job's git-ignored `instagram-posts.json`. Duplicate clicks reuse the existing attempt. If publishing is interrupted, check Instagram before attempting manual recovery; the app will not automatically repost. Run the isolated tests with `python3 -m unittest tests.test_instagram -v` (no live API calls).

## Reels pipeline and CRM agent (`dreamhome/`)

The second half of the project turns a media library into scheduled Instagram reels and turns viewers into booked calls. It's a uv project (Python 3.12):

```bash
uv sync
cp .env.example .env              # add ANTHROPIC_API_KEY, ELEVENLABS_API_KEY/VOICE_ID, ...
uv run python scripts/demo_t1.py   # "vibe final show" reel from the White House photos
uv run python scripts/demo_tour.py # full walk-through: every unique scene once
```

| Piece | What it does |
| --- | --- |
| `dreamhome/reels/` | Shot selection (Claude vision), script writing, auto straightening (tilt + keystone), eased camera moves, Montserrat captions synced to ElevenLabs word timings, stat/CTA cards, FFmpeg render |
| `dreamhome/integrations/` | Google Drive, Instagram Graph API (publish reels, DMs, comment replies), Google Calendar, Twilio SMS, ElevenLabs. Each runs in mock mode when its keys are missing |
| `dreamhome/crm/` | CRM agent tools (save lead, check availability, book, text team, hand off) and guardrails: never quotes prices |
| `config/business.yaml` | Everything business-specific (brand, values, lead questions, booking hours), so it works for any small business |
| `docs/reel-templates.md` | The 4 viral templates: building process, vibe final show, drone + process, walk-through with narrative |
| `docs/presentation/index.html` | Interactive hackathon deck (open locally; it reads images from the git-ignored `data/`) |
| `docs/superpowers/` | Design spec and implementation plan |

Media catalogs (tags, quality, scene dedupe) are written to `data/`, which is git-ignored because it holds client photos.
