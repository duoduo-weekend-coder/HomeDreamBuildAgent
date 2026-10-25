# HomeDreamBuildAgent

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
