# Home Dream · Instagram 获客工作台

当前只做**自动获客 / 对话 / 客户资料 / 预约 / 真人接管**。制作视频和自动发帖由另一个 agent 负责；本项目读取它产出的原始 post、视频 metadata 和 raw source。

默认不需要 API key、数据库链接或账号权限，全部使用明确标注的演示适配器。界面使用英文，方便比赛展示。

## 启动

需要 Node.js 22.13+。主程序没有第三方 npm 依赖。

```bash
npm start
```

打开 **http://localhost:3000**。开发可用 `npm run dev`。

首次启动自动建立 `data/workspace.sqlite` 和示例客户。配置文件可直接编辑；在 Settings 点击 **Reload files** 加载。数据和 `.env` 不入版本管理。

## 当前实现

- **Conversations**：Instagram 对话模拟器、单轮最多一问、同时抽取多个事实、资料来源和修改历史、动态 checklist、可选预填表单。
- **Prospects & outreach**：可识别的点赞/评论等互动记录、首条介绍消息、人工审核、Browser Use 可选执行器、结果核实和重复发送保护。
- **Projects & handoffs**：活跃度 / 意向 / 地区匹配分开记录；阶段、明确流失原因、接管摘要、人工回复、显式交回助手。
- **Google Calendar**：展示日期与空位的预约日历，用户选中时间并确认后才预约；确定性事件 ID、再检查冲突、取消和结果核实。时区与工作时间在配置里。
- **Reference library**：上传或从指定 Drive 文件夹导入原始图片；分享批准开关；客户图纸与原始素材隔离。
- **原始 post / 视频来源链**：metadata 导入、版本去重、原始 Instagram post 和 Drive 文件入口、成片时间段 → raw source 时间段、已核实事实、关键帧视觉工具。
- **Analytics**：首次触达分组、唯一客户计数、7/30 天观察窗口、成熟 cohort、回复/获客/预约转化率；匿名观看数据单独保存，缺失值保持 unknown。
- **报价工具开关**：默认 off；review_required 只生成内部待审记录；auto 要求 owner-approved 价格表。现有虚构测试费率不能启用到客户报价。
- **数据可靠性**：SQLite 本地索引 + 持久化 Drive 同步队列、每 15 秒处理后台任务、失败重试、进程中断后不自动重发结果不明的动作。

## 五分钟演示

1. Conversations 选择 **Alex Morgan**。展开 **Try a customer message**，点击 Project details；观察右侧一次补齐多项信息，以及 tool log 的来源记录。
2. 点击 **Show references**，看到标明“sample illustration”的素材回复。
3. 点击 **Book a meeting**，再选 **Choose A**。会保存一个明确标注的模拟预约，并建立人工会前准备任务。
4. 点击 **Ask a person**；建立待真人确认的问题，agent 继续服务并可预约。只有 **Take over** 才暂停整段对话；**Return to assistant** 恢复。也可不接管，直接将输入角色切为 Intake team 发送一条人工回复。
5. Prospects 中给 Mia **Draft hello → Approve & execute**。当前默认只模拟发送；Analytics 出现首触达分组和观察中客户。
6. Library 查看 **Original posts & provenance**。在客户侧栏关联示例 post，再发送 `What exterior style is shown in the video?`。工具读取 metadata，不把视频项目属性写入客户需求。
7. 发送 `What material is the floor at 8 seconds in the video?`。示例没有真实关键帧，助手会说明无法确认并带着片段来源交给真人。

## Checklist 和数据目录

`config/qualification.schema.json` 独立定义字段、优先级、提问句、枚举和提问条件。新增字段无需改业务代码；离线 demo 可用 `字段ID: 值` 测试，真实 Claude 直接读取 schema。

预置字段：permit、location、budget、square_footage、layout、blueprints、available_time。允许未知/不愿回答，不要求填完才能预约。

```text
data/
  workspace.sqlite           本地运行索引、客户资料和持久化队列
  uploads/                   经工作台上传的参考素材
  private/                   客户附件，不通过静态目录公开
  browser-jobs/              单次 browser 执行请求与结果
  drive-mirror/              mock 模式的本地 Drive 镜像，不是云备份
    config/
    source-materials/        原始素材、素材目录
    collected-data/          客户 / 项目 / 私有附件
    operations/             消息、事件、post metadata、工具记录、预约
    tables/                 Prospects / Interactions / Outreach / ContentMetrics / Funnel.json
```

