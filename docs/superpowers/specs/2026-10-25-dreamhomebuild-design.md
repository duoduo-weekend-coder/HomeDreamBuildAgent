# Dream Home Build: Reels Agent + Instagram CRM Agent (hackathon plan)

## Context
Dream Home Build is a small custom-home builder with about 15 houses done. It has years of raw construction photos and drone shots (the finished "White House" plus 3 lots built from start to finish) in Google Drive. Its Instagram is mostly inactive because nobody has time to edit reels. The goal is to show the business's three values (**on time, on budget, quality**) automatically, and to turn viewers into booked calls rather than passive watchers.

We will build two agents. The design stays general enough that any small business (for example a restaurant) could reuse it.
1. **Reels agent**: Drive folder → choose photos → stitch a 9:16 video → subtitles + voiceover + music → caption → publish to Instagram on a Mon–Fri schedule.
2. **CRM agent**: answers Instagram DMs and comments (plus a web chat used for testing), asks qualifying questions, **never quotes prices**, books a Google Calendar slot, and texts the team through Twilio.

The directory is empty, so everything is greenfield.

**Decisions:** Python + FastAPI, Anthropic SDK (`claude-sonnet-5-5` for chat and vision, `claude-opus-5-5` optional for script writing), FFmpeg, ElevenLabs, Twilio, Google Calendar, Google Drive API, and real Instagram Graph API for both publishing and DM/comment webhooks (exposed through ngrok).

## Layout
```
dreamhomebuild/
  pyproject.toml / .env.example   # ANTHROPIC_API_KEY, ELEVENLABS_*, TWILIO_*, GOOGLE_*, IG_*, PUBLIC_BASE_URL
  config/business.yaml            # business profile: name, values, services, tone, lead fields, team phones -> keeps it non-niche
  app/
    main.py                       # FastAPI: /webhooks/instagram, /chat (web test UI), /media (public MP4s), /admin dashboard
    db.py                         # SQLite (SQLModel): Reel, Lead, Conversation, Message, Booking
    integrations/
      drive.py                    # list/download images from Drive folder (service account)
      elevenlabs.py               # TTS with-timestamps -> mp3 + word timings
      instagram.py                # publish reel (container -> poll -> publish), send DM, reply to comment, private reply
      gcal.py                     # freebusy, create event (with Meet link), invite lead
      twilio_sms.py               # notify team
    reels/
      selector.py                 # Claude vision: score/choose 5-8 images, order them, explain choice
      scriptwriter.py             # Claude: hook + per-shot narration + caption + hashtags, tied to the 3 values
      renderer.py                 # FFmpeg: Ken Burns per image, xfade, ASS subtitles, voice + ducked music -> 1080x1920 H.264/AAC
      pipeline.py                 # orchestrates one reel end to end; stores a Reel row (draft -> rendered -> published)
      scheduler.py                # APScheduler: Mon–Fri 9am publishes next queued reel; nightly Drive scan builds queue
    crm/
      agent.py                    # Claude tool-use loop over a conversation
      tools.py                    # update_lead, check_availability, book_meeting, notify_team, handoff_to_human
      prompts.py                  # system prompt built from business.yaml
      guardrails.py               # post-check: block $ / price figures, re-prompt; escalation rules
  assets/music/                   # royalty-free tracks
  scripts/make_reel.py, scripts/seed_week.py   # CLI: render one reel / build the Mon–Fri queue for the demo
  tests/
```

## Agent 1: Reels pipeline
1. **Ingest** (`drive.py`): a Drive folder convention `/<project>/<YYYY-MM-DD>/` holds images plus an optional `notes.txt` ("framing done, inspection passed, 2 days ahead"). Files are downloaded to a local cache, and processed file IDs are tracked so nothing is reused.
2. **Select** (`selector.py`): send downscaled thumbnails to Claude vision with structured output `{chosen:[{file_id, order, shot_note}], reason}`. Criteria: sharpness, variety (drone/wide/detail), progress story, and no people's faces or clutter.
3. **Script** (`scriptwriter.py`): structured output `{hook, narration:[per shot], caption, hashtags, cta}`. The hook pattern is either "Here's the finished home, here's Day N" or "Week 3 of Lot 2: framing done, on schedule". One of the 3 values is woven in, and the CTA is "DM us 'BUILD' to plan your home" (this feeds Agent 2).
4. **Voice** (`elevenlabs.py`): the `/text-to-speech/{voice}/with-timestamps` endpoint returns audio plus character alignment, which we turn into word timings and then into ASS subtitles (2–4 words per line, bold, centered lower third).
5. **Render** (`renderer.py`): FFmpeg `zoompan` Ken Burns on each image, timed to that shot's narration length, joined with `xfade` transitions. Burn in the subtitles and mix the voice with music (`sidechaincompress` ducking, or a simple volume of -18dB). Output is 1080x1920, 30fps, H.264/AAC, 15–45s.
6. **Publish** (`instagram.py`): IG needs a **public `video_url`**, so the MP4 is served from `/media/{id}.mp4` at `PUBLIC_BASE_URL` (ngrok). Steps: `POST /{ig_user}/media` (media_type=REELS, video_url, caption) → poll `status_code` until FINISHED → `POST /{ig_user}/media_publish`. Store the IG `media_id` on the Reel row so comments and DMs can be linked back to the reel that produced them.
7. **Schedule**: `seed_week.py` builds 5 reels (for example Lot 2, Mon–Fri) for review, the admin page allows approve/skip, and APScheduler publishes one per weekday. An `AUTO_APPROVE` flag lets it run hands-off.

