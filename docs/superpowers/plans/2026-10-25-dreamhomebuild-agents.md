# Dream Home Build Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the two agents for Dream Home Build. The reels agent turns Drive photos into narrated vertical reels and auto-posts them to Instagram Mon–Fri. The CRM agent answers Instagram DMs and comments plus a web chat, qualifies leads without quoting prices, books Google Calendar slots, and texts the team.

**Architecture:** A single FastAPI process runs everything: Instagram webhooks, the web chat, `/media` for public MP4s, the `/admin` dashboard, and an APScheduler for daily posting. The reels pipeline works like this: Claude vision picks the shots, Claude writes the script, ElevenLabs produces voice with word timings, and FFmpeg renders with Pillow caption overlays. The CRM is a manual Claude tool-use loop over five tools, with regex guardrails applied after generation. Every integration falls back to a mock when its keys are missing.

**Tech Stack:** Python 3.12 (uv), FastAPI, SQLModel/SQLite, anthropic SDK 2.x (`messages.parse`, tool use), FFmpeg 9 (no libass), Pillow + pillow-heif, httpx, google-api-python-client, twilio, APScheduler 3, Jinja2, pytest.

**Spec:** `docs/superpowers/specs/2026-10-25-dreamhomebuild-design.md`

## Global Constraints

- Run everything through `uv run` (`uv run pytest`, `uv run uvicorn dreamhome.main:app --reload`). Python is >=3.12.
- Models are read from settings: `chat_model` defaults to `claude-sonnet-5-5` (CRM chat + vision) and `script_model` defaults to `claude-opus-5-5` (scripts). Never hardcode model IDs outside `dreamhome/config.py`.
- No `temperature`/`top_p`/`top_k`, no `budget_tokens`, no forced `tool_choice` (`any`/`tool`). These return 400 on these models. Use `tool_choice` auto (the default).
- The CRM must never send prices, cost ranges, per-sqft numbers, or estimates. Every outgoing assistant text passes through `dreamhome/crm/guardrails.py`.
- Video output is 1080x1920, 30 fps, H.264 high/yuv420p, AAC 44.1 kHz, `+faststart`, with a target length of 15–45 s.
- Any business-specific text belongs in `config/business.yaml`, never in code.
- Secrets live only in `.env` and `secrets/`. `data/` is runtime output. All three are git-ignored, and the repo is **public**.
- Tests must never touch the network. Claude, Instagram, Twilio, ElevenLabs, and Google are faked or run in their mock modes. Tests use a temporary SQLite DB.

## Review Focus

1. **Meta webhook retries.** Meta can deliver the same DM `mid` (or comment id) twice. The lead should get exactly one reply. Pinned in Task 4: `test_duplicate_event_processed_once`.
2. **Own-account echoes.** Our outgoing DMs come back as `is_echo` events, and our own public comment replies trigger comment webhooks. These must be ignored, otherwise the bot loops replying to itself. Pinned in Task 4: `test_echo_and_self_comment_ignored`.
3. **Non-text DMs.** A DM that is only a sticker, a photo, or a shared reel with no text must not crash. A shared reel should link the lead to that reel, and the agent should still reply. Pinned in Task 4: `test_attachment_only_dm_links_reel`.
4. **Customer states a budget.** When the customer says "budget is $800k", the agent saves it to the lead but its reply must not echo the dollar figure, because the guardrail would rewrite it. Pinned in Task 3: `test_reply_echoing_budget_is_rewritten`.
5. **Empty or tiny photo batch.** A Drive folder with 0 images must produce a `failed` reel with a readable error, not a crash or a blank video. One with fewer images than `n_min` uses all of them without calling Claude. Pinned in Task 2: `test_build_reel_with_no_images_fails_cleanly`, `test_select_shots_small_batch_skips_claude`.

---

## Already built (uncommitted; Tasks 1–2 add tests and commit it)

