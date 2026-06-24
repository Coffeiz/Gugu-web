# Agent 架构方案

> 想看**一轮对话内部走哪些步、每步谁负责、哪些做了哪些没做**，见 [`agent-决策环.md`](agent-决策环.md)（运行时决策环专题）。本文是架构总览 + 完整工具清单 + Roadmap。

## 定位

咕咕不是助理，是伙伴。

助理等待指令、完成任务、不留印象。伙伴记得你说过的事，注意到你的状态，在你需要之前就知道你需要什么。这个区别决定了整个 Agent 的设计方向：记忆不是功能，是核心；主动性不是增强，是基本要求。

技术上，重构现有 `app/api/v1/agent.py` 的单文件实现，支持：
- 用户记忆系统（咕咕自主观察、积累、提炼对用户的认知）
- 多平台接入（Web SSE、QQ Bot、OpenClaw 等即时通讯）
- MCP（Model Context Protocol）
- Skills 插件化
- Prompt 文件化管理
- 路由 / Profile 机制
- 事件总线

---

## 目录结构

```
backend/
├── app/                        # FastAPI 应用层
│   └── api/v1/agent.py         # 薄层：接收请求 → 调 agent.router → 返回响应
└── agent/                      # 独立 agent 包，不依赖 FastAPI
    ├── core.py
    ├── llm_select.py           # 模型解析层 pick_model（active/pool/router）
    ├── router.py
    ├── models.py
    ├── context/
    │   ├── builder.py
    │   └── loaders.py
    ├── memory/
    │   ├── manager.py
    │   ├── reflection.py
    │   ├── compressor.py
    │   └── storage.py
    ├── skills/
    │   ├── base.py
    │   ├── projects.py
    │   ├── calendar.py
    │   └── files.py
    ├── profiles/
    │   ├── base.py
    │   └── default.py
    ├── mcp/
    │   ├── client.py
    │   └── registry.py
    ├── adapters/
    │   ├── base.py
    │   ├── web.py
    │   └── qqbot.py
    ├── events/
    │   ├── bus.py
    │   └── types.py
    └── prompts/
        ├── persona.md      # 咕咕是谁（角色），全局共享、最先注入
        ├── skills.md       # 执行规则（工具使用准则 + 真实性铁律 + confirm），全局共享
        ├── policy.md       # 内容红线 + 对外口径「以伙伴示人」，全局共享
        ├── default.md      # 数据模板（时刻 + projects/calendar/files 占位符）
        ├── reflection.md   # 记忆反思提炼词（对话后用）
        └── compress.md     # 记忆压缩提炼词
```

---

## 模块说明

### `core.py`
LLM 主循环。负责：
- 调用 LLM（Anthropic / OpenAI 双路统一）；用哪个模型由 `llm_select.pick_model` 决定（见下），不直接读 `settings.ai`
- 工具调用执行与结果回填（`MAX_ROUNDS = 6`：配合 skills.md 执行准则 + 强工具，多步任务 2~3 轮够用，逼出低成本执行；超限给友好提示「前面已生效，要接着做吗」）
- SSE streaming 输出；`_stream_round` 包一层瞬时错误退避重试（⑦：429/超时/网络/5xx 在出 token 前重试，已吐 token 不重试防重复）
- 对话结束后 emit 事件，触发 Reflection
- 不感知平台来源、不感知 prompt 如何构建

### `llm_select.py`（模型解析层）
统一的「选哪个模型」决策点——`runner`/`core` 只对接 `pick_model(settings, ctx)`，未来 Router、多 key 分流都插这里，core 不动。按 `ai_presets.strategy` 分支：
- **`active`**（默认）：用激活预设（= `settings.ai`，行为不变）。
- **`pool`** 多 key 分流：勾了 `in_pool` 的预设里按 `pool_mode` 挑——`random` 随机 / `round_robin` 轮询 / `least_loaded` 最少在途（`release()` 跟踪每 key 在途，请求结束 `runner` 在 finally 里减；不等速 key 下最优）。每 key 一份限流额度，总并发 ≈ key 数 × 16。
- **`router`** 智能路由：调 `set_router(fn)` 注册的 picker，没注册退回 active —— **未来 Router 的插槽**。
- 无预设 → 退回 `settings.ai` 兜底。
> 后台 Agent→LLM 预设 顶部「策略 / 分流 / 并发」可调；web 写即热，worker 每 30s 热读。详见 [`并发优化ROADMAP.md`](并发优化ROADMAP.md)「模型解析层」。

### `outbound.py`（IM 出口兜底）
咕咕 IM 回复**发给用户 / 持久化之前**的确定性清洗（`run_collect` 里调用，prompt 之外的代码层保险）：
- 小泄露（`call_xxx` tool id、`trace_id`/`request_id` 等内部 id）→ 抹掉
- 大泄露（系统提示词被复述出来，多为 prompt injection 得手）→ 整条换成安全话术
- 只管**字面**泄露，确定性兜住"长上下文污染/被套话吐 id"；**语义**泄露（换说法）仍靠 policy.md 提示词。仅 IM 路（非流式好扫），网页流式另说。

### `router.py`（轻量 Intent Router · Phase 1.7）
**网关入队前**的轻量路由层（关键词 + 状态机），决定一条消息要不要进主模型：
- `classify(text)` → `progress / cancel / emotion / ack / agent` 五类（纯关键词，整条匹配；取消/情绪只在短消息上判，**宁漏判进主模型、不误判短路**）
- `decide(text, state)` 结合当前 State Manager 状态出动作：`reply`（短路回话术，不入队）/ `cancel`（置取消标志 + 回话术）/ `drop`（忙时的「嗯/好」忽略不打断）/ `agent`（正常入队）
- 据状态回不同话术：THINKING→「还在想哦~」SEARCHING→「正在查资料~」GENERATING→「马上就好~」
- 将来可换小模型分类（输出 `{intent, confidence}`），`decide()` 接口不变
> 早期设想的「按来源选 Profile」路由从未实现（现单 Profile 直连）；`router.py` 现指 Runtime Intent Router。

### `runtime_state.py`（State Manager · Phase 1.7）
IM 运行时状态机 + 取消标志，**跨进程共享走 Redis**（worker 写、网关读）。
- 状态 `IDLE / THINKING / SEARCHING / GENERATING / WAITING_CONFIRM`，key `agentstate:{platform}:{puid}`，**带 TTL 300s**（worker 崩了自动过期回 IDLE 防卡死）
- worker `handle` 进入即 THINKING、结束清除；core 工具循环据 `TOOL_STATE`（web_search→SEARCHING、create_document→GENERATING）打细粒度
- 取消标志 `agentcancel:{platform}:{puid}`：网关检测到取消意图时置，core 每轮协作检查、命中即中断
- **为什么状态要放 Redis 给网关读**：IM 是**单 worker 顺序消费队列**——任务进行中后续消息排在队列里、worker 在忙根本看不到，所以「还在吗 / 算了」必须由网关据此状态短路，进不了 worker

### `models.py`
统一数据结构。定义 `AgentRequest` / `AgentResponse`，各 adapter 负责将平台格式转换为此结构。

```python
class AgentRequest:
    message: str
    user_id: UUID
    session_id: Optional[int]
    source: str  # "web" | "qqbot" | "openclaw"
```

---

### `context/`

#### `loaders.py`
文件读取层。负责：
- 从用户 `.agent/` 目录读取 prefs、facts（从 facts.json 导出）、memory
- 判断 daily / weekly / monthly 文件有效期，过滤过期文件
- 返回结构化内容块，不负责拼接

#### `builder.py`
Context 组装层。负责：
- 调用 loaders 获取各层记忆内容
- 加载对应 Profile 的 prompt 模板
- 按注入顺序拼装最终发送给 LLM 的 context
- 控制总长度，避免超出 token 限制

```python
system_prompt = await builder.build(user_id, profile="default")
```

注入顺序（提示词分层，各司其职、后台可分别编辑）：
```
persona.md   咕咕是谁（角色：四状态/主动/记忆温度/风格）
    ↓
skills.md    怎么做（执行规则：任务分级、成本意识、真实性铁律、不可逆 confirm）
    ↓
policy.md    不碰什么（内容红线 + 专业免责 + 对外口径「以伙伴示人」）
    ↓
记忆块       facts → memory → daily（仅非空时注入，省 token）
    ↓
default.md   纯数据模板：现在时刻（含星期/时分）+ projects / calendar / files（实时灌入占位符）
```

- **稳定的在前、易变的在后**：人格/规则/红线稳定 → 记忆 → 实时数据。`default.md` 的 `{now}` 注入完整时刻（`datetime.now()`，含星期与时分），让咕咕知道"现在几点、星期几"。
- **persona / skills / policy 独立于 profile，所有 profile 共享**；后台 Admin「Agent」面板里这三个 + reflection/compress 都可单独编辑（profile 现仅 `default`，早期 qqbot/mini 是从未接线的占位、已移除）。
- 工具用法（如 create_document 用哪种 content、read_file 能读 PDF）写在**各工具的 description** 里（模型调工具时看），不重复进系统提示词。

