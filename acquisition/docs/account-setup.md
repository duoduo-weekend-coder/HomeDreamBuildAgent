# 账号、权限与 API 接入

在项目根目录 `.env` 填写密钥；以 `.env.example` 为字段模板。不要把真实 key、refresh token、密码或浏览器 cookies 写进 metadata 或聊天。配置不会因为填入 key 就自动启用；对应 provider 仍需选择真实模式并重启。

先进入获客应用目录，再创建本地 `.env`。仓库中的应用位于 `acquisition/`。

## 先准备这几项

| 项目 | 需要提供 | 填写位置 |
| --- | --- | --- |
| Claude | 比赛额度所属 workspace 的 API key、可用模型 ID | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` |
| Google OAuth | Client ID、Client Secret、Refresh Token | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN` |
| Drive | 工作目录 ID、原始图片目录 ID；账号可读视频及其关键帧 | `GOOGLE_DRIVE_ROOT_ID`、`GOOGLE_DRIVE_MEDIA_FOLDER_ID` |
| Calendar | 用于咨询预约的日历 ID；授权账号可创建和修改事件 | `GOOGLE_CALENDAR_ID` |
| Instagram API | 专业测试账号、Instagram account ID、token、App Secret、API version | `INSTAGRAM_*` |
| Instagram webhook | 公网 HTTPS 回调地址、自己生成的 Verify Token | 回调 `/webhooks/instagram`；`INSTAGRAM_VERIFY_TOKEN` |
| Browser Use | 本机已登录的专用浏览器 profile、浏览器及 Python 路径 | `BROWSER_PROFILE_DIR`、`BROWSER_EXECUTABLE_PATH`、`BROWSER_PYTHON` |
| Video metadata | 一份英文协议对应的 JSON，或源表结构与去敏样例 | [英文协议](video-metadata.md)；不包含账号密钥 |

文件夹链接、日历 ID、测试账号 handle 和去敏后的表结构可以直接给我。密钥填进本地 `.env` 后，只需告诉我哪些项已填；验证时不回显密钥。

## Claude：最先接这一项