| File | Key interfaces (already exist; later tasks rely on them) |
|---|---|
| `dreamhome/config.py` | `get_settings() -> Settings` (fields per `.env.example`), `get_business() -> dict`, `ROOT`, `DATA_DIR`, `MEDIA_DIR`, `CACHE_DIR` |
| `dreamhome/db.py` | SQLModel tables `Reel`, `Lead`, `Message`, `Booking`; `get_session() -> Session`; `select`; `utcnow()`; module-global `_engine` |
| `dreamhome/integrations/llm.py` | `client() -> anthropic.Anthropic` (lru_cached), `text_of(response) -> str` |
| `dreamhome/integrations/drive.py` | `Batch(project, date, images: list[Path], notes, source_ids)`, `load_local_batch(folder) -> Batch`, `list_drive_batches(project=None) -> list[(project, date, folder_id)]`, `download_drive_batch(project, date, folder_id, skip_ids) -> Batch` |
| `dreamhome/integrations/elevenlabs.py` | `Word(text, start, end)`, `words_from_alignment(chars, starts, ends)`, `synthesize(text, out_path) -> list[Word]` (falls back to macOS `say`), `audio_duration(path) -> float` |
| `dreamhome/integrations/instagram.py` | `publish_reel(video_url, caption) -> {"id", "permalink"}`, `send_dm(recipient_id, text)`, `private_reply(comment_id, text)`, `reply_to_comment(comment_id, text)`, `verify_signature(body, header, secret=None) -> bool` |
| `dreamhome/integrations/gcal.py` | `available_slots(limit=5) -> list[datetime]`, `candidate_slots(now, busy, limit) -> list[datetime]`, `create_event(start, summary, description, attendee_email) -> Event` |
| `dreamhome/integrations/twilio_sms.py` | `notify_team(body) -> list[str]`, `SENT: list[str]` (record of every SMS body) |
| `dreamhome/reels/images.py` | `open_rgb`, `thumbnail_b64`, `vertical_frame(path, out) -> Path` |
| `dreamhome/reels/selector.py` | `Shot`, `Selection`, `sample(paths, k)`, `select_shots(images, project, date, notes, n_min=5, n_max=8) -> (list[Path], Selection)` |
| `dreamhome/reels/scriptwriter.py` | `Script(hook, narration, cta, caption, hashtags, value_highlighted)` with `.voiceover`; `write_script(project, date, notes, shot_notes, series="") -> Script` |
| `dreamhome/reels/captions.py` | `Caption(text, start, end)`, `chunk_words(words, max_words=3, max_chars=18) -> list[Caption]`, `render_text_png(text, out, size=84, banner=False) -> Path` |
| `dreamhome/reels/renderer.py` | `normalize_starts(starts, total) -> list[float]`, `render(images, segment_starts, voice_duration, captions, hook, voice, workdir, out, music=None) -> Path` |
| `dreamhome/reels/pipeline.py` | `segment_starts(segments, words)`, `shot_segments(script)`, `full_caption(script)`, `build_reel(batch, series="") -> Reel`, `publish(reel_id) -> Reel`, `next_approved() -> Reel or None`, `used_source_ids() -> set[str]`, `public_video_url(reel) -> str` |
| `dreamhome/crm/guardrails.py` | `mentions_price(text) -> bool`, `needs_human(text) -> bool`, `SAFE_FALLBACK` |
| `dreamhome/crm/prompts.py` | `system_prompt() -> str`, `context_note(lead_fields, source_reel, channel) -> str` |
| `dreamhome/crm/tools.py` | `tool_definitions() -> list[dict]`, `execute(name, args, lead_id) -> str (JSON)`, `lead_summary(lead) -> str`, `lead_field_keys()`, `required_keys()` |

---

### Task 1: Test harness + reels pure-function tests, first commit

**Files:**
- Create: `tests/conftest.py`, `tests/test_reels_timing.py`
- Modify: `dreamhome/reels/pipeline.py` (fail clearly on empty batch)
- Commit: everything already built, plus `docs/`