表格目前是工作台表格 + Drive JSON 投影，**还没有原生 Google Sheets 写入器**。Drive 同步为单向备份/投影，不把远端手工编辑直接合并进正在运行的数据库。已提供 Drive 原始图片读取入口；视频 agent 的数据库源通过 metadata 接口接入。

## 接入真实服务

逐项获取账号、OAuth、webhook 和浏览器 profile 的步骤见 [账号接入指南](docs/account-setup.md)。给视频制作同学的协议已使用 [英文版本](docs/video-metadata.md)。

复制 `.env.example` 为 `.env`，再填写对应配置。所有 key 只在服务端使用。真实 provider 缺少必要配置会报错，不会静默回落到模拟。

| 服务 | 配置和当前状态 |
| --- | --- |
| Claude 对话 | `ACQUISITION_AI_PROVIDER=claude`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`；原生 Messages API + 工具循环，最多 6 轮 |
| 视频视觉 | `VIDEO_VISION_PROVIDER=claude`；共用 Claude key/model；从 Drive 读取制作 agent 提供的关键帧，每次最多 3 张；没有预生成关键帧时用 FFmpeg 从原视频抽帧 |
| Google Drive | `DRIVE_PROVIDER=google`、`GOOGLE_DRIVE_ROOT_ID`、Google access token 或 OAuth refresh credentials；可选 `GOOGLE_DRIVE_MEDIA_FOLDER_ID` 导入已有图片 |
| Google Calendar | `CALENDAR_PROVIDER=google`、`GOOGLE_CALENDAR_ID` 和相同的 Google 凭据；先配置公司时区与可预约工作时间 |
| Instagram API | `INSTAGRAM_PROVIDER=instagram`、账号 ID / token / API version / app secret / verify token；支持签名校验的消息 webhook 和文本回复 |
| 主动 DM | `BROWSER_PROVIDER=browser_use`；独立 Python 环境和已登录的专用浏览器 profile；或用 `manual` 模式人工执行并登记结果 |
| 视频 agent 的数据源 | `POST /api/content/posts`；用 `source.recordId` 保留上游数据库主键。格式见 [video-metadata.md](docs/video-metadata.md) |
| 外部客户数据库 | 目前 SQLite + Drive 已运行；外部数据库迁移/映射等待你提供链接和表结构 |

Google access token 可用于快速联调；持久运行应配置 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`。需要 Calendar 日历读写，以及对应 Drive 文件/文件夹的读写访问。OAuth 授权页面本次未实现。

Instagram webhook 路径：`/webhooks/instagram`。先完成 Meta 对测试账号的授权、消息订阅与验证。当前采取保守的 24 小时自动回复窗口；不通过 HUMAN_AGENT 标签发送自动消息。未实现历史互动回填、全部 Insights 拉取、点赞名单抓取或自动识别完播者。

Live Instagram 图片发送仍需可访问的 attachment/public media URL 适配器；目前会明确失败，不会公开客户 Drive 文件。客户通过 Instagram 发送的图片/附件先路由真人，尚未自动导入附件内容。

## 可选 Browser Use

Node 主程序无须安装 Python 依赖；只有开启真实 browser executor 时才需要：

```bash
python3 -m venv .venv-browser
.venv-browser/bin/pip install -r tools/requirements-browser.txt
```

Windows 对应 `.venv-browser\Scripts\python.exe` 和 `pip.exe`。在 `.env` 设置 `BROWSER_PYTHON`、`BROWSER_PROFILE_DIR`、`BROWSER_EXECUTABLE_PATH`，指向专用、已登录测试账号的 Chromium/Chrome 环境，再将 `BROWSER_PROVIDER=browser_use`。该可选集成尚未安装运行或用真实账号联调；安装成功后应锁定实际依赖版本。

执行器使用 Browser Use 的 `ChatAnthropic`，读取截图驱动页面操作，因此使用 Claude API key，不需要另买 Browser Use Cloud。一次只处理一个获批对象和固定消息；发现已有对话、登录挑战或身份不明确时要求停止。页面执行后的模型报告仍标记 **send_unknown**，在工作台核实后才计入已发送转化，避免把模型自报成功当成可靠送达。

本地执行器不能撤回已经点击发送的消息；接管/退订会取消尚未发出的任务并尝试中断运行中的 browser job。

## 视频工具的实际边界

`get_post_context` 读取原始 post、metadata revision、视频片段与 raw data 来源；`inspect_video_segment` 使用制作 agent 提供的关键帧，通过 Claude image blocks 查看选定时间点。