---

### `memory/`

Session 和 Memory 严格分离：
- **Session**：最近聊天记录（最近 N 条消息），短期工作记忆
- **Memory**：长期认知，经过 Reflection 提炼后写入，不直接从 session 构建

```
Conversation → Reflection → MemoryManager → Storage
```

#### `reflection.py`
对话 → 结构化记忆条目的转化层。负责：
- 对话结束或消息数达阈值时，调用 LLM 判断本次对话是否有值得记住的内容
- 输出结构化条目，包含类型、内容、importance

```python
[
  { "type": "fact", "key": "current_project", "value": "咕咕", "confidence": 0.9 },
  { "type": "memory", "content": "用户偏好简洁回复", "importance": 4 },
  { "type": "daily", "content": "用户提到下周要买车", "importance": 2 }
]
```

Reflection 输出条目类型：
- `fact`：客观事实，更新 facts.json（用户在做什么项目、用什么技术栈）
- `preference`：观察到的偏好，累积进 prefs.md（喜欢简洁回复、不喜欢被追问）
- `state`：当前状态，进入 daily（今天压力大、在赶截止日）
- `memory`：值得长期记住的事，进入 daily 并标记升级候选

Importance 1~5 分级：
- 1~2：临时信息（今天吃拉面），压缩时直接丢弃
- 3：普通信息，进入 weekly 时保留
- 4：重要信息，优先进入 monthly
- 5：核心信息，考虑升级进 memory.md

#### `compressor.py`
时间层压缩，职责单一（**已简化为两段 daily → memory，不设 weekly / monthly 层**）：
- `compress_daily()`：将过期 daily（>14天）LLM 摘要后**直接提炼进 `memory.md`**（长期），丢弃 importance≤2 的条目

> **决策**：不要 weekly 中间层——咕咕只需"近期(daily) / 长期(memory)"两档，weekly 是多余复杂度。长期信息一律入 `memory.md`。

#### `manager.py`
记忆管理对外接口。负责：
- 协调 Reflection、Compressor、Storage 的调用顺序
- 对外暴露统一的 `save()`、`load()` 接口
- 每次 agent 被调用时顺带触发压缩检查

#### `storage.py`
读写层，负责实际 I/O：
- 读写 `facts.json`（结构化事实，key-value + confidence + source）
- 读写 `daily/` / `weekly/` / `memory.md` / `preferences.md`
- 读写 `summary.md`（当前状态快照）
- 导出 `facts.json` 为自然语言文本供 prompt 注入
- 未来可替换为数据库，manager 不感知底层存储方式

---

### `skills/`

#### `base.py`
Skill 基类，定义 tools 列表声明和统一执行入口，core 通过此接口调用。

`registry.dispatch` 两条关键约定：
- 返回 `(给LLM的文本, UI artifact|None)`——结果含 `_artifact` 键就抽出来（见下「发送文件」）。
- **工具异常被兜住**：handler 抛错时不让它冲垮整轮对话，`try/except` 后把 `{"error":"工具 X 执行出错：…"}` 当结果返给 LLM（并打印堆栈到日志便于排查）。LLM 据此按 persona「铁律」如实告知没做成、不假装成功（persona.md：工具返回 error → 绝不能说"完成"）。

#### `projects.py` / `calendar.py` / `files.py`
各功能领域工具实现，自注册到 skill registry，Profile 按需组合。

#### `conversations.py`（读历史对话）
让咕咕能搜 / 读用户**过去的对话**（其他 session）——当前 session 的历史已在上下文里，这里解决"翻看以前那次聊的"。
- `search_conversations(keyword?)`：按关键词搜消息正文 + 标题，按 session 聚合返回匹配片段；不传关键词列最近对话。
- `read_conversation(session_id)`：读某条对话的完整消息。
- **严格多用户隔离**：只查 `ConversationSession.user_id == 当前用户`，读他人 session 返回"不属于你"。与记忆系统互补：记忆是提炼结论，这里是原始对话原文。

#### 发送文件给用户（UI artifact 旁路）

咕咕能在对话窗口给用户发可下载的文件卡片。工具 `send_file`（files skill，按 file 名/file_id 定位用户文件）。

机制是一条「工具 → 前端 UI」的旁路（普通工具结果只回给 LLM）：
```
send_file 返回 {ok, message, _artifact:{file_id,name,ext,size_bytes}}
  → registry.dispatch 抽出 _artifact，返回 (给LLM的文本, artifact)
  → core 在 tool_done 后多推一个事件 {type:'file', file:{...}}
  → web.py 透传给前端（前端渲染下载卡片，走 filesApi.download 带鉴权 blob 下载）
       同时累积进 sent_files，随助手消息持久化到 conversation_messages.files(JSON 列)
  → 重开对话时 /sessions/{id}/messages 带出 files → 卡片重新渲染
```
- 任何工具想给前端推 UI 元素，都可走这条路（结果带 `_artifact`）。
- **IM（飞书 / QQ）也真发文件**：`runner._collect` 收集 `file` 事件 → `AgentResponse.files` → `worker._send_files` 按平台分发。
  - **飞书**：`feishu.send_file` 上传（`im.v1.image/file.create` 拿 key）→ 发 image/file。⚠️ 图片 10MB / 文件 30MB，超限飞书返回非 JSON 错误页会把 SDK 撞成 `JSONDecodeError` → 发前查大小、超限改发文字说明。
  - **QQ**：`qq.send_file` → `/v2/users/{openid}/files` 富媒体上传（图片 file_type=1、文件=4；**C2C 私聊支持发文件、群聊不支持**）→ 拿 file_info → `post_c2c_message msg_type=7 media`。
    - **本地存储**：base64 `file_data` 上传，请求体膨胀 33%，实测 **~10MB 为界**（超了报 `call inner proxy error`），`_send_file_qq` 超限改发文字提示。
    - **OSS**：`storage.fetch_url(key)` 返回签名 URL（`bucket.sign_url`，1h），`qq.send_file(url=...)` 走 **url 模式**让 QQ 自己抓 → **无体积限制**，自动切换无需改代码。
    - `msg_seq` 用 **Redis `INCR qqseq:{msg_id}`** 跨进程发号（QQ 按 `(msg_id, msg_seq)` 去重；网关 ack 和 worker 回复是两个进程，各自计数会撞）；上传抖动重试 4 次。
    - QQ 文件没配文字时 worker 补一句短文本——QQ「思考中」占位只认文本/markdown 被动回复，媒体消息不消解它。
  - **QQ 收文件瞬发 ack**：网关 `on_c2c_message_create` 见 `message.attachments` 就先发「文件收到啦，让我看看~」（下载/入队之前），即时反馈 + 顺带消解「思考态」。
- ⚠️ 持久化依赖 `conversation_messages.files` 列（迁移 `20260623000001`）——**部署后必须 `make migrate`**，否则发文件存盘报错。

#### 接收文件（用户发文件给咕咕 · 暂存旁路）

用户能在 **web 上传 / 飞书 / QQ 发文件**给咕咕，咕咕能**看内容**（文本类 + PDF/Office）+ **存进文件库**。

机制是「先暂存、要存才落库」（`app/core/chat_attach.py`）：
```
上传字节 → StorageBackend(.chat_staging/ key) + 元数据 → Redis(TTL 6h)，拿 attach_id
  ├─ web：输入框附件按钮 → POST /agent/upload（暂存）→ 发送带 attachments=[aid]
  ├─ 飞书：网关收 file/image → im.v1.message_resource.get 下载 → stage_sync 暂存（同步，handler 在运行 loop 里）
  └─ QQ：on_c2c_message_create 取 message.attachments（url/filename）→ 异步下载 → chat_attach.stage（handler 本身 async）
  → run_collect / web.py 调 chat_attach.resolve_for_message(user_id, attach_ids, message)
       → ① 增广文本（文本/PDF/Office 用 doctext 提取正文注入 LLM）② 前端文件卡片 ③ 图片块（vision 模型真看，见「多模态看图」）
  → 用户说"存一下" → 工具 save_uploaded_file(attach_id) 把暂存字节落成正式文件库记录
```
- **kind**：text（md/代码…）、**doctext.EXTRACTABLE（PDF/Word/Excel/PPT，自动提取文本，也按可读处理）**、image（vision 模型直接看，见下）、binary（其余，可存读不了）。
- ⚠️ `stage_sync`（飞书网关用）必须在独立线程跑 `asyncio.run`——lark handler 在运行中的 loop 里，当前线程 `run_until_complete` 会 `RuntimeError`；QQ handler 本身 async，直接用 `chat_attach.stage`。

#### 多模态看图（vision · `chat_attach` + `read_file`）

vision 模型（`ai.vision=True`，后台「检测」探测或手动开）下，咕咕能**真看图**——聊天发的图、以及文件库里的图都行：