**Interfaces:**
- Produces: the pytest fixture `db` (autouse). It points `DATABASE_URL` at `tmp_path/test.db`, clears `get_settings`/`get_business` caches, resets `dreamhome.db._engine = None`, and blanks every API key env var so all integrations run in mock mode. Also the fixture `fake_claude(monkeypatch)`, which returns an object whose `.queue` list holds canned responses. It patches `dreamhome.integrations.llm.client` so that `messages.create`/`messages.parse` pop from that queue and record their kwargs in `.calls`.

- [ ] **Step 1: Write the tests** in `tests/test_reels_timing.py`:
  - `test_words_from_alignment`: chars `"Hi yo"`, starts `[0,.1,.2,.3,.4]`, ends `[.1,.2,.3,.4,.5]` produce `[Word("Hi",0,.2), Word("yo",.3,.5)]`.
  - `test_chunk_words_breaks_on_punctuation`: the words `Framing done. Two days early` give caption texts `["Framing done.", "Two days early"]`.
  - `test_chunk_words_max_three`: 7 plain words give chunks of sizes `[3,3,1]`.
  - `test_normalize_starts_monotonic`: `normalize_starts([0.3, 0.5, 0.6, 9.0], total=10)` returns a list whose first value is `0.0`, where every gap is `>= 1.2`, and the last value is `<= 8.8`.
  - `test_segment_starts_maps_word_counts`: segments `["a b", "c", "d e f"]` with words at starts 0..5 give `[0, 2, 3]`.
  - `test_shot_segments_attach_hook_and_cta`: script narration `["one","two"]`, hook `"H"`, cta `"C"` give `["H one", "two C"]`.
  - `test_full_caption_normalizes_hashtags`: hashtags `["home", "#build"]` make the caption end with `"#home #build"`.