在比赛 credit 所属的 Claude workspace 创建 API key，写入 `.env`，并填一个该账号可用的 model ID。当前对话、视频视觉和 Browser Use 共用这两个变量。API key 创建入口见 [Claude 官方说明](https://platform.claude.com/docs/en/manage-claude/authentication)。

```dotenv
ACQUISITION_AI_PROVIDER=claude
ANTHROPIC_API_KEY=填写真实值
ANTHROPIC_MODEL=填写账号可用的模型ID
VIDEO_VISION_PROVIDER=claude
```

填好 key 后可运行 `npm run check:claude`，只查询认证和可用模型，不发生成请求，不输出 key。模型列表成功也不代表已验证额度余额。

这里只说明配置，示例中的中文占位值不可直接运行。其他服务可以继续 mock，先单独验证 Claude 对话。

## Google：一套 OAuth 连接 Drive 和 Calendar

推荐先使用专用测试 Google 账号、测试文件夹和咨询日历。

1. 在 Google Cloud 项目中启用 Google Drive API 和 Google Calendar API。
2. 配置 OAuth consent；测试阶段把实际授权账号加入 Test users。
3. 创建 Web application 类型的 OAuth Client。若使用官方 OAuth Playground 获取凭据，将 `https://developers.google.com/oauthplayground` 加为授权 redirect URI。
4. 打开 [Google OAuth Playground](https://developers.google.com/oauthplayground/)，齿轮中选择 **Use your own OAuth credentials**，填写刚创建的 Client ID/Secret，使用 Offline access。
5. 请求所需 scopes，登录测试账号授权，然后交换 authorization code，取得 refresh token。
6. 将 Client ID、Secret、Refresh Token 写入 `.env`。使用 refresh 方案时保持 `GOOGLE_ACCESS_TOKEN=` 为空；代码优先使用这个字段里的短期 access token。

当前适配器需要 Calendar 事件读写及 free/busy 查询。可使用：

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.events.freebusy
```

日历本身也要允许该 Google 账号编辑事件；scope 不会替代日历共享权限。参见 [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)。

Drive 当前按目录 ID 枚举并读写既有文件，没有 Google Picker。专用测试账号的快速联调可使用 `https://www.googleapis.com/auth/drive`，但这是该账号可访问 Drive 内容的广泛权限，并非只授权指定文件夹。若要最小文件级授权，应补 Picker/逐文件授权流程后使用 `drive.file`；仅知道目录 ID 不会自动取得目录内所有文件的访问权限。参见 [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)。

```dotenv
DRIVE_PROVIDER=google
CALENDAR_PROVIDER=google
GOOGLE_CLIENT_ID=填写真实值
GOOGLE_CLIENT_SECRET=填写真实值
GOOGLE_REFRESH_TOKEN=填写真实值
GOOGLE_ACCESS_TOKEN=
GOOGLE_DRIVE_ROOT_ID=工作目录ID
GOOGLE_DRIVE_MEDIA_FOLDER_ID=原始参考图片目录ID
GOOGLE_CALENDAR_ID=咨询日历ID
```

- Drive 地址 `https://drive.google.com/drive/folders/ABC...` 中的 `ABC...` 是目录 ID。
- Calendar ID 可在该日历的 Settings → Integrate calendar 查看；`primary` 代表授权账号的主日历。
- 原视频和关键帧可以位于其他目录，但同一授权账号必须可读取它们。
- 当前不支持直接读取 service-account JSON；请提供上述 OAuth 凭据，不是普通 Google API key。

## Instagram API：接收 DM 和回复

当前实现使用 **Instagram API with Instagram Login** 和 `graph.instagram.com`。准备一个 Business/Creator 专业测试账号，在 Meta 应用内授权它；不要混用另一路 Facebook Login 的 Page token 配置。

基础 DM 权限：

```text
instagram_business_basic
instagram_business_manage_messages
```

测试账号需要满足应用角色/测试授权要求。使用另一个获准测试的 Instagram 账号发来真实 DM，再验证接收和回复。Meta 的官方 API 集合说明了专业账号、权限及测试账号要求：[Instagram API — Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-3fe78620-2258-44b6-893f-42d76c7200d7)。

`.env` 对应：

```dotenv
INSTAGRAM_PROVIDER=instagram
INSTAGRAM_API_VERSION=应用支持的版本号
INSTAGRAM_ACCOUNT_ID=授权专业账号的API账号ID
INSTAGRAM_ACCESS_TOKEN=该Instagram授权返回的token
INSTAGRAM_APP_SECRET=对应Meta应用的secret
INSTAGRAM_VERIFY_TOKEN=自己生成的随机验证字符串
WORKSPACE_TOKEN=另一个独立随机字符串
```

`INSTAGRAM_ACCOUNT_ID` 是数字 API 身份，不是 `@username`。App Secret、Access Token、Verify Token 是三种不同的值。

### 可选：Facebook Page Access Token

Facebook Login 的凭据单独存放，不覆盖现有 Instagram Login 配置：

```dotenv
META_APP_ID=
META_APP_SECRET=
META_BUSINESS_ID=
FACEBOOK_PAGE_ID=
FACEBOOK_API_VERSION=v26.0
FACEBOOK_USER_ACCESS_TOKEN=
FACEBOOK_PAGE_ACCESS_TOKEN=
```

填写自己管理的目标 Page 和业务账户 ID。授权用户需有该 Page 的相应任务权限；通过业务资产分配的访问可能还需要 `business_management` 授权。Page 读取与发布使用的 scopes 包括 `pages_show_list`、`business_management`、`pages_read_engagement` 和 `pages_manage_posts`。

使用 Facebook User Token 调用 `/me/accounts?fields=id,name,access_token,tasks`，只保存目标 Page 返回的 token。通过 `/debug_token` 核对 `type=PAGE`、`profile_id`、`is_valid`、权限及有效期，再用 Page token 调用 `/me?fields=id,name` 验证身份。不要把 token 写进日志或文档。

Graph API Explorer 生成的凭据可能很快过期。长效交换需要对应 Facebook 应用的 App Secret；以 `/debug_token` 的实际结果为准，即使没有固定到期时间也可能因撤销授权等原因失效。验证记录应保存在忽略跟踪的本地 `data/` 中，不包含 token。

这些配置仅保存额外凭据，尚未实现 Facebook 自动发布功能，也不代表已完成 Instagram 的 Facebook Login 发布授权。现有 DM、评论处理继续使用 `INSTAGRAM_ACCESS_TOKEN`。

回调地址必须能由 Meta 访问：

```text
https://你的HTTPS服务地址/webhooks/instagram
```

应用 dashboard 的 webhook Verify Token 与 `.env` 保持一致；完成回调验证和消息事件订阅。单纯填 token 不会自动建立订阅。项目已有验证回调和消息 HMAC 检查，但没有一键 OAuth onboarding 界面。公网地址或本地隧道尚未配置；需要这一步才会收到真实 webhook。

`WORKSPACE_TOKEN` 是工作台和 metadata API 的访问凭据，不能替代 Meta Verify Token。Meta webhook 使用自己的验证逻辑；若隧道也暴露工作台路由，务必先设置工作区 token。

本地联调可以使用仅开放 webhook 的代理，分别在三个终端运行：

```bash
npm start
npm run webhook:proxy
data/bin/cloudflared tunnel --url http://127.0.0.1:3001 --no-autoupdate --protocol http2
```

代理仅转发 `/webhooks/instagram` 的 GET/POST，保留签名和原始请求体；其他路由返回 404。把隧道输出的 HTTPS 域名加上 `/webhooks/instagram` 填入 Meta。`cloudflared` 需单独安装，当前本机副本位于 git 忽略的 `data/bin/`。临时隧道随进程关闭而失效，重新启动可能更换域名，届时须更新 Meta 回调；正式部署应使用固定域名。此入口不提供跨机 metadata 导入。

本次只验证真实 DM 接收与文本回复。评论/Insights 历史拉取尚未实现；无需为本 agent 申请自动发帖权限。

## Browser Use：主动 DM 使用本机登录态

这是单独的执行通道，不是把 Instagram 密码填进 `.env`。

1. 准备一个专用浏览器 profile，并由你在本机登录专业测试账号、完成验证码。
2. 关闭正在使用该 profile 的其他浏览器进程，避免 profile 文件锁冲突。
3. 安装可选 Python 环境：参见 [README](../README.md) 的 Browser Use 步骤。
4. 填写 profile、浏览器 executable 和该 Python 环境的路径。

```dotenv
BROWSER_PROVIDER=browser_use
BROWSER_PROFILE_DIR=/浏览器profile根目录
BROWSER_EXECUTABLE_PATH=/Chrome或Chromium程序路径
BROWSER_PYTHON=/专用Python环境/python
```

浏览器、Python worker 和 profile 应处在兼容的运行环境。不要将 Windows profile 路径直接交给 WSL Linux Chrome 使用；确认选用 Windows 或 WSL 的哪套浏览器后再配置。

Browser Use 使用同一个 Claude key；首次触达由队列审核执行，结果仍需在工作台核实。此通道不自动提供所有点赞名单或完播者身份。

## 视频与数据库来源

给制作视频的同学发送 [英文 metadata 协议](video-metadata.md) 和 [JSON 样例](../config/video-metadata.example.json)。同机可以 POST 到本地服务；跨机提供 HTTPS base URL 和 workspace token，由其保存在自己的环境配置中，不放进 metadata。

如果他们已经有数据库，先给：数据库类型、表名、字段定义和一行去敏数据。当前本项目运行数据是 SQLite + Drive；没有已接好的 PostgreSQL/Supabase 驱动。确定协议映射后再按实际驱动填写数据库凭据。

## 接入顺序

1. Claude key：先在模拟 Instagram 下验证真实对话与工具选择。
2. Google OAuth、目录与日历：验证读取原素材、同步客户资料、查空闲。
3. Instagram app/token 与 HTTPS webhook：验证测试账号来信和一条工作台人工回复。
4. Browser profile：再验证一条主动 DM。

保持报价 off。先完成配置和读取验证，再执行具体测试写入；填入凭据本身不代表这些外部操作已经验证成功。


## Instagram comments

Subscribe the business account to `comments` in addition to `messages`. The app-level webhook subscription alone is not enough; preserve existing fields when updating `/{IG_ACCOUNT_ID}/subscribed_apps`.

Signed comment events are saved as interactions and comment jobs without opening a DM reply window. A separate Claude assessment proposes a short public reply and, for project/service/pricing inquiries, one low-friction private invitation. Compliments do not trigger private acquisition messages. Review-mode contacts produce drafts in **Comments & acquisition**; auto-mode contacts send automatically unless the assessment requests human review. Existing DM conversations receive no new acquisition invitation. Topic handoffs leave the DM assistant available.

Public replies use `POST /{COMMENT_ID}/replies`; private replies use `POST /{IG_ACCOUNT_ID}/messages` with `recipient.comment_id`. Meta allows one private reply within seven days of the comment. Further messages require the customer to respond and then follow the normal 24-hour messaging window. This implementation also suppresses repeat invitations across comments by the same contact. Instagram Live comments are excluded because their deadline is tied to the live broadcast.

The dashboard and Drive `tables/Comments.json` / `tables/CommentFunnel.json` retain comment text, source media ID, intent reason, response statuses and observed invitation-to-DM conversion. The conversion denominator counts contacts with confirmed API invitations; existing DM contacts are excluded. These are cumulative observed results, not a mature cohort comparison or proof of causal attribution. Unknown delivery results require inspection in Instagram and are never automatically retried.

Exact source metadata is resolved using the Instagram media ID. Video tools can inspect an original video registered in the source library when metadata is insufficient. Unlinked videos still need their original source connected; a media ID alone does not imply the video was watched. CRM context retains the customer's original acquisition comment when they respond by DM.

Validation: automated tests cover signed-event deduplication, foreign/self-comment filtering, private reply deadlines, opt-out, review/human ownership, duplicate invitations, unknown send recovery, API payloads, DM conversion and the workspace page. A real Claude comment assessment and live account subscription were verified. Real public/private comment delivery must be checked with a test comment; simulated adapter tests do not prove that delivery.

Official references: [Private replies](https://developers.facebook.com/docs/instagram-platform/private-replies/) and [Comment moderation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation/).


## Clickable DM questions

`docs/New Home Client Questionnaire.pdf` is a two-page static reference with 20 Yes/No questions, not an interactive PDF form. Its questions are stored in `config/reference-questionnaire.json`; the linked form keeps 19 reference questions: planning help first, land ownership second, related project-readiness and preference questions next, and the two playful questions last. Only specialist_call is excluded from the form. `formEnabled` controls inclusion in the form; `enabled` controls individual chat questions (the casual questions remain disabled in chat). `formQuestion` adapts PDF wording for early discovery; `sourceNumber` preserves the PDF question number and `number` sets the display order. Consultation is excluded from the form and offered in chat only after discovery readiness allows it or the customer asks. Other specialized questions have contextual `chatWhen` guidance. Reference answers are stored separately from exact project facts: Yes to having a budget must not become a numeric budget, and Yes to financing does not distinguish a loan from cash.

`config/quick-replies.json` configures city, permit, plans, uncertainty, and free-consultation choices. Native Instagram quick replies use text buttons (maximum 13, title maximum 20 characters). They are supported on mobile, not Instagram desktop according to Meta's current documentation. Keep the question understandable in plain text so desktop customers can type an answer. Phone/email autofill quick replies are unavailable on Instagram. The PDF cannot be filled inside a DM; this implementation asks one question at a time instead.

Each button is bound to its contact, sent message, active project and ownership version. Stale selections do not update facts or book a slot. Consultation Yes checks real calendar availability; choosing a current slot explicitly permits booking. Not now continues the conversation without booking. Unknown answers and skipped fields remain distinct. Website links appear in first replies, outreach introductions, and first comment invitations. The free offer covers the initial consultation with a team member only.

A failed inference can be reviewed and retried through the authenticated `POST /api/inbound-events/{id}/retry` endpoint. It rejects superseded turns and any turn with an existing outbound message or booking attempt; those require outcome reconciliation. Inference network retries never repeat external tool writes.

Official reference: [Instagram quick replies](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/quick-replies/).


## Optional intake and booking calendar

`PUBLIC_CUSTOMER_ORIGIN` points to the public HTTPS origin used by `/customer`. The public proxy exposes only this page, its two assets, and the five exact `/api/customer/*` routes for session, slots, booking, rescheduling and intake. Workspace routes remain inaccessible through the tunnel. Customer links carry a random, expiring capability in the URL fragment; the browser moves it to tab storage and sends it as an authorization header. Links are limited to one customer/project, expire after 24 hours, and stop working after ownership changes, project changes or opt-out. No Google event titles or other customers' data are returned.

The assistant first offers an optional short form and waits for acceptance. The form uses the 19 Yes/No questions selected from the reference PDF, with Yes, No, Not sure and Skip controls, and prefills existing reference answers. It has no numeric or free-text inputs. Location, budget amounts, square footage, layout and contact details are collected through quick replies or typed messages in Instagram. Submission saves `questionnaireAnswers` and history on the existing project, rejects stale answers or changed question definitions and resumes the same conversation. Form submissions do not open or extend the Instagram messaging window. The form has no consultation question and cannot trigger a calendar link as a booking request. Old versions of the questionnaire are rejected on submission and must be refreshed. A direct request or accepted consultation invitation in chat can open the calendar; no appointment is made until the customer confirms a slot. Numeric project facts cannot be written by the agent during the questionnaire submission turn.

Proactive consultation invitations require the fields configured in `qualification.schema.json` → `defaults.consultationReadiness` to have been discussed, with the configured minimum number confirmed. Unknown and declined answers count as discussed. Explicit customer requests to meet or speak to a person can proceed earlier. Internal topic escalation does not itself trigger a meeting invitation.

Customers book on a date/time calendar instead of answering A/B/C in Instagram. It displays the next 14 days of configured consultation times, filtered by real Google Calendar free/busy data. It does not imply staff availability outside configured consultation hours. Confirmation rechecks availability and creates one event; duplicate requests do not duplicate bookings, and uncertain Google writes are quarantined. Legacy text-slot confirmation remains available only for compatibility tests with `CALENDAR_UI=text`; normal runtime uses the page.

An existing appointment opens the calendar in reschedule mode, including unused calendar links sent before rescheduling was enabled. The original time remains reserved until the customer selects a new 30-minute slot and presses **Confirm time change**. Confirmation rechecks availability and PATCHes the same Google Calendar event with its ETag (`If-Match`), preserving attendees and event identity. The CRM updates the same booking, records the previous time in its history, and moves the existing preparation task. Duplicate confirmations are idempotent; stale tabs cannot overwrite a later change. An uncertain write blocks another change until the dashboard's **Verify time change** action reconciles Google’s actual result. The confirmed appointment page also offers **Change appointment time**. No existing booking is cancelled merely because a customer asks for another time.

Live message intents are assessed semantically by Claude with conversation context and a validated structured tool result (`server/acquisition/intent.mjs`). Booking/rescheduling, form acceptance, explicit human requests, opt-out and abandonment do not use customer-text keyword routing. A real Instagram button payload is an explicit structured choice; typing the same label still goes through the model. Failed or malformed assessments do not fall back to keyword actions. Deterministic text fixtures remain restricted to offline mock mode; the explicitly requested developer-only `hi` reset is a separate test control. Model assessments are saved on inbound events/messages for inspection and retry. Model interpretation does not bypass ownership, service-area, calendar-conflict or explicit confirmation checks.

The quick-tunnel origin is temporary. If it changes, update `PUBLIC_CUSTOMER_ORIGIN` and the Meta callback URL; previously sent links on the old origin will no longer work.


The short form is proactively introduced once after project interest and the configured number of customer messages (`defaults.shortFormOffer` in the qualification schema), while enough core information remains unknown. Both the invitation and link explain that it takes about 1 minute to understand basic project information. Declining continues chat; customers do not need to know a form exists.

Instagram send echoes can arrive before the sending API returns a message ID. Such echoes are queued while a write is in flight and matched against the final external ID before considering human takeover. A genuine unmatched native reply still transfers ownership; confirmed own-message echoes do not invalidate customer links.


## Developer test restart

For repeated testing with the same Instagram account, set `DEVELOPER_TEST_RESET_ENABLED=true` and put only the verified tester's Instagram-scoped ID in `DEVELOPER_TEST_INSTAGRAM_IDS` (comma-separated). Both settings are required; the example configuration is disabled. Matching usernames do not qualify.

A standalone `hi` (case-insensitive, surrounding whitespace allowed) from that identity creates a fresh project and test round. The assistant and active dashboard ignore previous project messages, facts, questionnaire answers, handoff answers and source-post context. Form-offer state and test opt-outs are reset, automation resumes, and the first reply is the configured introduction with the website. Previous records remain archived for audit; prior customer links and buttons cannot affect the new project. Duplicate or historical webhook deliveries do not restart the test again. Real calendar appointments are retained, not automatically cancelled; a late booking result stays attached to its original project.

Ordinary customer greetings retain their conversation state, including opt-outs and human ownership. Turn off the developer flag when testing ends.


## Conversion insights

The top acquisition overview includes direct Instagram DMs, observed comments, delivered form invitations, saved questionnaire submissions and confirmed bookings. Each metric counts distinct contacts, not messages. A form preview does not count as a submission, form submission does not count as a DM, and unknown/cancelled bookings do not count as confirmed meetings. The form completion rate uses only contacts actually offered the form as its denominator and numerator cohort.

Use All activity, Customers or Developer tests to select the overview scope. Tests are visibly labelled and the Customers view excludes them. Only each tester’s latest round appears; restarting with `hi` clears that round’s progress while prior records remain archived. The first-outreach cohort report remains a separate report across all first-outreach contacts; it does not measure organic incoming DMs.

The Conversion insights page fetches fresh data every 5 seconds while visible, and pauses refresh when an operator dialog is open. The same overview is synced to Drive as `tables/AcquisitionInsights.json`.


## Follow-up based on questionnaire answers

After submission, the assistant acknowledges the saved answers and selects one relevant unanswered discovery field. `qualification.schema.json` defines `whenQuestionnaire`, `skipWhenQuestionnaire` and `answeredByQuestionnaire`; these rules apply to next-field selection and question tool checks. `lot_area` is asked only for `land_owned=yes`, and is stored separately from desired home `square_footage`. No, unknown or skipped land ownership does not trigger lot-size questions. An unset/unknown budget skips immediate requests for an amount; an answered blueprint question is not repeated. Existing facts and questions already asked are respected. The same conditions are supplied to Claude for subsequent conversational follow-ups.

Playful form answers are preserved as preferences, not buying signals or booking consent. Numeric/text details stay in chat; the form does not infer amounts from Yes/No answers.


## Service-area gate

Confirmed project locations are checked against `business-profile.json` service areas and configured aliases. Only project-site facts count; the assistant must distinguish a customer's current residence from the intended construction location. Unknown locations remain unconfirmed. A tentative/inferred project location such as “Seattle maybe” specifically pauses further discovery and invitations until the location is clarified; it cannot silently qualify as covered.

A confirmed location outside configured coverage is marked `outside_service_area`, pauses discovery with a recorded reason, cancels automatic follow-up tasks, and blocks qualification questions, forms and automatic calendar invitations. It does not mark the customer lost or stop the conversation agent. Existing form/calendar links also recheck coverage. The assistant states current coverage directly rather than reconfirming an already confirmed location. General answers and an explicitly requested team handoff remain available. Correcting the project location into the covered area resumes discovery. Already confirmed appointments are not silently cancelled.


## Customer records and team notifications

Conversion insights counts unique incoming DM contacts and contacts with a delivered assistant/team reply in the acquisition overview. The separate outbound campaign report counts only confirmed proactive first messages; it displays an explanatory empty state until a campaign starts. It must never inflate outbound conversions with incoming DMs. Confirmed meetings in customer progress show the start/end time and calendar timezone, including verified reschedules. Uncertain changes are labelled for verification.

Each customer gets a continuously updated, readable Drive file at `collected-data/contacts/{contactId}/customer-record.txt`. It consolidates current project facts, questionnaire answers, appointments, team questions, conversation, attachments and change history. Dashboard customer details and Conversion insights link directly to that file, with sync status. `tables/CustomerRecords.json` contains the consolidated records for all contacts. Existing Drive links remain available while updated content is queued. Records stay within the configured private Drive folder; customer-facing pages never expose these links. Developer test records include only the current test round; prior operational records remain archived separately.

A semantic request to speak with a team member creates a high-priority `live_chat` handoff. The response explains that a person can reply in Instagram, without promising immediate availability, and offers an optional free initial consultation where service coverage allows it. The assistant continues unless the customer explicitly requests exclusive human ownership. Technical questions remain separate topic handoffs.

The authenticated `/api/notifications` endpoint returns waiting team requests. The dashboard polls it every 5 seconds and updates a persistent alert independently of the message composer. **Enable browser alerts** requests browser notification permission only after a team member clicks it. System alerts require permission and an open dashboard tab; this is not background push when the dashboard is closed. WhatsApp is the selected external channel; its sender and recipient setup is still required. Opening a request does not claim it; taking over claims a live-chat request, and a successfully delivered human reply resolves it. Failed/unknown sends keep it pending. Notifications are deduplicated per browser tab and handoff ID.


## WhatsApp team alerts (setup required)

The selected external notification channel is WhatsApp. Configure the separate WhatsApp Business Cloud API sender in `.env`: `TEAM_NOTIFICATION_CHANNEL=whatsapp`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEAM_RECIPIENT` (international number), `WHATSAPP_TEMPLATE_NAME`, and `WHATSAPP_TEMPLATE_LANGUAGE`. Instagram credentials do not supply WhatsApp messaging authorization. No WhatsApp sender, recipient or approved template has been supplied yet; live delivery is not enabled.

Prepare a body-only approved template with three positional text parameters, for example: “Team request from {{1}}: {{2}}. Reference: {{3}}. Please open the acquisition dashboard to reply.” The parameters are the Instagram handle, a fixed request summary, and handoff ID. Use the approved template's exact name and language. This alert does not copy the customer's full conversation or credentials. Meta determines template approval/category; this code does not submit or approve templates.

New explicit live-chat handoffs create one durable WhatsApp notification job per handoff. Missing configuration leaves the job in setup-required state and dashboard alerts continue working. The worker sends only while the request is still waiting in the current project. Resolved or claimed requests cancel queued sends. HTTP acceptance is recorded as `accepted`, not delivered or read; delivery status webhooks are not implemented. Unknown network results and interrupted sends are quarantined without automatic retries. The recipient must be the team member designated by the workspace owner. Receiving a WhatsApp alert does not require the dashboard to be open, but the backend worker must be running. Team replies still go through the dashboard to Instagram; WhatsApp reply forwarding is not implemented.

API reference: https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive


## New-account chat access

Set the workspace reply mode to `auto` to let new Instagram conversations receive automatic replies. This is persisted in the local database; editing the default JSON alone does not change an existing workspace. The signed webhook accepts messages for the configured business account without a customer allowlist. Meta must still deliver the event and authorize the reply, so verify with an independent Instagram account before a live demonstration. Developer-only `hi` resets apply solely to the IDs explicitly configured in `DEVELOPER_TEST_INSTAGRAM_IDS`; do not add real customers to that setting.