- **聊天图**：`resolve_for_message` 把图封成图片块随用户消息发给模型（Anthropic 路 `image` 块 / OpenAI 路 `image_url`）。
- **大图自动压缩**（`_fit_image_for_vision`）：>5MB 或长边 >2048px 时，喂模型前等比降采样 + 逐级降质重压成 JPEG（**只压喂模型的副本，存库原图不动**）。修「发高清插画看不出图」——此前 >5MB 直接降级成文字提示。
- **HEIC/HEIF**：接入 `pillow-heif`，iPhone 原图等非原生格式（heic/bmp/tiff）统一转码 JPEG 再喂；原生 png/jpg/gif/webp 达标则原样发。
- **`read_file` 读文件库的图**（仅 vision **且 Anthropic 通道**）：图片走 `tool_result` 的图片内容块让模型看（`dispatch` 识别 `_vision_image` → 封块；OpenAI 路工具结果只能纯文本，故友好提示看不了）。持久化时 `strip_vision_for_history` 把图片块换成 `[图片已查看]` 占位——避免大 base64 撑爆历史 / 每轮重发。

#### 飞书消息「秒回表情」

飞书每来一条消息，网关 `_on_message` **赶在入队/LLM 之前**给用户那条加一个表情回应——慢生成时先给即时反馈：
```
收到消息 → _quick_react(text) 关键词本地判一个 emoji（零网络）
        → _do_react(api_client, message_id, emoji)  # im.v1.message_reaction.create
        → 再 produce 入队（完整回复随后 worker 发）
```
- `_QUICK_RULES`（feishu.py）：笑→😂 / 谢→🙏 / 搞定→✅ / 问候·中性→👀 OnIt / 问问题→🤔；默认 OnIt（不用 THUMBSUP，躲「满屏👍」）。飞书 emoji_type 大小写敏感（THUMBSUP/LAUGH/DONE 全大写，OnIt/Typing 驼峰）。
- ⚠️ 需飞书 app 开 `im:message_reaction`（写）权限，否则日志 `reaction 失败`、不影响主流程。
- **另有 LLM 版 `react` 工具**（`skills/im.py`，IM 上下文经 `agent/imctx.py` contextvar 透传）能让咕咕按内容精挑——但**默认未进 profile**（要等 LLM 跑完、且会和秒回叠两个表情）。等接入快/小模型再启用。
- 设计取舍：「每条都点」必退化成单调表情（多数消息中性），真秒回又必须在 LLM 之前 → 取本地关键词（即时但糙）。

#### 实时刷新（Redis pub/sub → SSE）

咕咕在 **web 聊天或 IM（飞书/QQ）** 里改了数据（项目/日历/文件/客户）、或 IM 来了新消息，网页都**自动刷新**，无需手动刷新页面。实现见 `app/core/events.py` + `app/api/v1/live.py` + 前端 `stores/live.js`。

挂点是 `registry.dispatch`——所有工具执行的**唯一咽喉**，web 与 IM worker 共用：
```
工具成功(改动型) → events.publish(user_id, 资源)           # dispatch 里，按 RESOURCE_BY_TOOL 映射
IM 用户消息存下后 → events.publish('sessions',session_id,appended=[用户消息])   # 先推（生成前）
IM 回复生成完   → events.publish('sessions',session_id,appended=[助手消息])   # 再推（runner.run_collect）
  → Redis PUBLISH events:{user_id}                         # 按用户隔离频道，无跨用户扇出
  → GET /api/v1/live/stream(SSE) 订阅该频道，逐条下发        # 鉴权走 fetch streaming 带 Authorization 头
  → 前端 live store：bump rev[资源] → 各 store/视图 watch 自己的 rev 重新拉取
       带 session_id 的事件 → GuguChat 判断是否当前会话，是则把 appended 直接追加进气泡（消息级，不整列表 refetch）
```
- **粗粒度**（数据资源）：`rev.projects/calendar/files` 递增 → `projects`/`filesCache` store、Calendar 视图重新拉取。
- **细粒度**（会话消息）：IM 消息带 `session_id + appended`，**分两次推**——用户消息一存下就先推（网页先看到「发了什么」），回复生成完再推（再看到回答），呈现正常聊天节奏而非一轮结束整体蹦出。正打开该会话就**追加气泡**，否则只刷会话列表。⚠️ 推送的 `events` 模块要 `as _evmod` 别名导入，否则覆盖 `run_collect` 里同名的日历事件局部变量。
- **多轮去重**：`_collect` 按轮分段、去重拼接——MiniMax 多轮常把上一轮开场白整段重述，无脑拼接会叠 N 遍（QQ 还把 `~` 渲染成删除线）。某轮若以上一轮全文为前缀则替换不叠加；配 prompt「调工具后别重述、开场白只说一次」。
- **IM 会话标题（后台）**：`run_collect` 检测到新会话 → `_schedule_title` **后台 fire-and-forget** 起 ≤10 字标题、更新 DB、再异步推 `title` 事件。会话创建时已有首句截断做临时标题，所以不阻塞回复（此前同步等标题 → 闲置后两次冷调用叠加慢一倍）。
- 流量：按收件人定向 + 发增量（不广播、不全量），空闲只有 ~20s 一次 keepalive。
- 断线（后端重启/网络抖动）：前端指数退避自动重连。
- ⚠️ **新增改动型工具记得登记到 `RESOURCE_BY_TOOL`**，否则该工具改完网页不会实时刷新。
- 当前 web 自身聊天走 `web.py` 流式（自带 `refreshAfterTools` 刷新），未 publish → **同账号多网页标签不互相同步**；将来做站内 IM 时让 web 也 publish 即可（链路现成）。

---

### `profiles/`

#### `base.py`
Profile 基类，定义技能集、prompt 模板路径、能力开关：

```python
class BaseProfile:
    skills: list[BaseSkill] = []
    prompt_file: str = "default.md"
    memory_enabled: bool = True
    mcp_enabled: bool = False
```

#### `default.py`
唯一会话 Profile（web / 飞书 / QQ 共用）。`skills = [projects, calendar, files, clients, trash, overview, memory, search, conversations]`，`memory_enabled=True`，prompt_file=`default.md`。

> `im` skill（LLM 版 `react` 表情工具）已注册但**未进 default profile**（秒回表情走网关关键词，见 `project-im-reaction` 记忆）。早期设想的 qqbot/mini 专用 profile 从未接线，已弃。

---

### `mcp/`

#### `client.py`
MCP 协议客户端，支持 stdio / SSE / HTTP 连接外部 MCP server。

#### `registry.py`
动态加载 MCP server 的 tools，注册为 skill，core 视其与 native skills 完全相同。

---

### `adapters/`

#### `base.py`
Adapter 接口：`receive()` 将平台消息转为 `AgentRequest`，`send()` 将响应转为平台格式。

#### `web.py`
Web SSE adapter：`stream()` 同步做配额检查 → 上下文 → 会话 get/create → 存用户消息，再把生成丢到**后台任务** `_generate()`（脱离 HTTP 请求），自身只转发会话的生成频道。`_generate()` 跑 core 流式 → 发事件到 `genstream` → 自己持久化（含 `file` artifact 落 `conversation_messages.files`）。

**生成解耦 + 刷新续看**（`agent/genstream.py`）：生成在后台任务里跑，**浏览器刷新/断连杀不掉它、回复不丢**。`genstream` 是按会话的生成流频道（Redis pub/sub）+ 状态快照（已生成文字/当前工具/done）。刷新后前端经 `GET /agent/sessions/{id}/stream`（`web.resume()`）先补已生成内容、再订阅后续；`/sessions/{id}/messages` 带 `active` 标志告诉前端要不要续看。前端 `consumeStream` 被 `send` 和续看共用。

**错误文案分类**（都在 `web.py` 的 `except` + 前端兜底）：
- 精力/配额：「咕咕精力不足，休息一下～」「咕咕本周精力耗尽啦，每周一恢复～」
- 网络（`_is_network_error`：连接/超时类异常，或前端 fetch 失败）：「咕咕网络不太好 📡 可以再发一遍吗？」
- 其他/未知（DB 错、代码 bug 等）：「咕咕开小差了 😵‍💫 麻烦再说一遍好吗？」
- 工具异常**不在此处**——已在 `dispatch` 兜住返给 LLM（见 skills/base.py），不冲垮整轮。

**网页生成中排队**（`GuguChat.send(forcedText)` + `pendingQueue`）：流式中再发消息不丢——立即显示用户气泡 + 入队，流式结束在 `finally` 取队首接力发，逐条处理；点停止键清空队列。IM（飞书/QQ）天生排队（Redis 队列 + 单 worker 顺序消费）。

#### `qq.py` / `feishu.py`
QQ / 飞书 BYO 网关（botpy / lark-oapi WebSocket 长连），见 Phase 4 与 `agent-im接入架构.md`。

---

### `events/`

全局基础设施，agent 内部所有跨模块通信通过 EventBus 解耦。

#### `types.py`
所有事件类型定义，使用类而非字符串，避免打错字、支持 IDE 跳转：

```python
class Event:
    pass

class ProjectCreated(Event):
    project_id: int

class MemorySaved(Event):
    user_id: UUID
    importance: int

class DailyCompressed(Event):
    user_id: UUID
    date: str

class SessionEnded(Event):
    session_id: int
    user_id: UUID
```