- [ ] **Step 2: Run** `uv run pytest tests/test_reels_timing.py -v`. Expected: PASS. This is characterization of existing code; fix the code if any test fails.
- [ ] **Step 3: Write the failing test** `test_build_reel_with_no_images_fails_cleanly`: calling `build_reel(Batch("Lot 2","2025-03-14"))` gives `reel.status == "failed"` and `"no images" in reel.error.lower()`, and `fake_claude.calls == []`.
- [ ] **Step 4: Implement.** At the top of `build_reel`'s `try` block, add `if not batch.images: raise ValueError("No images in batch {project}/{date}")`. Re-run until it passes.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: reels pipeline, integrations, CRM tools scaffold with timing tests"
```

### Task 2: Selector and scriptwriter behavior with fake Claude

**Files:**
- Test: `tests/test_reels_llm.py`

**Interfaces:**
- Consumes: the `fake_claude` fixture (Task 1), `select_shots`, `write_script`.

- [ ] **Step 1: Write the tests:**
  - `test_select_shots_small_batch_skips_claude`: 3 temp JPEGs passed to `select_shots` return all 3 in order, and `fake_claude.calls == []`.
  - `test_select_shots_filters_bad_indices`: 10 images, with the fake parse returning `Selection(shots=[Shot(index=4,...), Shot(index=99,...), Shot(index=0,...)])`, return paths `[img4, img0]`.
  - `test_write_script_pads_narration`: 3 shot notes, with the fake returning 2 narration lines, give `len(script.narration) == 3`. The call uses `model == settings.script_model` and has no `temperature`.
- [ ] **Step 2: Run** `uv run pytest tests/test_reels_llm.py -v`. Expected: PASS. Fix the code if it fails.
- [ ] **Step 3: Commit** `git commit -am "test: selector and scriptwriter contracts"` (with the new test file added).

### Task 3: CRM agent loop

**Files:**
- Create: `dreamhome/crm/agent.py`
- Test: `tests/test_crm_tools.py`, `tests/test_crm_agent.py`

**Interfaces:**
- Consumes: `tools.tool_definitions/execute`, `prompts.system_prompt/context_note`, `guardrails.*`, `llm.client`.
- Produces:
  - `get_or_create_lead(channel: str, external_id: str, handle: str = "", source_reel_id: int | None = None) -> Lead`. It never overwrites an existing `source_reel_id` with `None`.
  - `handle_message(lead_id: int, text: str) -> str | None`. It stores the user `Message`, sets `last_inbound_at`, and returns the reply text (also stored as an assistant `Message`). It returns `None` when the lead is `agent_paused`.
  - `MAX_TOOL_ROUNDS = 8`, `HISTORY_LIMIT = 40`.

- [ ] **Step 1: Write the tool tests** (`tests/test_crm_tools.py`). These run against mock calendar and SMS:
  - `test_update_lead_merges_and_ignores_unknown`: `execute("update_lead", {"location":"Kirkland","bogus":"x"}, id)` stores `fields == {"location":"Kirkland"}`, and the returned JSON has `still_unknown` containing `"timeline"`.
  - `test_lead_qualifies_when_required_present`: after setting `project_type`, `timeline`, and `name`, `lead.status == "qualified"`.
  - `test_book_meeting_rejects_invented_slot`: `slot_iso="2030-01-01T03:00:00-08:00"` returns JSON with `"error"`, and no `Booking` row is created.
  - `test_book_meeting_books_and_texts`: booking the first slot from `check_availability` gives `lead.status == "booked"`, 1 `Booking` row, `len(twilio_sms.SENT) == 1`, and that same slot no longer appears in `available_slots()`.
  - `test_notify_team_only_once`: a second `notify_team` returns `"sent": false`.
  - `test_handoff_pauses`: `lead.agent_paused is True` and `status == "handed_off"`.
  - `test_guardrail_patterns`: `mentions_price` is True for `"$450k"`, `"around 300 per square foot"`, `"costs about 2"`, and `"/sqft"`. It is False for `"3,000 sqft home"`, `"4 bedrooms"`, and `"start in 6 months"`. `needs_human("I want to talk to a real person")` is True.
- [ ] **Step 2: Run** `uv run pytest tests/test_crm_tools.py -v`. Expected: PASS. Fix the code or the regex if it fails.
- [ ] **Step 3: Write the agent tests** (`tests/test_crm_agent.py`). The fake Claude returns objects with `.content` blocks (`type="text"` / `type="tool_use"` with `id`, `name`, `input`) and `.stop_reason`:
  - `test_tool_loop_executes_and_replies`: the queue is a `tool_use update_lead {"project_type":"new custom home"}` response, then a text `"Nice! Where is the lot?"` response. The reply equals that text, the lead fields are updated, and the second request's last message is a `user` message containing a `tool_result` with the matching `tool_use_id`.
  - `test_reply_echoing_budget_is_rewritten`: the first response is the text `"Great, $800k works."`. The rewrite call returns `"Thanks, noted your budget. Want to set up a call?"`. The final reply contains no `$`. If the rewrite also mentions a price, the reply equals `SAFE_FALLBACK`.
  - `test_paused_lead_gets_no_reply`: `handle_message` returns `None` and makes no Claude call, but the user message is stored.
  - `test_inbound_escalation_hands_off`: `"I'm calling my lawyer"` sets `lead.agent_paused`, sends an SMS, and returns a short "a team member will reply" message with no Claude call.
  - `test_history_is_text_only_and_limited`: with 50 stored messages, the request `messages` length is `<= HISTORY_LIMIT + 1` and starts with role `user`.
  - `test_max_rounds_stops`: when the fake returns `tool_use` forever, the call returns a non-empty fallback after `MAX_TOOL_ROUNDS` rounds.
- [ ] **Step 4: Run** `uv run pytest tests/test_crm_agent.py -v`. Expected: FAIL (no module `dreamhome.crm.agent`).
- [ ] **Step 5: Implement `dreamhome/crm/agent.py`.** Use a manual loop: `client().messages.create(model=chat_model, max_tokens=4000, system=system_prompt(), tools=tool_definitions(), output_config={"effort": "low"}, messages=history + [user turn with context_note + text])`.
  - Append the full `response.content` within the turn. Execute every `tool_use` block and return all of their `tool_result` blocks in one user message. A tool exception becomes `is_error: True`.
  - Stop on `end_turn`. Treat `refusal` and `max_tokens` as triggers for `SAFE_FALLBACK`-style text.
  - Persist only text to `Message`; previous turns are replayed as plain text.
  - Price guardrail: make a separate one-shot `messages.create` that rewrites the reply without numbers. If the rewrite still mentions a price, use `SAFE_FALLBACK`.
  - The inbound `needs_human` check runs before calling Claude and calls `tools.execute("handoff_to_human", ...)`.
  - If the reel title is known, `source_reel` in `context_note` is the reel's `script["hook"]` plus its project.
- [ ] **Step 6: Run** `uv run pytest tests/test_crm_agent.py tests/test_crm_tools.py -v`. Expected: PASS.
- [ ] **Step 7: Commit** `git add dreamhome/crm/agent.py tests/test_crm_*.py && git commit -m "feat: CRM agent tool loop with price guardrail and handoff"`.

### Task 4: Instagram webhook parsing and dispatch

**Files:**
- Create: `dreamhome/webhooks.py`
- Modify: `dreamhome/db.py` (add the `ProcessedEvent` table)
- Test: `tests/test_webhooks.py`

**Interfaces:**
- Consumes: `agent.get_or_create_lead`, `agent.handle_message`, `instagram.send_dm/private_reply/reply_to_comment/verify_signature`.
- Produces:
  - `InboundEvent` dataclass with `kind: Literal["dm","comment"]`, `event_id: str` (DM `mid` or comment id), `sender_id: str`, `username: str`, `text: str`, `media_id: str` (reel the comment is on, or the shared reel's id), and `comment_id: str`.
  - `parse_events(payload: dict, own_ig_user_id: str) -> list[InboundEvent]`. It drops `is_echo` events, events whose sender is our own account, and non-`instagram` objects.
  - `process_event(ev: InboundEvent) -> None`. It is idempotent via `ProcessedEvent(id: str primary key, created_at)`.
  - `find_reel_by_media(media_id: str) -> Reel | None`.
  - `COMMENT_PUBLIC_REPLY` comes from `business.yaml`: add the key `comment_public_reply: "Thanks! Just sent you a DM 🙂"`.
- Payload shapes (fixtures in the test file):
  - DM: `{"object":"instagram","entry":[{"id":OWN,"messaging":[{"sender":{"id":"U1"},"recipient":{"id":OWN},"message":{"mid":"m1","text":"hi"}}]}]}`
  - Shared reel: the same DM shape with `"attachments":[{"type":"ig_reel","payload":{"reel_video_id":"IGM1"}}]` and no `text`.
  - Comment: `{"object":"instagram","entry":[{"id":OWN,"changes":[{"field":"comments","value":{"id":"c1","text":"price?","from":{"id":"U2","username":"jane"},"media":{"id":"IGM1"}}}]}]}`

- [ ] **Step 1: Write the tests:**
  - `test_parse_dm`, `test_parse_comment`: these check the fields shown above.
  - `test_echo_and_self_comment_ignored`: a DM with `"is_echo": true` and a comment `from.id == OWN` both give `[]`.
  - `test_attachment_only_dm_links_reel`: with a `Reel(ig_media_id="IGM1")` in the DB, `process_event` creates a lead with `source_reel_id == reel.id`. The agent receives text `"[shared our reel]"` and `send_dm` is called once.
  - `test_comment_flow`: processing a comment calls `reply_to_comment("c1", COMMENT_PUBLIC_REPLY)` and `private_reply("c1", <agent reply>)`. The agent receives `"Commented on our reel: price?"`.
  - `test_duplicate_event_processed_once`: calling `process_event` twice with the same `event_id` triggers exactly 1 `send_dm`.
  - `test_paused_lead_no_dm`: when `handle_message` returns `None`, there is no `send_dm`.

  In all of these, monkeypatch `dreamhome.webhooks.handle_message` to return `"reply"` and monkeypatch the instagram send functions to record calls.
- [ ] **Step 2: Run** `uv run pytest tests/test_webhooks.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `dreamhome/webhooks.py`** and the `ProcessedEvent` table.
  - DMs: get or create the lead (`channel="instagram"`, `external_id=sender_id`), link the reel when `media_id` matches, then `handle_message`, then `send_dm` if there is a reply.
  - Comments: create the lead with the reel link, `reply_to_comment`, `handle_message`, then `private_reply` with the agent's first reply.
