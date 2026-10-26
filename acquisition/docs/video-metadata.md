# Video Production Agent → Acquisition Agent: Metadata Contract

The video production agent owns editing, publishing, and source provenance. The acquisition agent uses the exact post referenced by a customer to answer questions, inspect relevant video frames when necessary, and collect project requirements.

The answering sequence is:

**Read metadata → inspect video if the answer is missing → answer directly when supported → otherwise escalate that specific question and offer a quick meeting.**

A question awaiting a team member does not disable the acquisition agent. It can continue answering other questions, gathering requirements, and booking a consultation.

## 1. Submit a complete metadata snapshot

```http
POST /api/content/posts
Content-Type: application/json
Authorization: Bearer <WORKSPACE_TOKEN>
```

- Base URL for local development: `http://127.0.0.1:3000`.
- Use the deployed/tunneled service URL when the production agent runs on another machine. Its own `localhost` does not point to this service.
- The bearer token is required when `WORKSPACE_TOKEN` is configured. This prototype uses a shared workspace token, not a separate ingestion-only credential.
- Example payload: [`config/video-metadata.example.json`](../config/video-metadata.example.json).
- TypeScript contract: `VideoMetadata` in [`server/contracts.d.ts`](../server/contracts.d.ts).
- The example is explicitly synthetic. Replace its source references and set `demo: false` for real content.

The endpoint returns the stored record, including its internal `id`, with HTTP 201. Send a complete snapshot for each revision; this is not a partial PATCH endpoint.

### Identity and revision rules

- Keep `contentId` stable across systems and edits.
- Start `revision` at 1 and increase it whenever content or metadata changes.
- Retrying an identical normalized snapshot with the same `contentId` and `revision` returns the existing record.
- Different data under the same revision returns HTTP 409.
- An older revision returns HTTP 409.
- A new revision preserves the internal post ID and adds an archived version to `post_versions`.
- An Instagram media ID cannot be assigned to two different content records.

Tool logs record the metadata revision used to answer a question.

### Existing database sources

If the production agent already writes to a database, map its rows into `VideoMetadata` and submit them to this endpoint. Preserve the upstream identity in `source.system` and `source.recordId`.

A database connector or polling worker is not installed yet. Provide the database type, table structure, and a sanitized example row to implement that mapping. Uploading JSON through **Library → Import metadata JSON** also works for initial integration.

## 2. Register a video before detailed metadata exists

Detailed scene metadata is optional for visual inspection. Register the original video source first:

```http
POST /api/content/sources
Content-Type: application/json
Authorization: Bearer <WORKSPACE_TOKEN>
```

```json
{
  "contentId": "cedar-reel-001",
  "title": "Cedar House walkthrough",
  "videoDriveFileId": "ORIGINAL_VIDEO_DRIVE_FILE_ID"
}
```

Optional fields: `instagramMediaId`, `permalink`, `durationSeconds`, and `demo`.

This creates revision 1 with empty facts, raw sources, and segments. If duration is unknown, it remains `null` and is measured when decoding the video. The endpoint returns HTTP 409 if the content already exists. Later, submit the full metadata through `/api/content/posts` with a higher revision.

The UI provides the same operation through **Library → Register original video**.

## 3. Fields and source relationships

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Currently `1`. |
| `contentId`, `revision` | Stable content identity and increasing snapshot version. |
| `platform` | Currently `instagram`. |
| `instagramMediaId`, `permalink` | Add after publication to identify the exact original Instagram post. |
| `title`, `caption` | Display title and post caption; captions are not automatically verified facts. |
| `durationSeconds` | Edited video duration; required when defining segments. May be null when there are no segments. |
| `video.driveFileId` | Original edited video stored in Google Drive. |
| `source.system`, `source.recordId` | Upstream production system and database record identity. |
| `rawAssets` | Original images, footage, or documents with stable IDs, Drive IDs, descriptions, and sharing flags. |
| `segments` | Edited-video start/end times, descriptions, and optional transcripts. |
| `segments.rawAssetIds` | Raw sources used by this segment. |
| `segments.rawRanges` | Corresponding time ranges in original footage; omit for still images. |
| `segments.keyframes` | Optional precomputed video frames, each with a timestamp, Drive ID, and MIME type. |
| `facts` | Source-backed facts with separate verification and customer-visibility flags. May appear at post or segment level. |
| `demo` | True only for synthetic/demo content; never present it as a completed company project. |

Use Google Drive **file IDs**, not Drive share URLs, in `driveFileId` fields. Keep the original file private; the connected Google identity must be able to read it.

All segment and keyframe timestamps use seconds in the **edited video**. `rawRanges` use seconds in the **original footage**. This version stores range relationships, not frame-perfect mappings for speed changes and transitions.

### Validation constraints

- Content and raw/segment IDs must use safe alphanumeric, underscore, or hyphen identifiers.
- A snapshot supports at most 100 raw assets and 100 segments.
- Every segment must reference at least one existing raw asset.
- Segment ranges must fit within the declared video duration, which cannot exceed one hour.
- A segment supports up to 12 keyframe references; an inspection reads at most three.
- Facts must reference existing raw source IDs. Segment facts must reference that segment's raw sources.
- Invalid payloads return HTTP 400 with an error message; missing records return 404.