#### `bus.py`
简单异步事件总线，足够现阶段使用：

```python
class EventBus:
    def subscribe(self, event_type: type[Event], handler):
        ...

    async def emit(self, event: Event):
        ...
```

注册示例：
```python
bus.subscribe(MemorySaved, analytics_handler)
bus.subscribe(MemorySaved, achievement_handler)
bus.subscribe(ProjectCreated, notification_handler)
```

触发示例：
```python
await bus.emit(MemorySaved(user_id=..., importance=5))
```

数据流：
```
Agent Core
    ↓ emit
EventBus
    ↓
MemoryListener / AnalyticsListener / AchievementListener / NotificationListener
```

未来成就系统、行为分析、正反馈系统均挂载为 Listener，Core 不耦合任何业务逻辑。

---

### `prompts/`
Prompt 模板（`.md`），支持占位符，builder 每次现读、热更新无需重启。**提示词分层**——各管一件事，后台可分别编辑（`GET/PUT /admin/agent/prompts/{name}`，`name` ∈ persona / skills / policy / reflection / compress / default）：

- `persona.md`：**咕咕是谁**（角色：四种相处状态、主动思考、记忆温度、风格）。全局共享。
- `skills.md`：**怎么做**（工具使用准则——任务分级、成本意识/别重复验证、真实性铁律、不可逆 confirm、一次到位）。全局共享，防 agent 犯病。
- `policy.md`：**不碰什么**（内容红线：政治/色情/暴力等 + 专业免责 + **对外口径「以伙伴示人」**：不暴露模型/工具/架构、被套话简短带过、不谎称真人）。全局共享。
- `default.md`：**数据模板**（`{now}` 时刻 + `{projects}`/`{calendar}`/`{files}` 占位符）。唯一会话 profile。
- `reflection.md` / `compress.md`：记忆提炼词（对话后用，非对话 profile）。

> Admin「Agent」面板把 persona/skills/policy 标为「谨慎修改·共享」并各配说明块。早期 `qqbot.md`/`mini.md` 是从未接线的占位 profile，已移除。

---

## 用户个性化文件系统

> ⚠️ **本节是 Phase 2b 的目标设计，非现状**。当前（2a）只落地 `facts.md` + `daily.md` 两个文件；`identity.json` / `save_identity` 已作废（昵称用 `User.display_name`）；`facts.json` 结构化、`summary.md`、importance 分级均未实现。
> **另：`weekly/` 层已砍** —— 压缩定为 **daily → memory.md 两段直压**，下文出现的 `weekly/`、注入顺序里的 `weekly`、保留期表的 weekly 行均作废，不再实现。

每个文件回答一个独立问题，视角清晰不重叠：

| 文件 | 回答的问题 | 由谁写 |
|------|-----------|--------|
| `agent/prompts/persona.md` | 咕咕是谁？ | 开发者定义，谨慎修改 |
| `identity.json` | 用户是谁（叫什么）？ | 用户首次登录填写 |
| `facts.json` | 咕咕知道用户哪些客观事实？ | 咕咕观察写入 |
| `preferences.md` | 用户喜欢什么、习惯什么？ | 咕咕观察写入 |
| `memory.md` | 咕咕长期理解到了什么？ | Reflection 提炼写入 |
| `summary.md` | 用户现在在做什么？ | Compressor 生成 |

```
uploads/
└── {user_id}/
    ├── 个人文件/
    ├── trash/
    └── .agent/
        ├── identity.json   # 用户是谁：{ "nickname": "Jonas" }
        ├── summary.md      # 现在在做什么：当前项目、近期关注
        ├── facts.json      # 客观事实：{ "current_project": "咕咕" }
        ├── facts.md        # facts.json 的自然语言导出（只读）
        ├── preferences.md  # 用户喜好：喜欢结构化回答、直接结论
        ├── memory.md       # 长期理解：用户倾向从长期维护角度思考问题
        ├── daily/
        │   └── 2026-06-22.md
        └── weekly/
            └── 2026-W25.md
```

### summary.md

Agent 启动时优先读取的当前状态快照，格式为轻量自然语言，由 Reflection / Compressor 在适当时机更新。目的是让咕咕在每次对话开始时不需要遍历所有记忆文件，就能立刻知道用户是谁、在做什么、最近关注什么。

```markdown
用户昵称：Jonas

当前主要项目：咕咕 App

最近关注：
- Agent 架构重构
- 项目看板优化
- 文件系统缩略图

当前阶段：MVP 开发中
```

与其他文件的区别：
- `memory.md`：提炼自过去，记录「咕咕对这个人长期的认知」
- `facts.json`：结构化的客观事实，可精确查询和更新
- `summary.md`：描述「此刻」，是对当前状态的一句话快照，随时间滚动更新

更新时机：每次 Reflection 产生 importance ≥ 4 的条目时触发重新生成，由 MemoryManager 协调调用。不绑定 weekly 压缩 —— 用户切换主项目、进入新阶段等重要变化当天即反映，不等到下周。

---

### 信息来源的严格区分

用户主动提供的信息只有一处：**第一次对话时咕咕询问的昵称**，由咕咕通过 `save_identity` 工具写入 `identity.json`。不设 Onboarding 页面，不让用户填表。

其余所有信息 —— 习惯、偏好、状态、工作模式 —— 全部由咕咕通过对话观察积累，不向用户提问，不让用户填表。这是伙伴和助理的核心区别。

```json
// identity.json —— 唯一的用户输入
{ "nickname": "Jonas" }
```

### facts 更新策略

facts 不由 LLM 直接写文本，而是维护结构化 JSON，由 Reflection 通过工具调用写入：

```json
{
  "current_project":   { "value": "咕咕 App", "confidence": 0.9,  "source": "observed" },
  "tech_stack_backend": { "value": "FastAPI",  "confidence": 0.95, "source": "observed" },
  "deadline_pressure":  { "value": "高",       "confidence": 0.7,  "source": "inferred" }
}
```

- `source: observed`：用户明确说过的（「我在做咕咕」）
- `source: inferred`：咕咕从行为推断的（深夜高频操作 → 截止压力大）
- 发现新事实 → 新增 key
- 已有事实变化 → 更新 value + confidence，不追加，避免脏数据
- 导出为自然语言注入 prompt，由 storage.py 负责转换

### prefs.md

记录咕咕对用户沟通偏好的理解，由 Reflection 写入，格式为自然语言段落，不是配置项。

```
用户倾向简短直接的回复，不喜欢被引导式提问。
讨论技术细节时愿意深入，但非技术话题更偏好快速结论。
晚上工作时回复会更简单，通常处于专注状态不想被打断。
```

这不是用户的自我描述，是咕咕通过长期观察形成的判断，会随时间修正。

### 记忆文件保留期

| 文件 | 保留期 |
|------|--------|
| `identity.json` | 永久 |
| `summary.md` | 永久（importance ≥ 4 时滚动更新）|
| `facts.json` | 永久 |
| `preferences.md` | 永久 |
| `memory.md` | 永久 |
| `daily/` | 14 天，过期压缩进 weekly |
| `weekly/` | 6 周，过期提炼进 memory.md |

---

## 工具清单（共 47，已实现）

> 🔒 = 不可逆操作，受删除二次确认保底（显式 confirm 参数）保护。所有工具带 `user_id` 所有权校验。

### 项目 · `skills/projects.py`（16）
| 工具 | 说明 |
|------|------|
| `list_projects` | 项目列表，可按状态筛选 |
| `create_project` | 新建项目，**可带 `stages` 一次建阶段+待办**（`["需求","开发"]` 或 `[{label,todos}]`） |
| `update_project` | 改状态/起止日期/客户/备注/名称 |
| `get_project` | 单项目完整结构（阶段 key/label + 各阶段待办 id/text/done） |
| `set_stages` | **声明式整体替换阶段**（增/删/改名/重排一步到位，同名阶段待办自动保留） |
| `update_stage` | 切换当前阶段 / 勾选已有待办 |
| `add_stage` | 新增阶段（追加或指定位置） |
| `remove_stage` | 删除阶段 |
| `rename_stage` | 重命名阶段 |
| `add_todo` | 给阶段加待办（支持批量 texts） |
| `update_todo` | **改待办文本/完成态 + 可选移到别的阶段（`to_stage`）** |
| `remove_todo` | 删除待办 |
| `set_priority` | 设优先级 high/medium/low |
| `set_color` | 设项目颜色（十六进制） |
| `archive_project` | 归档 / 取消归档 |
| `delete_project` 🔒 | 永久删除项目 |

### 日历 · `skills/calendar.py`（4）
| 工具 | 说明 |
|------|------|
| `create_event` | 新建事件 / 截止提醒 |
| `list_events` | 查询事件（日期范围 / 类型） |
| `update_event` | 改标题/日期/类型/关联项目/描述 |
| `delete_event` 🔒 | 删除事件（无回收站，不可逆） |