- [ ] **Step 4: Run** `uv run pytest tests/test_webhooks.py -v`. Expected: PASS.
- [ ] **Step 5: Commit** `git add dreamhome/webhooks.py dreamhome/db.py config/business.yaml tests/test_webhooks.py && git commit -m "feat: Instagram webhook parsing, idempotent DM/comment dispatch"`.

### Task 5: FastAPI app — webhook routes, web chat, media, admin

**Files:**
- Create: `dreamhome/main.py`, `dreamhome/templates/admin.html`, `dreamhome/templates/chat.html`
- Test: `tests/test_app.py`

**Interfaces:**
- Consumes: `webhooks.parse_events/process_event`, `agent.*`, `pipeline.publish`, `twilio_sms.SENT`, `scheduler.start_scheduler` (Task 6). Import it lazily inside the lifespan, only when `settings.enable_scheduler` is set. That is a new bool field defaulting to `True`; tests set it to `False`. This way Task 5 runs before Task 6 exists.
- Produces these routes:
  - `GET /webhooks/instagram`: if `hub.mode == "subscribe"` and `hub.verify_token == settings.ig_verify_token`, return `hub.challenge` as plain text; otherwise 403.
  - `POST /webhooks/instagram`: `verify_signature(raw_body, X-Hub-Signature-256)` or 403. Parse the body, then queue each event through `BackgroundTasks` using `process_event`. Respond 200 `{"ok": true}` immediately, because Meta needs a fast 200.
  - `POST /api/chat` takes `{"session_id": str, "message": str, "reel_id": int | null}` and returns `{"reply": str | null, "lead": {fields, status}}`. It uses the web channel (`external_id=session_id`).
  - `GET /chat?reel=ID`: a single-page chat UI (vanilla JS, `fetch('/api/chat')`, `session_id` in `localStorage`).
  - `GET /media/{name}`: `StaticFiles(directory=MEDIA_DIR)`.
  - `GET /admin`: reels (newest first, `<video>` preview, caption, status, error), leads (fields, status, last 10 messages), bookings, last 20 SMS.
  - `POST /admin/reels/{id}/approve|skip|publish` and `POST /admin/leads/{id}/resume`, each redirecting with 303 to `/admin`.
  - `GET /health` returns `{"ok": true}`.