这是**按需检查视频画面**：优先用已有关键帧，缺失时从 Drive 原视频抽帧，再调用 Claude 判断能否直接回答。详细 metadata 可为空；Library 的 Register original video 只需登记原视频来源。源视频最多 64 MB，解码需要安装 FFmpeg / FFprobe（可配置路径）；运行环境需要自行安装解码工具；按需视觉能力应使用自己的素材和凭证验证。若检查后仍不能确认，创建 topic 级真人问题，agent 继续处理其他咨询并可邀请 quick meeting。明确暂停视觉的 demo 模式或源文件不可读时，会如实记录未检查画面。原始视频和 raw footage 可在工作台打开 Drive 来源查看。准确材质、品牌、面积、许可证和价格要依据已核实资料；像素观察不能替代这些事实。

官方参考：[Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision)、[Browser Use 模型配置](https://docs.browser-use.com/open-source/supported-models)、[Browser Use 输出验证](https://docs.browser-use.com/open-source/customize/agent/output-format)。

## 验证与运行边界

```bash
npm test
npm run check
```

当前共有 119 个测试用例。测试覆盖获客全流程、动态字段、报价开关、去重、真人接管、退订、历史事件、预约幂等/未知结果、原事件改约及历史/任务同步、语义意图路由、Drive 重试、SQLite 迁移、私有附件、转化分母、原始 post 来源链、metadata 版本和关键帧调用，以及无关问题/注入拒答、判断失败兜底和拒答后的正常咨询恢复。前端有连接真实 HTTP handler 的运行/渲染 smoke test，覆盖页面和 demo 按钮流程；它不等同于浏览器视觉验收。

轻量安全层通过 Claude 的结构化语义判断识别私信和评论中的无关请求、角色伪装、提示词注入、密钥与其他客户数据索取，不使用关键词黑名单。拒答使用固定英文文案，不执行业务工具、不继续收集需求，也不因攻击通知真人；安全判断失败时同样拒答。后续正常咨询仍可继续，被拒输入不进入后续模型对话历史。人工接管、审核模式和真实退订仍按原流程处理。范围、规则和拒答文案在 `config/safety-policy.json` 中配置。素材及工具结果也被明确视为不可信数据；这是轻量防护，不能保证拦截所有注入。离线 mock 仅供业务流程演示，不提供语义安全识别；安全效果需使用 Claude provider 验证。

已完成浏览器流程验证，以及真实 Instagram 私信收发、Drive 同步和 Calendar 预约/改约联调。仓库不包含这些联调使用的账号、客户资料或凭证；新环境仍需按接入指南独立配置和验证。默认监听 `127.0.0.1`；非本地监听必须配置 `WORKSPACE_TOKEN`，界面会要求输入。该 token 是单工作区访问控制，并非多用户/多租户权限系统。

`/intake?contact=...` 是受工作区权限保护的表单预览。对客户使用 `/customer#...` 的独立、限时访问链接，支持 Yes/No 表单、日历预约和改约；正式使用需设置 `PUBLIC_CUSTOMER_ORIGIN` 和 HTTPS 代理。当前报价工具还需要真实费率及 reviewed quote inputs 才能输出业务报价。预约先建立公司日历事件；没有客户邮箱时不发送客户邮件邀请，也不自动生成视频会议链接。

默认启动使用模拟服务，不会向真实客户发送消息。真实连接与公网入口需部署者自行配置。比赛背景：[团队页](https://hack.claudeseattle.org/teams/8fef15b8-bd24-490a-b513-f27fa7e75906)。

人工回复通过同一 Instagram 文本发送适配器原文发送，不让 LLM 改写。可以处理一个待确认问题或补充单条消息，均不自动停止 agent；Take over 才取得整段对话控制权。当前 UI 汇总已接入的数据和配置的公司知识，没有实现自动抓取所有公司网站。

Instagram comments now enter the Comments & acquisition workspace through the signed webhook. Public replies and one private invitation are tracked separately, follow the contact’s auto/review mode, and sync to Drive. See [comment workflow](docs/account-setup.md#instagram-comments) for limits and test coverage.

客户可选择约一分钟的短表或继续聊天；表单复用现有资料，提交不延长 Instagram 私信窗口。主动邀约先检查六项基本需求是否已回应；客户主动要求预约可直接打开日历。详见 [客户页面与日历配置](docs/account-setup.md#optional-intake-and-booking-calendar)。


## Dashboard notifications

Team request cards have a **Close notifications** button. Dismissal is remembered for the current browser tab, including refreshes. The same request does not reappear on the next poll; new requests still notify the team. Closing a card does not resolve or remove the underlying handoff.