### 文件 · `skills/files.py`（14）
| 工具 | 说明 |
|------|------|
| `list_files` | 查询文件（空间/项目/扩展名/关键词） |
| `read_file` | 读文件内容：文本类（≤256KB）直读 / PDF·Word·Excel·PPT 提取文本 / **图片直接识别**（需 vision + Anthropic 通道，含 HEIC，大图自动压缩） |
| `edit_file` | 改文本（整体替换/追加/查找替换） |
| `create_document` | 生成文件：md/txt/json/csv 直写；docx/pdf 由 HTML、xlsx 由 CSV 经 LibreOffice 转 |
| `rename_file` | 重命名文件 |
| `move_file` | 移动文件（空间/项目/文件夹/阶段） |
| `copy_file` | 复制文件到目标位置 |
| `delete_file` | 删除文件（进回收站，可还原） |
| `create_folder` | 新建文件夹（支持嵌套） |
| `list_folders` | 查询文件夹（按项目/父级） |
| `rename_folder` | 重命名文件夹 |
| `delete_folder` | 删除文件夹（夹内文件移至根，不删） |
| `send_file` | 给用户发可下载文件（web 文件卡片 / 飞书文件，见「发送文件」） |
| `save_uploaded_file` | 把用户暂存的上传附件存进文件库（见「接收文件」） |

### 客户 · `skills/clients.py`（4）
| 工具 | 说明 |
|------|------|
| `list_clients` | 客户列表 |
| `create_client` | 新建客户 |
| `update_client` | 改客户信息 |
| `delete_client` 🔒 | 删除客户 |

### 回收站 · `skills/trash.py`（3）
| 工具 | 说明 |
|------|------|
| `list_trash` | 查看回收站 |
| `restore_file` | 还原文件到原位置 |
| `permanent_delete` 🔒 | 永久删除回收站文件 |

### 聚合 · `skills/overview.py`（2）
| 工具 | 说明 |
|------|------|
| `get_upcoming` | 近期截止项目 + 日历事件合并（默认 7 天） |
| `get_dashboard_stats` | 项目按状态 / 事件 / 文件 / 客户计数 |

### 记忆 · `skills/memory.py`（1）
| 工具 | 说明 |
|------|------|
| `remember` | 把一条关于用户的长期信息写进 `.agent/facts.md`（与反思共用 `store.merge_facts` 去重）|

### 联网搜索 · `skills/search.py`（1）
| 工具 | 说明 |
|------|------|
| `web_search` | Tavily 联网搜索实时/外部信息。Key 从 `settings.search.tavily_api_key`（Admin 配）读，未配置返回友好错误；受每日次数配额限制（见下）|

### 对话 · `skills/conversations.py`（2）
| 工具 | 说明 |
|------|------|
| `search_conversations` | 搜用户**过去的对话**（消息正文 + 标题，按 session 聚合返回片段；不传关键词列最近对话）。严格多用户隔离 |
| `read_conversation` | 读某条历史对话的完整消息（只能读自己的 session）|

> 另：`im` skill 的 `react`（LLM 版飞书表情）已注册但**未进 default profile**（秒回表情走网关关键词，见「飞书消息秒回表情」）；站内全局搜索是顶栏 UI 功能、走 `GET /api/v1/search`，**不是 agent 工具**。

> 启用集合由 `profiles/default.py` 的 `skills`（skill 名列表）经 registry 派生（见下「Skill 一等公民」）；新增工具 = 在对应 skill 加 `Tool` 声明 + handler（自动派生双格式并注册），不可逆操作加 `destructive=True`。

### Skill 一等公民（Profile 组合 skill，不再手抄工具名）

原 `DefaultProfile.tool_names` 手列 39 个工具名，与各 skill 的 `Tool` 声明双重维护（加工具要改两处，漏一处静默失效）。已重构为：

- `SkillRegistry` 增 `_skills`（skill 名 → 有序工具名）+ `add_skill()` / `tools_of()`；`BaseSkill.register()` 注册时记录分组。
- `BaseProfile.skills`（skill 名列表）+ `tool_names` **派生属性**（`registry.tools_of(skills)`，去重保序）。
- `DefaultProfile.skills = ["projects","calendar","files","clients","trash","overview","memory","search","conversations"]` —— 一行替代几十行扁平清单（web / 飞书 / QQ 共用）。

工具集与重构前集合相等（验证通过），行为零变化。

---

## Roadmap

> 🅼 = **小模型相关，全部最后做**。需自托管小模型推理（GPU/算力），目前无条件，统一推迟到所有其它功能之后；这些项不阻塞任何前序工作，主流程一律先用主模型 / 关键词 + 状态机替代。

### 下一步优先级（2026-06-23 修订 · 实际推进顺序）

> 原则：咕咕是**伙伴**，按「**哪个让咕咕明天对用户更有用 + 现在最痛**」排，**不**按「agent 该有哪些模块」堆。下面这版覆盖下方按 Phase 编号的历史规划，作为实际推进的权威顺序。

| 档 | 做什么 | 为什么是这个位置 |
|----|--------|------------------|
| ~~**① 现在**~~ ✅ | ~~**轻量 State Manager + Intent Router**~~ **已落地**（关键词版，IM 路）：状态查询/取消/闲聊不进主模型，网关层短路；自然语言取消轮间中断（见 Phase 1.7） | 当前最大的洞，已补。小模型分类版留待有 GPU |
| **② 紧接着** | **简单主动触达**（截止临近提醒）+ **配额能力降级**（非一刀切拦死）+ **地基加固**（一键重启 worker/supervisor、健康、自愈）| 主动触达对伙伴产品价值高于 Planner，且复用现成 IM+实时设施；配额降级是真实痛点（文档 30，现在精力不足连查询都不行）；地基刚栽过坑（漏重启 worker，见 devlog）——**继续堆功能前先把三进程运维做稳** |
| **③ 再 then** | **`summary.md` 状态快照** + **按需的记忆 2b**（只做用得上的）| 快照便宜且对上下文有用；**分层压缩是为了扛规模，现在早期、记忆没溢出，等真撑不住再上**（避免过早优化） |
| **④ 谨慎 / 按需** | Insight / Goal / **Planner** | ⚠️ **不要预先造规划框架**——当前 LLM 工具循环本身就是轻量 planner；高复杂高风险、雄心路线常死在这。等出现具体、反复出现的「模型自己编排不了」的场景再针对性加 |
| **⑤ 可能不做 / 无条件** | **多 Agent**、🅼 小模型意图分类 | 单用户 PM 伙伴多半不需要多 Agent（复杂度爆炸，别投机性建）；小模型分类需自托管 GPU，暂无条件 |

> 下方 Phase 0–4 是历史规划与落地记录（含偏差说明），保留备查；**实际下一步以本表为准**。

### Phase 0 — 基础设施（已完成）

- [x] Admin 后台：LLM 配置、系统提示词编辑、行为配置
- [x] `prompts/default.md`：prompt 文件化，admin 可热更新
- [x] 用量统计：token 记录（`AgentUsage` 表）+ admin 统计面板

### Phase 1 — 核心重构（已完成）

重构现有单文件实现，不改变对外接口，用户无感知。已落地并通过进程内冒烟（MiniMax/Anthropic 路实测，纯对话 / 列项目 / 建项目 / 建事件 4 场景）。

- [x] `models.py`：`AgentRequest`（message/user_id/user_name/session_id/source）/ `AgentResponse`
- [x] `skills/`：现有 4 工具迁出，`skills/base.py` 提供 `Tool` + `BaseSkill` + 全局 `registry`（单一声明派生 Anthropic/OpenAI 双格式、`dispatch` 统一执行）；`projects.py` / `calendar.py` 自注册
- [x] `core.py`：`LLMRunner` 统一 Anthropic / OpenAI 两路循环，工具走 registry，MAX_ROUNDS=5
- [x] `context/loaders.py` + `context/builder.py`：DB 取 projects/events + 记忆 stub；prompt 组装
- [x] `adapters/web.py`：SSE 编排（配额→上下文→会话→core→持久化），对外行为字节级不变
- [x] `profiles/default.py`：`DefaultProfile`（`tool_names` 选定工具集 + `prompt_file` + `memory_enabled`）
- [x] `app/api/v1/agent.py` 瘦身为薄层（637 → 106 行），仅 router + ChatRequest + 4 端点接线