- [ ] **Step 1: Write the tests** using `fastapi.testclient.TestClient`:
  - `test_verify_challenge`: the correct token returns 200 with body `"123"`. The wrong token returns 403.
  - `test_webhook_rejects_bad_signature`: with `IG_APP_SECRET=s` and a bad header, the response is 403.
  - `test_webhook_accepts_signed_and_dispatches`: an HMAC-signed DM payload returns 200, and the patched `process_event` is called once.
  - `test_api_chat_roundtrip`: with `handle_message` patched to return `"hello"`, a POST returns `reply == "hello"`. A second POST with the same `session_id` reuses the same lead.
  - `test_admin_renders_and_actions`: `/admin` returns 200 and contains the reel's project name. `POST /admin/reels/{id}/approve` sets status to `approved`. `publish` with the instagram mock gives status `published` and an `ig_media_id` starting `mock_`.
  - `test_media_served`: a file written to `MEDIA_DIR` comes back with 200.
- [ ] **Step 2: Run** `uv run pytest tests/test_app.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement `dreamhome/main.py` and the templates.** Use a lifespan that starts the scheduler only if `enable_scheduler` is set. Logging level is INFO. Keep the templates plain HTML with minimal inline CSS, readable on a projector.
- [ ] **Step 4: Run** `uv run pytest -v`. Expected: all pass.
- [ ] **Step 5: Commit** `git add dreamhome/main.py dreamhome/templates tests/test_app.py dreamhome/config.py && git commit -m "feat: FastAPI app with IG webhooks, web chat, media, admin dashboard"`.

### Task 6: Scheduler — daily posting and Drive scan

**Files:**
- Create: `dreamhome/reels/scheduler.py`
- Test: `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `pipeline.next_approved/publish/build_reel/used_source_ids`, `drive.list_drive_batches/download_drive_batch`, `get_business()["reels"]` (`post_time`, `post_days`), and `booking.timezone`.
- Produces:
  - `publish_next() -> Reel | None`.
  - `scan_drive(max_queue: int = 5) -> list[Reel]`. It builds reels for dated folders with unused images, oldest first, until the count of `rendered` + `approved` reels reaches `max_queue`. It is a no-op returning `[]` when Google is not configured.
  - `start_scheduler() -> BackgroundScheduler`. It registers the jobs `publish_next` (cron on `post_days` at `post_time`, business timezone) and `scan_drive` (daily 02:00).