## 4. Keyframes and direct video fallback

A keyframe entry looks like this:

```json
{
  "atSeconds": 8.2,
  "driveFileId": "KEYFRAME_DRIVE_FILE_ID",
  "mimeType": "image/jpeg"
}
```

Supported keyframe formats: JPEG, PNG, and WebP. Keep each frame under 4 MB. Providing one to three useful frames per segment avoids decoding work during a customer conversation.

If precomputed frames are missing or unreadable, the acquisition agent attempts to download the original video from Drive and extract up to three frames using FFprobe and FFmpeg. It can inspect a timestamp even when there is no scene map.

Current decoding limits:

- Original video or proxy: at most 64 MB and one hour.
- Local FFmpeg and FFprobe installations are required; configure `FFMPEG_PATH` and `FFPROBE_PATH` if they are not on PATH.
- Frames are inspected through Claude image inputs, not by uploading the entire video to the model.
- Only sampled frames are inspected; this is not continuous video or audio understanding.
- Unavailable sources, decoding failures, or disabled vision are reported honestly. They are never recorded as successful visual inspection.

The current development environment has not completed real video decoding or live Claude integration tests. Contract tests use controlled frame/provider responses.

## 5. Verified facts and visual observations

Example of a source-backed fact:

```json
{
  "id": "countertop-material",
  "key": "countertop_material",
  "value": "Company-confirmed material description",
  "verified": true,
  "customerVisible": true,
  "sourceAssetIds": ["raw-material-spec"]
}
```

`verified: true` requires reliable company/project information. A model's visual guess is not verification. Descriptions, captions, and transcripts are contextual annotations and do not establish exact dimensions, brands, materials, permit status, price, or construction commitments.

Visual inspection may answer directly visible questions such as cabinet color or whether an island appears in the kitchen. It must distinguish those observations from exact engineering specifications. Only facts that are both verified and customer-visible are exposed as authoritative answer evidence; price facts are additionally filtered when quoting is off.

Do not copy a reference project's dimensions or layout into the customer's project. Only record such a preference when the customer explicitly adopts it, preserving the customer message as evidence.

## 6. Associate a conversation with the exact post

- Inbound event ingestion can supply `postId`, using the internal post ID, `contentId`, or Instagram media ID.
- A known canonical Instagram URL in a customer message resolves the post; a trailing slash is optional.
- A team member can select the source post in the conversation sidebar.
- Supported story/referral/share references in incoming webhooks are matched when available.
- An explicit unknown post URL clears the previous context, preventing an answer about the wrong video.
- If no source can be identified, ask the customer for the post link. Do not guess that they mean the latest post.
- When a scene map contains several possible segments, ask for a timestamp or short description if needed.

## 7. Tools available to the acquisition agent

### `get_post_context({ postId? })`

Returns the exact original post, metadata revision, upstream source identity, scene timeline, raw-source relationships, and verified customer-visible facts. When `postId` is omitted, it uses the conversation's linked source.

Reading metadata does not imply the video was watched. Internal Drive links are not returned as customer-shareable assets.

### `inspect_video_segment({ postId, segmentId?, atSeconds?, question })`

Uses supplied keyframes or extracts frames from the original video. Omit `segmentId`, or use `whole-video`, when there is no scene metadata. The tool asks Claude whether the question can be answered reliably from the sampled images.

Successful reports include:

- `visualInspectionPerformed: true`
- `frameSource`: `provided_keyframes` or `extracted_from_original_video`
- `frameTimes`, `observations`, and `uncertainties`
- `canAnswer` and `answer`
- Post ID, metadata revision, segment, and available raw-source references

If inspection cannot run, the result has `visualInspectionPerformed: false`, `canAnswer: false`, and an explanation. Model/provider failures may instead produce an error tool result.

When `canAnswer` is true, answer the supported visual question directly. Otherwise, route only the unresolved question to the team and offer a quick meeting. Do not stop all conversation activity merely because one answer needs confirmation.

## 8. Human assistance versus conversation ownership

`request_human_handoff` defaults to `scope: "topic"`. A topic handoff records the question and source context while the agent remains available for other questions, project discovery, and booking.

Only a full conversation takeover, or an explicit customer request to stop automated replies, pauses the assistant. Switching ownership does not automatically resolve pending topic questions.

In **Answer question**, the team can save a verified answer internally or send the exact text to Instagram. A single human reply does not require taking over the entire conversation. The agent receives the conversation/team-answer context afterward.

## 9. Inspect sources in the workspace

Open **Library → Original posts & provenance → View post & sources** to:

- Open the original Instagram post and edited Drive video.
- Inspect the edited timeline and corresponding raw-footage ranges.
- Open raw files using the viewer's Google permissions.
- Ask about a segment and inspect the tool's evidence report.

The conversation sidebar provides the same source entry point. Private Drive IDs, database keys, and raw-source links are not automatically forwarded to customers.