**与原设计的实际偏差（已确认）**：
- **编排归属**：会话持久化 / 配额 / 用量记录放在 `adapters/web.py`（务实），未单设 service 层。
- **persona.md 推迟 Phase 2**：builder 当前只读 `default.md`，不加载/不 prepend persona；`{summary}{facts}{preferences}{memory}{weekly}{daily}` 占位符仍填空串（`loaders.load_memory` 返回空 dict）。
- **`default.md` 加了操作性系统引导**（身份 + 工具使用须知 + 删除确认 + 文档生成约定）—— 裸 prompt 下模型不会主动/正确用工具，这是让 23 工具可用的最小必需；完整 persona/记忆仍属 Phase 2。prompt 每次调用现读文件，热生效无需重启。
- **`router.py` 推迟**：当前单 Profile 直连，多 Profile 路由留 Phase 3。
- **`max_tokens`/`temperature` 已可配**：Admin 增「离散度」等设置，core 改读 `settings.ai.max_tokens` / `settings.ai.temperature`（Phase 0 增强）。
- **历史窗口改为按 token 预算**：原 `limit(10)` 按条数 → 改为 `context/tokens.py` 的 CJK 感知 token 估算（中文≈1.3 token/字，其余≈4 字符/token），从最新往回按预算裁剪、整条进出、至少保留最新一条；另设条数安全上限（40）。预算值接 `settings.ai.context_tokens`。
- **LLM 单次流式调用（修复双调用敷衍 + 保留真流式）**：原"探测-再流式"两次调用、丢弃首次结果致敷衍。改为单次 `messages.stream`（带 tools）：实时流式输出文本，结束后从 `get_final_message` 取 tool_use 决定是否执行工具。真流式 + 无敷衍 + 工具正常；`temperature` 加到调用上保离散度。前端配合：流式中按纯文本显示、完成后渲染 markdown（避免半截表格/代码块闪烁）。
- **MiniMax 标记清洗**：`agent/sanitize.py`，token 流出现 `]<]minimax` 即截断其后泄漏内容（处理跨块）。
- **上下文注入文件概览**：`loaders.load_files_overview` 每轮提供文件夹列表 + 文件总数 + 最近 25 文件，builder 填 `{files}` 占位、`default.md` 设「你的文件」段。让咕咕开局即见最新文件状态，根治"读不到最新文件"（之前只注入项目+日历）。所有 id-based 工具均已支持按名定位（`project`/`file`/`event`/`client`/文件夹名）。

### Phase 1.5 — 工具扩展与删除保底

> 详见 [`agent-tools-design.md`](agent-tools-design.md)。全部落在 `backend/agent/`，不动后台。工具总数 4 → **37**，均通过冒烟。

- [x] **项目**：`update_stage`（切阶段/勾待办）、`set_priority`、`archive_project`、`delete_project`（destructive）
- [x] **日历**：`list_events` / `update_event` / `delete_event`（destructive）
- [x] **文件**（`skills/files.py`）：`list_files` / `read_file` / `edit_file` / `create_document`（md/txt/json/csv 直写；docx/pdf 由 HTML、xlsx 由 CSV 经 LibreOffice 转换，已验证生成合法二进制）/ `rename_file` / `move_file` / `create_folder` / `delete_file`（软删可恢复）
- [x] **客户**（`skills/clients.py`）：`list_clients` / `create_client`
- [x] **删除二次确认 · 保底（显式 confirm 参数）**：删除工具加 `destructive` 标记 + `confirm` 入参；`agent/confirm.py` 的 `needs_confirmation(args, summary)` —— 未带 `confirm=true` 返回影响详情、不删，用户同意后带 `confirm=true` 再调一次才执行。早期曾用"跨轮强制(ContextVar+消息序号)"，但与模型"先用文字征询"的自然行为冲突、导致反复确认删不掉，已改为显式参数。实测：一次确认即删、id 正确。
- [x] **聚合**（`skills/overview.py`）：`get_upcoming`（近期截止项目+日历事件合并排序）/ `get_dashboard_stats`（项目按状态/事件/文件/客户计数）
- [x] **P0 缺口补齐**（实战暴露后补，详见 agent-tools-design.md）：
  - 项目阶段/待办：`get_project`（看完整结构）/ `add_stage` / `remove_stage` / `rename_stage` / `add_todo`（批量）/ `remove_todo` —— 修复"建阶段被误建成项目"
  - 文件夹：`list_folders` / `rename_folder` / `delete_folder`（move 待后端支持）
  - 回收站（`skills/trash.py`）：`list_trash` / `restore_file` / `permanent_delete`🔒
  - 客户：`update_client` / `delete_client`🔒

> 实现注记：文本读/改限白名单 ext + ≤256KB；文件整理（rename/move）复用 `app.api.v1.files` 的 `_build_key`/`_resolve_conflict`/`_move_to_trash` 并复刻 `update_file` 的 key 重建；LibreOffice html→docx 需 `--infilter="HTML (StarWriter)"` 否则报 no export filter。
> MiniMax tool-call 标记泄漏：已加 `agent/sanitize.py` 流式清洗器，token 流中一旦出现 `]<]minimax` 标记即截断其后泄漏内容（处理跨块拆分），`web.py` 转发处接入。
> 已知待办（非本期 bug）：小文件 `_fmt_size` 显示「0 KB」（app 既有）。

> 相关：多套 LLM 预设 + 激活切换的设计见 [`llm-presets-design.md`](llm-presets-design.md)（属后台配置层，保证 agent 包零改动）。

---

## 规划修正（依据 [`docs/agent设计/`](agent设计/) 八份产品设计文档）

通读产品设计文档后对原路线的**顺序与范围修正**（不推翻工程骨架，只调优先级）：

- **persona 从 Phase 2 拆出、提前做** —— 人格不依赖记忆系统，且文档 27《伙伴模式规则》已是现成素材；落成 `persona.md` 是最高杠杆、最低成本的体验提升。
- **引入对话模式（文档 26）** —— 执行 / 推进 / 记录 / **决策探索** 四态；决策探索与闲聊**不强制任务化**。当前 `default.md` 的"直接调用工具去做"过于一刀切，会把"随便聊聊买车"也搞成项目管理，需按模式软化。
- **Runtime Router 提前（文档 29）** —— 自然语言取消、状态查询、简单闲聊不进主模型；从原 Phase 3 提前到 Phase 1.7（轻量版）。
- **配额改"能力降级"而非硬切（文档 30）** —— 精力不足时简单对话/查询仍可用，只暂缓重操作；现状是一刀切拦死全部对话（属后台配额领地，需协调）。
- **安全瘦身（文档 07）** —— 咕咕不跑 shell，**不引入**命令白名单 / Docker 沙箱；保留「二次确认 + 审计日志 + 权限分级」即覆盖。
- **暂不动（标记）** —— Record 统一数据模型（文档 30，与现分表架构根本分歧、改动巨大）；Chat→Action 转化率埋点（文档 25，不紧急）。

---

### Phase 1.6 — 伙伴人格 + 对话模式（依据文档 27 / 26）

- [x] `prompts/persona.md`：采纳文档 27 伙伴人格（角色、四态、主动思考但不打扰、风格无工具感、内容边界、删除确认）；builder 最先加载、所有 profile 共享
- [x] `context/builder.py`：prepend persona.md（persona → profile 模板的注入顺序）；`default.md` 收敛为数据上下文，去掉早期"催着用工具"的一刀切引导
- [x] **对话模式**：persona 写入执行/推进/记录/决策四态切换。实测：执行类答完会主动给 next step、决策探索（"纠结换电脑"）不强建项目、像朋友讨论
- [x] ~~昵称收集~~ **改用 `User.display_name`**（注册/个人设置已填，`req.user_name` 即来源），不单独问昵称、不建 `identity.json`；身份称呼由反思自然并入 facts。下方「昵称收集机制」设计作废

#### ~~昵称收集机制~~（已作废）

原设计：移除 Onboarding，由咕咕首次对话主动问昵称、`save_identity` 工具写 `identity.json`。

**作废原因**：`User.display_name` 在注册/个人设置时已填，`req.user_name` 直接取用即可——无需再问、无需 `identity.json` / `save_identity` / `skills/identity.py`。身份称呼等信息由 Phase 2a 反思自然并入 `facts.md`。

### Phase 1.7 — 轻量 Runtime Router（关键词版已落地，依据文档 29）

> **价值与 IM 接入强绑定**：网页 UX 流式中输入被锁、且有停止按钮，状态查询/自然语言取消基本触发不了；但 IM bot 上消息异步、无流式指示，用户看不到咕咕是否在工作 → State Manager 是**刚需**。故只对 IM 路做（web 复用现成停止键/genstream）。
>
> **关键架构洞察**：IM 是**单 worker 顺序消费队列**——任务进行中后续消息排在队列里、worker 在忙看不到，所以「还在吗/算了」必须由**网关据 Redis 状态短路**，不能进 worker。详见 `runtime_state.py` / `router.py` 模块说明。

- [x] **关键词 + 状态机版**（`agent/router.py`）：自然语言取消（"算了/停一下/不弄了"）、状态查询（"还在吗/好了吗/?"）、闲聊确认（"嗯/好的/哈哈"）**不进主模型**，网关直接轻量回应。整条匹配 + 短词才判取消/情绪，宁漏判进主模型、不误判短路（实测 classify 19/20，唯一漏判是安全方向）
- [x] **State Manager**（`agent/runtime_state.py`）：`IDLE/THINKING/SEARCHING/GENERATING` 走 Redis（带 TTL 防卡死，worker 写、网关读）；worker `handle` + core 工具循环据 `TOOL_STATE` 打点。WAITING_CONFIRM 状态预留（尚未接删除二次确认）
- [x] **自然语言取消落地**：网关置取消标志 → core 工具循环**每轮协作检查** → 命中即中断（粒度 = 轮与轮之间，单次 LLM 流式调用切不了）；`AgentResponse.cancelled` 透传，worker 据此不补发（网关已回「先不继续啦」）
- [ ] 🅼 **（最后做 · 暂无条件）** 升级为小模型意图分类（Qwen3-0.6B 等），输出 `{intent, confidence}`——需自托管 GPU，目前关键词版已满足 IM 需求