- [ ] **Step 1: Write the tests:**
  - `test_publish_next_picks_oldest_approved`: two approved reels plus one rendered reel. The oldest approved one becomes `published`, and the others are unchanged.
  - `test_publish_next_none_when_queue_empty`: returns `None`.
  - `test_scan_drive_respects_queue_and_skips_used`: patch `list_drive_batches` to return 3 folders and `download_drive_batch` to return a batch. With 4 reels already queued and `max_queue=5`, exactly 1 `build_reel` call is made. `skip_ids` passed to download equals `used_source_ids()`.
  - `test_scheduler_jobs_registered`: `start_scheduler()` has job ids `{"publish_next","scan_drive"}`, and the trigger for `publish_next` contains `mon-fri` and hour 9. Shut the scheduler down after the test.
- [ ] **Step 2: Run** `uv run pytest tests/test_scheduler.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement `dreamhome/reels/scheduler.py`.** Use `CronTrigger(day_of_week=",".join(post_days), hour=h, minute=m, timezone=tz)`. Wrap each job body in try/except with logging so one bad reel never kills the scheduler.
- [ ] **Step 4: Run** `uv run pytest -v`. Expected: all pass.
- [ ] **Step 5: Commit** `git add dreamhome/reels/scheduler.py tests/test_scheduler.py && git commit -m "feat: Mon-Fri publish job and nightly Drive scan"`.

### Task 7: CLI scripts — make_reel, seed_week, google_auth

**Files:**
- Create: `scripts/make_reel.py`, `scripts/seed_week.py`, `scripts/google_auth.py`, `dreamhome/reels/series.py`
- Test: `tests/test_series.py`

**Interfaces:**
- Produces:
  - `plan_week(batches: list[Batch], start: date) -> list[tuple[Batch, str, datetime]]` in `dreamhome/reels/series.py`. It takes the first 5 batches in date order and assigns the weekdays from `start` onward, skipping Saturday and Sunday. Posting time is `post_time` in the business timezone. The series label is `"Day {n} of 5: {project}"`.
  - `scripts/make_reel.py --folder PATH | --drive PROJECT DATE [--series TEXT] [--publish]` prints the reel id, status, video path, and caption.
  - `scripts/seed_week.py --folder PROJECT_DIR | --drive PROJECT [--start YYYY-MM-DD]` builds 5 reels and sets `scheduled_for`. Status is `approved` if `AUTO_APPROVE`, else `rendered`. It prints a table.
  - `scripts/google_auth.py` runs `InstalledAppFlow.from_client_secrets_file("secrets/google-oauth-client.json", SCOPES).run_local_server(port=0)` and writes `secrets/google-token.json`.

- [ ] **Step 1: Write the tests:**
  - `test_plan_week_skips_weekend`: with 6 batches and start on Friday 2026-10-30, it uses 5 batches with dates Fri, Mon, Tue, Wed, Thu at 09:00 America/Los_Angeles, labelled `"Day 1 of 5: Lot 2"` through `"Day 5 of 5: Lot 2"`.
  - `test_plan_week_orders_by_date`: batches given unordered come back sorted by `batch.date`.
- [ ] **Step 2: Run** `uv run pytest tests/test_series.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** `dreamhome/reels/series.py` and the three scripts. Use argparse. Scripts add the repo root to `sys.path` so `uv run python scripts/x.py` works.
- [ ] **Step 4: Run** `uv run pytest -v`. Expected: all pass.
- [ ] **Step 5: Smoke-run offline.** Run `uv run python scripts/make_reel.py --folder samples/lot2/2025-03-14`. This uses the real Claude API if `ANTHROPIC_API_KEY` is set and the macOS voice fallback. Expected: status `rendered`, and `ffprobe` shows `h264 1080x1920` plus `aac`, with duration between 15 and 45 s. Extract 2 frames and look at them to check that the hook banner and captions are visible. (Provide `samples/lot2/2025-03-14/` from real photos; if none are available yet, generate placeholder JPEGs and say so.)
- [ ] **Step 6: Commit** `git add scripts dreamhome/reels/series.py tests/test_series.py && git commit -m "feat: make_reel, seed_week, google_auth CLIs"`.