## Agent 2: CRM agent
- **Channels**: the IG webhook (`messages`, `comments` fields) goes to `/webhooks/instagram` (verify token + `X-Hub-Signature-256` check). For a comment, it posts a short public reply and sends a **private reply** DM to start a conversation. DMs feed the agent directly. `/chat` is a simple web chat that uses the same agent, for testing and as a fallback during the demo.
- **Lead fields** (in `business.yaml`, so they can be edited): project type (new custom home / remodel / ADU / addition), location/city, owns land or existing house, approximate size (sqft, beds/baths), budget range bracket, timeline (start window), financing readiness, plans/architect/permits status, reference home or reel they liked (filled automatically from the linked reel), name, phone, email, best time to talk.
- **Tools**:
  - `update_lead(fields)` saves partial info as the conversation goes.
  - `check_availability(date_range)` uses Google Calendar freebusy and returns 3–5 slots.
  - `book_meeting(slot, name, email, phone)` creates an event with a Meet link and invites the lead.
  - `notify_team(summary, urgency)` sends a Twilio SMS such as "New lead: Jane, custom home 3,000sqft, Kirkland, has land, 6–12mo, booked Tue 2pm".
  - `handoff_to_human(reason)` pauses the agent on that thread.
- **Guardrails**:
  - The system prompt forbids cost, price, or per-sqft estimates and redirects those questions to the call.
  - `guardrails.py` regex-checks every outgoing message for `$`, "per square foot", or `\d+k`. If one matches, the model is asked to rewrite.
  - Escalate on complaints, legal or warranty topics, or when the user asks for a human.
  - Never invent project facts beyond `business.yaml`.
  - IG replies stay within the 24h messaging window.
- **Flow**: greet (mentioning the reel they came from) → ask qualifying questions 1–2 at a time → summarize → offer slots → book → confirm → SMS the team. If the lead doesn't book, the team still gets an SMS once the minimum fields (project type + contact + timeline) are collected.

## Build order (so the demo works at every step)
1. Skeleton: FastAPI, SQLite, config, `.env`, plus a `CLAUDE.md` with run/test commands and the two-agent architecture. `/init` had nothing to analyze because the repo was empty.
2. Reels offline: local folder → select → script → TTS → render MP4 (`scripts/make_reel.py`).
3. Drive ingest + IG publishing + scheduler + admin page.
4. CRM agent in web chat with mocked calendar/SMS → swap in real Google Calendar + Twilio.
5. IG webhooks (DM + comments) through ngrok, linking to reels.
6. Polish: dashboard showing the reel queue, leads, and bookings, for the pitch.

## External setup checklist (do early; it is the main schedule risk)
- Meta: an IG **Business/Creator** account linked to a FB Page, and a Meta app with `instagram_content_publish`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_show_list`. Dev mode is fine for team members added as app roles/testers. A long-lived token is required, and webhooks need a subscription.
- Google Cloud: a service account with Drive (folder shared to it) + Calendar (calendar shared to it with "make changes" permission).
- Twilio: a trial number (it can only text verified numbers, which is fine for the team). ElevenLabs: an API key + chosen voice ID.
- ngrok: a static domain, used for both `PUBLIC_BASE_URL` and the webhook callback.

## Verification
- `pytest`: unit tests for the guardrail regex, ASS subtitle timing, lead-field merging, and the IG webhook signature check, with mocked Claude/IG/Twilio clients.
- `python scripts/make_reel.py --folder samples/lot2/2025-03-14`: open the MP4 and check 9:16 format, subtitle sync with the voice, and music ducking. Run `ffprobe` to confirm codec/resolution.
- Publish one reel to the test IG account and confirm it appears and that `media_id` is stored.
- Web chat: work through a full lead conversation. Check that price questions get deflected, the event appears on Google Calendar with an invite, and the team phone receives an SMS.
- From a tester IG account, comment on the reel and then DM. Confirm the private reply arrives, the agent continues the chat, and the lead row links to the reel.
- Demo dry run: `uvicorn dreamhome.main:app` + ngrok, trigger the scheduler job manually, and run the end-to-end flow live.

## Decisions made during build (2026-10-25)
- Homebrew FFmpeg has no libass/drawtext: captions and the hook banner are Pillow-rendered PNGs composited with `overlay` (not ASS subtitles).
- Instagram uses the "Instagram API with Instagram Login" host `graph.instagram.com` (no FB Page needed); comments open DMs via `recipient.comment_id` private replies.
- Google: a user OAuth token (`secrets/google-token.json`) is preferred so invites + Meet links work; service account is the fallback (no attendees/Meet).
- Every integration has a mock mode when its keys are missing (logged, fake ids) so the demo runs offline.
- Landscape/drone photos are placed on a blurred copy of themselves inside the 9:16 frame instead of being cropped.
- Music is optional: any file in `assets/music/` is mixed with sidechain ducking under the voice.
- GitHub repo: https://github.com/duoduo-weekend-coder/HomeDreamBuildAgent (public). Never commit `.env`, `secrets/`, `data/`.