### Phase 2 — 记忆系统

#### Phase 2a — 精简闭环（已落地）

先做"能读、能记、能用"的最小闭环，**刻意简化**原设计（详见下方偏差），可直接验证咕咕"记得住"。

- [x] `agent/memory/store.py`：读写 `.agent/{facts,daily}.md`，经 `StorageBackend`（本地/OSS 通吃），缺文件返回空。`merge_facts` 按内容去重，`append_daily` 滚动保留最近 30 条
- [x] `agent/memory/reflection.py`：对话结束后**单次非流式** LLM 调用（复用 `settings.ai`）提炼 `{facts:[...], daily:"..."}`，增量合并写盘；`schedule()` fire-and-forget（持后台任务引用防 GC），失败不影响对话
- [x] **反思提示词文件化**：提炼词从内联常量移到 `prompts/reflection.md`，`reflection.py` 每次现读（热生效）+ 兜底；接进 Admin（`agent_admin.py` `SPECIAL_PROMPTS=["persona","reflection"]`，前端「系统提示词」tab 显「记忆反思」）。首版实测偏噪音（记推测/世界常识/矛盾/评判），据此收紧规则：只记用户本人、不记推测/一时状态、不评判、宁少勿多
- [x] **联网搜索 + 配额**：`skills/search.py` 的 `web_search`（Tavily，第 41 工具）；key 走通用 `/admin/config`（打码）+ 前端 Agent 页输入；每日次数配额 `quota.default_search_limit_daily` + `search_usage` 表（create_all 建），`web_search` 执行前查当天次数超则拒（仅拦搜索不拦对话）、成功才记。前端配额管理页加「每日搜索次数上限」。暂无 per-user 覆盖
- [x] `skills/memory.py`：`remember` 工具 —— 用户说"记住X"时主动落盘（主动记忆路径）
- [x] `context/loaders.py`：`load_memory` 改 async 真读；`context/builder.py`：清掉死占位符，记忆 section **仅非空时注入**（人格 → 我对你的了解/最近的记忆 → 实时状态），空记忆不烧 token
- [x] `adapters/web.py`：`memory_enabled` 时 `await load_memory` 注入；持久化后 `reflection.schedule()` 触发反思
- [x] `profiles/default.py`：`memory_enabled=True` + `skills` 加 `"memory"`

**与原设计的实际偏差（已确认）**：
- **facts.md 而非 facts.json**：MVP 直接维护 markdown 事实列表，不做结构化 JSON + confidence/source，去重靠内容包含判断。结构化版留待数据量上来再说。
- **两层而非三层**：只有 `facts.md`（长期）+ `daily.md`（近期滚动 30 条），**无 weekly / compressor / manager / importance 分级**。压缩路径（已定为 **daily→memory，无 weekly**）整体延后。
- **无 events 总线**：反思直接在 `web.py` fire-and-forget 调用，未引入 `events/bus.py`。
- **无 identity / summary**：昵称沿用 `User.display_name`（注册已填），不单独问、不建 `identity.json`；身份/称呼由反思自然并入 facts。`summary.md` 快照延后。
- **反思 token 暂不计入用户配额**（锦上添花，不占可见精力）。

#### Phase 2b — 分层压缩与结构化（未做）

- [ ] `facts.json` 结构化（confidence / source）+ 自然语言导出
- [ ] `daily（14天）→ memory.md` 压缩（**无 weekly 层**）+ importance 过滤（compressor / manager）
- [ ] `summary.md` 当前状态快照（importance ≥ 4 触发更新）
- [ ] `events/bus.py` + `events/types.py`：全局事件总线
- [ ] **控制命令（文档 03）**：`/newchat`（清会话留记忆）/ `/remember` / `/forget` / `/memory` / `/clear`
- [ ] **历史压缩升级**：现为 token 截断，升级为分层摘要压缩（早期对话摘要 + 最近保留，文档 03/05）

### Phase 3 — 扩展能力

- [ ] `mcp/client.py` + `mcp/registry.py`：MCP 协议支持，动态加载外部工具
- [ ] Profile 能力开关（memory_enabled / mcp_enabled）
- [ ] `router.py` 升级：多 Profile 路由（在 Phase 1.7 轻量 Router 基础上）
- [ ] 🅼 **（最后做 · 暂无条件）** 小模型意图分类，并入路由决策 —— 同 Phase 1.7 小模型项，需自托管推理算力，目前不做

### Phase 4 — IM 平台接入与伙伴深化

> **完整方案见 [`agent-im接入架构.md`](agent-im接入架构.md)**。决策：飞书 / QQ / 微信均走**官方直连、不用 OpenClaw**；从一开始就按「收消息 ↔ 跑大模型」解耦的**队列 + worker 架构**建，为高流量留缝。

**IM 接入地基（队列架构，6 步逐缝验证，详见 IM 文档）**
- [x] **step 1 · `app/core/redis.py`**：共享异步 Redis 客户端（懒加载单例，同 db engine 模式）+ Redis Streams 封装（`ensure_group`/`produce`/`consume`/`ack`/`claim_stale`/`ping`/`reset`），消息体统一 `data=JSON`；`config.save_override` 改 redis 配置时 `reset` 重建。实测自产自消+ack 清零（远程 Redis 8.8.0）
- [x] **step 2 · `agent/runner.py`**：`run_collect(req)→AgentResponse`，复用 loaders/builder/core/sanitize，把流式工具循环消费成"完整一段"回复（bot 不流式，web SSE 路不动）。实测真打 MiniMax 返回完整回复
- [x] **step 3 · `worker.py`**（backend 顶层独立进程入口）：消费 `im:inbound` → `run_collect` →（暂打印）→ ack，带 `claim_stale` 回收崩溃遗留、信号优雅退出；独立于 web 避免多 uvicorn worker 重复消费。实测 队列→大脑→回复→ack 端到端通
- [x] **step 4 · `adapters/feishu.py`**：飞书 WebSocket 长连收 `im.message.receive_v1` → `produce_sync` 入队（lark `ws.Client.start()` 同步阻塞、handler 同步，故用同步 produce）。**实测连上飞书 WSS 并收到真实消息**
- [x] **step 5** 接通发回：`worker.handle` 跑完 `run_collect` → 按 platform 发回（飞书 `feishu.send_text` 用 `lark.Client` API）。**实测飞书私聊端到端：发"你是谁"→咕咕带人格回复送达飞书**
- [x] ~~**step 6 · 用户映射（OAuth 扫码绑定）**：`PlatformBinding` + `feishu_bind.py`~~ —— **已被 BYO 取代**：后改为「每用户自带 bot，扫码 device-flow 自动创建」，bot 即归属 owner，删掉了绑定表 + OAuth 那套（见下「BYO 接入与动态网关」）
- [ ] **step 6 余项**：事件去重、平台 token 存 Redis、用户状态机（并入 Phase 1.7）、背压（**去重 / 背压详见下「并发性能优化」**）

> **首平台里程碑（2026-06-23）**：飞书私聊端到端打通——`飞书消息 → 网关(WSS) → Redis队列 → worker → run_collect(人格+记忆+41工具) → feishu.send_text 发回`。坑：worker 阻塞读 XREADGROUP 需 `socket_timeout=None`，否则到点抛 TimeoutError。

#### BYO 接入与动态网关（用户自助，无 Admin 共享 bot）

> **架构演进（2026-06-23）**：早期飞书是「Admin 共享 bot + 用户 OAuth 绑定」，后**统一改为 BYO**——飞书、QQ 每个用户接自己的 bot，扫码自动创建。已删除 Admin 频道面板、`PlatformBinding`、`feishu_bind/feishu_event`、`active_im_bots`。

**① 存储 · `user_bots` 表（每用户自带 bot）**
- `app/api/v1/user_bots.py` 的 `/me/bots`：**用户级** CRUD（仅能管自己的，secret 打码），字段 `{user_id(owner), platform, app_id, app_secret, sandbox, enabled}`，create_all 自动建表。
- 扫码自动连接直接写这张表（见各平台接入设计）。

**② 动态网关 · 进程级管理（`agent/adapters/supervisor.py`）**
- **为什么进程级**：lark/botpy 的连接只有 `start()`、**无 `stop()`**，进程内断不掉 → **一个 bot 一个子进程**，kill 子进程 = 断开。
- supervisor 常驻 loop 每 5s 查 `user_bots`（启用的）→ reconcile：新增/启用 `spawn`、停用/删除 `terminate`、崩溃下轮自动重启。
- **凭据走环境变量注入**（不走 argv，避免 `ps` 泄漏 secret）：飞书 `FEISHU_BOT_ID/APP_ID/APP_SECRET/OWNER`、QQ `QQ_*`。
- key 用 `platform:id` 命名空间；DB 抖动时保活已在跑的，不误杀。