### Task 8: End-to-end live verification

No new code unless bugs are found. Fix bugs with superpowers:systematic-debugging and add a regression test for each one.

- [ ] **Step 1:** Run `uv run uvicorn dreamhome.main:app --port 8000` and open `/health`.
- [ ] **Step 2: Web chat with real Claude, mocked calendar and SMS.** Walk through a full conversation in `/chat`: greeting, project type, location, a question asking for the price (expect a deflection with no numbers), timeline, name, picking a slot, email, booked. Expected: the lead is `booked` in `/admin`, there is a `Booking` row, and the SMS log has a line with name, project, and time.
- [ ] **Step 3: Admin.** Approve a rendered reel and click publish. In mock mode, expect status `published` with `ig_media_id` `mock_…`.
- [ ] **Step 4: Live integrations (only if keys present).** Do each of these only once its credentials exist in `.env`:
  1. Run ngrok and set `PUBLIC_BASE_URL`, then publish 1 reel to the test IG account.
  2. Comment and DM from a tester account; expect a public reply plus a DM conversation.
  3. Book a real Google Calendar event.
  4. Receive a real Twilio SMS.

  Record which of these were verified live and which stayed mocked.
- [ ] **Step 5: Commit** any fixes with `fix:` messages.

### Task 9: README, CLAUDE.md, push

**Files:**
- Create: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write `README.md`** with these sections:
  - What it does: the two agents and the reuse-for-any-business story.
  - Quickstart: `brew install ffmpeg uv`, `uv sync`, `cp .env.example .env`, `uv run uvicorn dreamhome.main:app --reload`, `uv run pytest`.
  - Folder convention for photos: `<project>/<YYYY-MM-DD>/` plus `notes.txt`.
  - External setup checklist: copy it from the spec, adding the Instagram-Login permissions `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_messages`, and `instagram_business_manage_comments`; webhook fields `messages` and `comments`; and the Google OAuth vs service-account note.
  - Mock mode table: which env var enables each live integration.
  - Demo script for the pitch.
- [ ] **Step 2: Write `CLAUDE.md`.** Start with the required header, then cover:
  - Commands, including a single test run: `uv run pytest tests/test_crm_agent.py::test_tool_loop_executes_and_replies -v`.
  - The architecture big picture: reels data flow, CRM loop, webhook → `process_event` idempotency, and mock-mode convention.
  - Constraints from Global Constraints: no sampling params, no forced tool_choice, price guardrail, business text in yaml, FFmpeg lacking libass (captions via Pillow overlays), and that the public repo must never contain secrets.
- [ ] **Step 3: Verify** `uv run pytest -v` passes completely. Run `git status --ignored` and confirm `.env`, `secrets/`, and `data/` are ignored. Confirm `git ls-files | grep -E '\.env$|secrets/|data/'` is empty.
- [ ] **Step 4: Commit and push.**

```bash
git add README.md CLAUDE.md && git commit -m "docs: README and CLAUDE.md"
git push -u origin main
```