**③ 认人 · owner 即归属（无需绑定表）**
- bot 天然属于其 owner → 网关入队 payload 带 `owner_user_id`，`worker._resolve_user` 直接用它查 User（飞书、QQ 同一套，省掉了 PlatformBinding）。
- 发送按 bot id 现查 `user_bots` 取凭据：feishu `send_text`、qq `send_c2c`。

**④ 运行模型**：`supervisor`（管网关子进程）+ `worker`（消费队列跑大脑发回）两个常驻进程。

**各平台 adapter（官方直连，无 OpenClaw；`agent/adapters/`）**
- [x] `adapters/feishu.py`：`lark-oapi` WebSocket 长连收（`im.message.receive_v1`）+ `send_text` 发；**BYO**，收凭据走 env、发凭据查 `user_bots`，payload 带 `owner_user_id`。**已端到端跑通 + device-flow 扫码自动连接**
- [x] `adapters/supervisor.py`：网关管家，飞书+QQ 都从 `user_bots` 读 + env 注入
- [x] `adapters/qq.py`：`botpy` WebSocket 长连收 `on_c2c_message_create`（单聊 C2C）+ `post_c2c_message` 被动回复（带 msg_id）；**BYO**，env 注入。**已端到端跑通 + 扫码自动连接 + markdown(msg_type=2，无权限回退纯文本)**
- [ ] `adapters/weixin.py`：iLink（个人微信号，扫码登录 + 长轮询 getupdates / sendmessage），纯文本、token 易失效、**封号风险高**，最后做（机制见 `agent-im接入架构.md` §3.3）

#### 飞书接入设计（BYO + device-flow 扫码自动创建）

与早期"共享 bot + OAuth 绑定"不同，现在每个用户扫码**自动创建并连接自己的飞书 app**（PersonalAgent），和 QQ 同模型。复刻 QwenPaw，实测无需合作方资质。

**扫码自动连接（OAuth 2.0 设备授权流 RFC 8628）** `app/api/v1/feishu_connect.py`
```
POST accounts.feishu.cn/oauth/v1/app/registration action=init  → supported_auth_methods（含 client_secret，无鉴权）
POST … action=begin (archetype=PersonalAgent, auth_method=client_secret, request_user_info=open_id)
     → device_code + verification_uri_complete（open.feishu.cn/page/launcher?user_code=..）
  → 前端二维码 verification_uri_complete?source=Gugu
  → 用户手机飞书扫码 → 授权创建 PersonalAgent 应用
  → 轮询 POST … action=poll {device_code}
       （等待时按 RFC 8628 返回 400 + {"error":"authorization_pending"}，**poll 不能 raise_for_status**）
       成功 → client_id + client_secret（即 App ID/Secret）+ user_info.open_id
  → 自动写 user_bots（platform=feishu）
```
- **device_code 只存服务端 Redis**（按 poll_id，TTL=expires_in），不下发前端。`source` 仅来源标签（非白名单）。
- 国内 `accounts.feishu.cn`，国际版 Lark 为 `accounts.larksuite.com`（如需再加 domain 参数）。
- 收发：`lark-oapi` WS 长连（`on_message` 带 owner 入队）+ `lark.Client` Open API 发；都不需要公网。
- 拆解过程见 `docs/devlog.md`、`docs/agent-im接入架构.md` §3.1。

#### QQ 接入设计（BYO 每用户自带 bot + 扫码自动连接）

QQ 和飞书一样走 **BYO（Bring-Your-Own）**：每个用户接自己的 QQ bot，扫码自动创建。

**① BYO 模型**
- `user_bots` 表（create_all 自动建）存每用户的 `app_id/app_secret/sandbox/enabled`，platform=qqbot；`app/api/v1/user_bots.py` 的 `/me/bots` 是**用户级** CRUD（仅能管自己的，secret 打码）。
- supervisor 飞书+QQ **都从 `user_bots` 表读**（凭据走**环境变量注入**，避免 ps 泄漏），常驻 loop 复用 asyncpg engine，DB 抖动保活不误杀。
- **不需要绑定表**：bot 即归属其 owner → 网关入队 payload 带 `owner_user_id`，`worker._resolve_user` 直接用（比飞书省一层）。

**② 扫码自动连接（复刻 QwenPaw/OpenClaw，实测无需合作方资质）** `app/api/v1/qq_connect.py`
```
POST q.qq.com/lite/create_bind_task {"key": base64(随机32字节)} → task_id   （无鉴权！）
  → 前端二维码 connect.html?task_id=..&_wv=2&source=Gugu
  → 用户手机 QQ 扫码 → QQ App 内选 bot 授权
  → 轮询 POST q.qq.com/lite/poll_bind_result {"task_id"}
       status==2 → bot_appid(明文) + bot_encrypt_secret(AES-256-GCM)
  → 用第 1 步 key 解出 AppSecret → 自动写 user_bots（无需手动复制）
```
- **安全**：接口无鉴权，但 secret 用调用方本地 key 加密回传、只有创建者能解；aes_key 只存服务端 Redis（按 task_id），不下发前端。`source` 只是来源标签（非白名单）。
- 一度误判为"腾讯官方合作墙"，扒 QwenPaw 源码 + 实测推翻。详见 `docs/devlog.md` 2026-06-23 QQ 条、`docs/agent-im接入架构.md` §3.2、`qq-scan-connect` 记忆。

**③ C2C 单聊收发**：`botpy.Intents(public_messages=True)` + `on_c2c_message_create`；回复用 `post_c2c_message(openid, msg_id, content)`（被动回复，worker 端独立 `BotHttp.login` 取 token、过期重建）。sandbox 字段区分开发/生产环境。

#### 并发性能优化

> **完整诊断、方案与分期见 [`并发优化ROADMAP.md`](并发优化ROADMAP.md)**（诊断依据 + P0–P4 + ①–⑨ backlog）。一句话：worker 现为单进程串行（`run_once` 的 `for msg: await handle`，并发度=1，瓶颈在串行非资源）；核心优化是 **① worker 串行→有界并发 + `user_gate(puid)` 按用户串行**（P1），配合 ⑦ 慢尾兜底；横向扩（③多 worker / ④uvicorn --workers，需先抽离 scheduler 单实例）按埋点数据触发。`并发治排队 · provider(⑥)治延迟`，正交。

**伙伴深化（更后）**
- [ ] 主动触达：截止日临近提醒、异常沉默感知、情绪状态关注
- [ ] 成就系统 / 正反馈系统（挂载 EventBus Listener）
- [ ] 行为分析 Listener：从操作日志提炼工作节律，写入 facts

---

## 提醒工作流（Reminder Workflow）

> **架构决定（2026-06-24）**：定时任务结果**不进对话**，走独立链路投递到现有侧边栏通知弹窗 + IM。

### 设计原则

- **不进对话**：`_deliver_chat` 从定时任务路径完全移除，不污染聊天 session。
- **不需新页面**：复用现有侧边栏铃铛通知弹窗，无需独立提醒中心。
- **统一走 agent**：无 `reminder` 类型，payload 始终经 agent 处理后再投递，咕咕可以用自然语气包装提醒。

### 关键设计：prompt 上下文注入

用户填写的 payload 是面向自己的指令（如「让我喝水」），裸传给 agent 会导致 `我` 指向歧义。`execute_task` 触发时统一包裹上下文：

```python
prompt = (
    f"[定时任务触发：{name}]\n"
    f"用户在 {now} 设置了一条提醒，内容是：{payload}\n"
    f"请以咕咕的身份，用自然的语气向用户发送这条提醒。"
)
```

agent 收到后知道「我 = 用户」，生成友好提醒（如「⏰ 喝水时间到啦～记得补充水分哦！」）而不会混淆主语。

### 执行链

```
APScheduler 触发
  → execute_task
  → 构造带上下文的 prompt（注入 task_name / payload / triggered_at）
  → _run_agent(prompt)                     # 静默后台，不进对话
  → events.publish(uid, 'notification',    # 复用现有 SSE 频道
        title=task.name, content=result)
      → live.js 收 notification 事件
      → AppSidebar.notifications.push()    # 铃铛弹窗追加，角标 +1
  → _deliver_im                            # 飞书/QQ 同步投递
```

### 待实现

- [ ] `backend/app/scheduled_tasks.py`：`execute_task` 移除 `_deliver_chat`，构造上下文 prompt，结果走 `events.publish(notification)`
- [ ] `backend/app/core/events.py`：`publish` 支持 `notification` 事件类型（带 `title` / `content` 字段）
- [ ] `frontend/src/stores/live.js`：处理 `notification` 事件，写入全局通知列表（新增 `notifStore` 或挂 `uiStore`）
- [ ] `frontend/src/components/common/AppSidebar.vue`：`notifications` 改为响应式 store 驱动，接收 SSE 推入条目，角标联动 `uiStore.notifCount`