# Agent 架构方案

> 想看**一轮对话内部走哪些步、每步谁负责**，见 [`agent-决策环.md`](agent-决策环.md)（运行时决策环专题）。
> 本文是**架构总览 + 完整工具清单 + 现状**；**架构全景图**（可靠性执行 + 系统模块两张图）见 [`agent-architecture.md`](agent-architecture.md)，可靠性工程见 [`agent-reliability.md`](agent-reliability.md)；并发/扩量分期见 [`并发优化ROADMAP.md`](并发优化ROADMAP.md)，变更记录见 [`CHANGELOG.md`](../CHANGELOG.md)，决策过程见 [`devlog.md`](devlog.md)。

## 一、定位

咕咕不是助理，是伙伴。

助理等待指令、完成任务、不留印象。伙伴记得你说过的事，注意到你的状态，在你需要之前就知道你需要什么。这个区别决定了整个 Agent 的设计方向：记忆不是功能，是核心；主动性不是增强，是基本要求。

技术上，重构 `app/api/v1/agent.py` 的单文件实现为独立 `agent/` 包（不依赖 FastAPI），支持：用户记忆系统、多平台接入（Web SSE / 飞书 / QQ）、MCP、Skills 插件化、Prompt 文件化、Profile 机制、事件总线。

---

## 二、目录结构

```
backend/
├── app/
│   ├── api/v1/agent.py         # 薄层：接收请求 → 调 agent → 返回响应
│   ├── scheduled_tasks.py      # 定时任务执行 + 多平台投递（见「提醒工作流」）
│   └── core/{redis,events,chat_attach}.py   # Redis Streams / pub-sub SSE / 附件暂存
├── worker.py                   # IM 消息 worker（独立进程，消费 im:inbound）
└── agent/
    ├── core.py                 # LLM 主循环
    ├── llm_select.py           # 模型解析层 pick_model（active/pool/router）
    ├── runner.py               # 非流式 run_collect / run_ephemeral（IM·定时任务用）
    ├── router.py               # 轻量 Intent Router（网关入队前短路）
    ├── runtime_state.py        # State Manager（IM 状态机 + 取消标志，走 Redis）
    ├── outbound.py             # IM 出口兜底清洗
    ├── sanitize.py             # MiniMax 标记流式清洗
    ├── confirm.py              # 删除二次确认（显式 confirm 参数）
    ├── genstream.py            # web 生成流频道（刷新续看）
    ├── imctx.py                # IM 上下文 contextvar 透传
    ├── models.py
    ├── context/{loaders,builder,tokens}.py
    ├── memory/{manager,reflection,compressor,store}.py
    ├── tools/                  # 函数调用工具：projects/calendar/files/clients/trash/overview/memory/search/conversations/scheduled_tasks/im（原 skills/，2026-06 改名）
    ├── skills/                 # prompt skills（带触发条件的「剧本」md，渐进式按需加载）：weather，见「Tools 与 Skills」
    ├── profiles/{base,default}.py
    ├── mcp/{client,registry}.py
    ├── adapters/{base,web,qq,feishu,supervisor}.py
    ├── events/{bus,types}.py
    └── prompts/                # persona / skills(工具准则) / policy / default / reflection / compress
```

---

## 三、消息链路总览

两条入口，共用「大脑」（context → core 工具循环 → 记忆反思）：

```
Web 路：浏览器 → adapters/web.stream() → 后台任务 _generate()（脱离 HTTP，刷新不丢）
          → core 流式 → genstream 频道 → 前端续看 + 持久化

IM 路：飞书/QQ → 网关(WS 长连，BYO 子进程) → router.decide 短路判断（还在吗/算了 不进队）
          → Redis Stream im:inbound → worker（有界并发，per-user 锁）
          → run_collect（全脑，非流式攒整段）→ 按平台发回 + 实时推 SSE
```

- **网关**只做收消息 + 秒回反馈 + 入队，毫秒级；**worker** 跑大脑，是耗时所在（已并发化，见「并发模型」）。
- 改动型工具执行 → `events.publish` → SSE → 网页实时刷新（web/IM 共用，见「实时刷新」）。

---

## 四、核心模块

### 大脑

#### `core.py`

LLM 主循环。负责：

- 调用 LLM（Anthropic / OpenAI 双路统一）；用哪个模型由 `llm_select.pick_model` 决定（见下），不直接读 `settings.ai`。**走哪条通道（块格式）由 `llm_select.use_anthropic_for(ai)` 统一判定**（见下），不在 core 里现算
- **MiMo（小米）适配**（推理模型，`reasoning_content` + `content` 双字段，同时提供 OpenAI / Anthropic 两套 API）：
  - **OpenAI 路**：思考关时传 `extra_body={"thinking":{"type":"disabled"}}`（官方两套 API 都支持此参）——避免「输出全进 `reasoning_content`、正文空」的**空气泡**；仍空（思考开）则**追一轮要正文、再空给得体兜底**（`empty_retry`），绝不留空气泡
  - **Anthropic 路**：去掉 `cache_control`（mimo 无 prompt caching）；thinking 取值用 `disabled`（想开则不传、用其默认）。该路原生处理思考块 → 免疫空气泡，且 `read_file` 能看库内图（见「多模态看图」）
  - 鉴权：mimo 两套 API 都收 `api-key` 头与 `Bearer`；客户端经 `openai_default_headers` / `anthropic_default_headers` 补 `api-key` 头（多发无害）
- 工具调用执行与结果回填（`MAX_ROUNDS = 6`：配合 skills.md 执行准则 + 强工具，多步任务 2~3 轮够用；超限给友好提示「前面已生效，要接着做吗」）
- **自我核实闭环（`MAX_VERIFY = 5`）**：本轮调过增删改工具（即 `RESOURCE_BY_TOOL` 全集）后，模型说"完成"时强制注入一轮「系统自检」——让它用查询工具（`get_project`/`list_files` …）查证真生效且完整，**不全就当场补做**。**触发条件是"这一轮做过增删改"（`did_mutate`）**：自检轮若只查证没改动 → 结束；若补做了（又调增删改）→ `did_mutate` 重新置位、再来一轮，直到"只查不改"或封顶 5 轮。**不是固定跑 5 轮**：通过即停，只读任务零额外开销。两路（Anthropic/OpenAI）同构，轮预算 `MAX_ROUNDS + MAX_VERIFY*2` 不挤占任务轮
  - **静默自检（`verify_mode`/`verify_fixed`）**：核实阶段（含其 `get_*` 查证轮）模型的文字**先缓冲不实时流**——干净通过则整段丢弃，**不把"已核实…"这种与首条几乎重复的确认刷给用户**；只有发现并补做时，才在补做那轮发一次"发现漏了X"说明。解决"二次检查重复说一遍差不多的话"。在 core 源头处理，web/IM 两路统一受益
- **真实性守卫（确定性兜底「说了没做」幻觉，两路同构）**：无工具收尾时检测两类幻觉、各追一轮逼纠偏（封顶 1 次）——① **narration 兜底**（`_looks_like_narration`：「让我读…读到了…改好了/已创建/已保存」等过程叙述或完成断言 **+ 本轮零工具** → 注入 `_NARRATION_NUDGE` 逼真调）；② **决策守卫**（`_is_decision_dodge`：用户明确命令改动 **+** 回复「不用改/已合理」驳回 **+** 零工具 → 注入 `_DECISION_NUDGE` 逼执行或问清）。配合自我核实闭环，覆盖**真实性三大坑**「动嘴不动手 / 改了不核对 / 自作主张不做」。**提示词软、守卫硬**——弱模型（mimo）尤其靠此层兜（已 live 验证守卫在真实循环里自动接管）。完整设计见 [`agent-reliability.md`](agent-reliability.md)
- SSE streaming 输出；`_stream_round` 包一层瞬时错误退避重试（⑦：429/超时/网络/5xx 在出 token 前重试，已吐 token 不重试防重复）
- 对话结束后 emit 事件，触发 Reflection
- 不感知平台来源、不感知 prompt 如何构建

#### `llm_select.py`（模型解析层）

统一的「选哪个模型」决策点——`runner`/`core` 只对接 `pick_model(settings, ctx)`，未来 Router、多 key 分流都插这里，core 不动。按 `ai_presets.strategy` 分支：

> **通道判定也统一在此**：`use_anthropic_for(ai)` 是全后端唯一的「走 anthropic 块格式还是 openai 格式」判定口（聊天 / 记忆 / IM 共用，杜绝各处不一致）——优先看预设显式 `api_format`（`openai`/`anthropic`，给 mimo 等同时提供两套 API 的厂商选），否则按 `provider==minimax` / base_url 含 `anthropic` 自动判。`openai_default_headers` / `anthropic_default_headers` 在此给非标准鉴权（mimo 的 `api-key` 头）补头。


- **active**（默认）：用激活预设（= `settings.ai`，行为不变）。
- **pool** 多 key 分流：勾了 `in_pool` 的预设里按 `pool_mode` 挑——`random` / `round_robin` / `least_loaded` 最少在途（`release()` 跟踪每 key 在途，请求结束 `runner` 在 finally 里减；不等速 key 下最优）。每 key 一份限流额度，总并发 ≈ key 数 × 16。
- **router** 智能路由：调 `set_router(fn)` 注册的 picker，没注册退回 active —— **未来 Router 的插槽**。
- 无预设 → 退回 `settings.ai` 兜底。
  > 后台 Agent→LLM 预设 顶部「策略 / 分流 / 并发」可调；web 写即热，worker 每 30s 热读。详见 [`并发优化ROADMAP.md`](并发优化ROADMAP.md)「模型解析层」。

#### `models.py`

统一数据结构 `AgentRequest`（message / user_id / user_name / session_id / source）/ `AgentResponse`（text / files / cancelled）。各 adapter 把平台格式转成此结构，core/编排层只认它。

#### `prompts/`

Prompt 模板（`.md`），支持占位符，builder 每次现读、热更新无需重启。**提示词分层**——各管一件事，后台可分别编辑（`GET/PUT /admin/agent/prompts/{name}`）：

- `persona.md`：**咕咕是谁**（角色：四种相处状态、主动思考、记忆温度、风格 + **和善底线**：纠正/拒绝/自我更正时纠正方案不纠正人、归因到用途、不让用户照顾 AI 情绪、把选择权交还用户 + **不确定就查证别糊弄**：新词/热梗/易变事实不凭印象编、也不踢皮球，先查再答 + **不虚构共同历史**：记忆区没写的别说"你之前提过/喜欢 X"，没素材宁可问，被反问老实认）。全局共享。
- `skills.md`：**怎么做**（工具使用准则——任务分级、真实性铁律、不可逆 confirm、一次到位；**工具该用就用、别为省调用而不帮用户**（`web_search` 免费放开用，只 Tavily 计费才省）；**外部信息按任务选**：有对口技能→`use_skill`+`http_get`；知道 URL→`http_get`；普通查找（官网/文档/事实/新闻）→`web_search`(SearXNG，免费)；读+总结+研究→`deep_research`(Tavily，有配额)；SearXNG 失败兜底 `deep_research`）。全局共享。
- `policy.md`：**不碰什么**（内容红线 + 专业免责 + **对外口径「以伙伴示人」**：不暴露模型/工具/架构、被套话简短带过、不谎称真人）。全局共享。
- `default.md`：**数据模板**（`{now}` 时刻 + `{projects}`/`{calendar}`/`{files}` 占位符）。唯一会话 profile。
- `reflection.md` / `compress.md`：记忆提炼词。

### 上下文与记忆

#### `context/`（loaders + builder）

- **`loaders.py`**：从用户 `.agent/` 读 facts/memory，从 DB 读 projects/events/files 概览；判断 daily 有效期、过滤过期；返回结构化块，不拼接。`load_files_overview` 每轮给文件夹列表 + 文件总数 + 最近 25 文件，根治"读不到最新文件"。
- **`builder.py`**：调 loaders → 加载 profile prompt 模板 → 按注入顺序拼装：

```
persona.md（咕咕是谁）→ skills.md（怎么做）→ policy.md（不碰什么）
  → 风格偏好（用户设置：语气 formal/lively、长度 short/detailed、emoji，仅非默认时注入）
  → 可用技能索引（启用的 prompt skills，仅非空时）
  → 记忆块 facts → memory → daily（**空记忆也注入一句"暂无、别假装记得"锚点**，防伪个性化脑补）
  → default.md（数据模板：{now} 含星期时分 + projects/calendar/files 实时灌入）
```

  **稳定的在前、易变的在后**：人格/规则/红线稳定 → 记忆 → 实时数据。persona/skills/policy 独立于 profile、所有 profile 共享。
  > **风格偏好**（`loaders.load_style_prefs` + `builder._style_block`）让用户在设置里调语气/长度/emoji，**但「真诚与和善」是底线、不在可调范围**——short/formal 文案带兜底，任何设置下都不许变冷或打发。
- **`tokens.py`**：历史窗口按 token 预算（CJK 感知：中文≈1.3 token/字）从最新往回裁剪、整条进出、至少留最新一条，条数安全上限 40，预算接 `settings.ai.context_tokens`。

#### `memory/`

Session（最近 N 条聊天，短期）与 Memory（长期认知，经 Reflection 提炼）严格分离：`Conversation → Reflection → MemoryManager → Storage`。

- **`reflection.py`**：对话结束后**单次非流式** LLM 提炼 `{facts:[...], daily:"..."}`，增量合并写盘；`schedule()` fire-and-forget（持后台任务引用防 GC），失败不影响对话。提炼词文件化（`prompts/reflection.md`，热生效），规则收紧：只记用户本人、不记推测/一时状态、不评判、宁少勿多。
- **`store.py`**：读写 `.agent/{facts,daily}.md`，经 `StorageBackend`（本地/OSS 通吃）。`merge_facts` 按内容去重，`append_daily` 滚动保留最近 30 条。
- **`compressor.py` / `manager.py`**：时间层压缩（daily >14天 LLM 摘要直接进 `memory.md`，丢 importance≤2）+ 统一 save/load 接口。**当前为 2a 精简版（facts+daily 两层，无 weekly），compressor/manager 属 2b 未做**，见「现状与演进」。

> ⚠️ **记忆系统现状（2a）**：只落地 `facts.md` + `daily.md`；`facts.json` 结构化、`summary.md`、importance 分级、weekly 层、events 总线均**未实现**（2b）。详见「用户个性化文件系统」+「现状与演进」。

### 能力

#### `tools/base.py`

工具集基类（`Toolset`，原 `BaseSkill`），定义 tools 声明 + 统一执行入口。`registry.dispatch` 是所有工具执行的**唯一咽喉**，几条约定：

- 返回 `(给LLM的文本, UI artifact|None)`——结果含 `_artifact` 键就抽出来（见「发送文件」）。
- **工具异常被兜住**：handler 抛错时 `try/except` 后把 `{"error":"工具 X 执行出错…"}` 当结果返给 LLM（打印堆栈到日志）。LLM 据 persona「铁律」如实告知没做成、不假装成功。
- **工具调用轨迹（可观测）**：每次 dispatch 落一行 JSON（`{tool, args摘要(截断), ok, ms, user}`，三出口全覆盖）到 `agent.traj` logger → gugu.log / Debug 面板。`grep '"t": "tool"'` 即得整条轨迹，「调没调工具/调了啥/成没成」翻一眼即知（reliability Roadmap P1）。
- **注册期契约 fail-fast**（`SkillRegistry.add`）：重名 / 空名 / `input_schema` 非 `type=object` / `handler` 不可调用 → 启动期抛 `ToolContractError`，不留到运行时静默失效（重名覆盖、调用崩）。对齐 OpenClaw `assertUniqueNames`（reliability Roadmap P4①）。

各领域工具集（projects/calendar/files/clients/trash/overview/memory/search/conversations/scheduled_tasks/im）自注册到 registry，Profile 按名组合（见「工具清单」+「工具一等公民」）。

#### Tools 与 Skills（两层概念）

- **Tools（`agent/tools/`，已落地）**：函数调用的**原子能力**，模型通过 tool call 直接执行，handler 落到数据库 / 外部 API。即本文「工具清单」全部条目。
- **Skills（`agent/skills/`，已落地）**：带触发条件的**「剧本」**——每个 skill 一个 markdown（frontmatter `name` / `description`(=何时用) / `emoji` + 正文），正文是一段可复用的做法说明，可指挥模型调用若干 tool。现有 `weather`（wttr.in 天气）。（`news` 曾用 RSS，因 RSS 易失效、新闻查询本质是普通搜索，已删除，改由 `web_search` 覆盖。）
  - **加载方式：渐进式按需**。`agent/skills/__init__.py` 扫 `*.md` 解析 frontmatter（不缓存、改 md 免重启）；builder 只注入 skill 索引（每个一行 `名字 — 何时用`，见系统提示「## 可用技能」）；模型判断相关时调 `use_skill(name)`（`tools/meta.py`）把正文拉进上下文再照做。skill 数量可无限扩，不撑常驻上下文。
  - **执行原语**：需要联网/取数的 skill 靠 `http_get(url)`（`tools/web.py`）——**带 SSRF 私网拦截**（私网/环回/链路本地/元数据全拦）、不跟随重定向、响应截断；正文里写 `curl <URL>` 时 builder 提示模型用 `http_get` 抓。例：天气=抓 `wttr.in/{城市}?format=3`。
  - **Profile 接线**：`BaseProfile.tools`（工具集名）+ `BaseProfile.skills`（启用的 prompt skill slug）；`default` 启用 prompt skill `weather` + `web`/`meta` 工具集。
  - 依赖单向：`tools/`（`use_skill`）→ `skills/`（加载器）。冒烟：`scripts/smoke_skills.py`。
  > 命名历史：`agent/tools/` 在 2026-06 前叫 `skills/`（名实不符，它本就是工具）；改名后 `skills/` 一词腾给上面的 prompt skills。`prompts/skills.md`（工具使用准则）后续将一并改名 `tools.md`。

#### `conversations.py`（读历史对话）

搜 / 读用户**过去的对话**（其他 session）：`search_conversations(keyword?)` 按关键词搜正文+标题、按 session 聚合；`read_conversation(session_id)` 读完整消息。**严格多用户隔离**（只查本人 session）。与记忆互补：记忆是提炼结论，这里是原文。

#### 发送文件给用户（UI artifact 旁路）

工具 `send_file` 走「工具 → 前端 UI」旁路（普通结果只回 LLM）：

```
send_file 返回 {..., _artifact:{file_id,name,ext,size}}
  → dispatch 抽出 _artifact → core 在 tool_done 后推 {type:'file', file:{...}}
  → web.py 透传前端（渲染下载卡片）+ 累积进 sent_files 随消息持久化（conversation_messages.files）
```

- 任何工具想给前端推 UI 元素都可走这条路（结果带 `_artifact`）。
- **IM 也真发文件**：`runner._collect` 收 `file` 事件 → `AgentResponse.files` → `worker._send_files` 按平台分发。
  - **飞书** `feishu.send_file`：图片 10MB / 文件 30MB，超限飞书返非 JSON 错误页撞 `JSONDecodeError` → 发前查大小、超限改文字。
  - **QQ** `qq.send_file`：C2C 富媒体上传（私聊支持、群聊不支持）。本地存储 base64 ~10MB 为界；OSS 走签名 URL 模式无体积限制（自动切换）。`msg_seq` 用 Redis `INCR qqseq:{msg_id}` 跨进程发号。
- ⚠️ 持久化依赖 `conversation_messages.files` 列（迁移 `20260623000001`）——部署后须 `make migrate`。

#### 接收文件（用户发文件给咕咕 · 暂存旁路）

web 上传 / 飞书 / QQ 发文件 → 咕咕能**看内容**（文本+PDF/Office）+ **存进文件库**。机制「先暂存、要存才落库」（`app/core/chat_attach.py`）：

```
上传字节 → StorageBackend(.chat_staging/) + 元数据 → Redis(TTL 6h)，拿 attach_id
  → resolve_for_message：① 增广文本（doctext 提取正文注入 LLM）② 前端文件卡片 ③ 图片块（vision 真看）
  → 用户说"存一下" → save_uploaded_file(attach_id) 落成正式文件
```

- kind：text / doctext.EXTRACTABLE（PDF·Word·Excel·PPT 提文本）/ image（vision 看）/ binary。
- ⚠️ `stage_sync`（飞书网关用）须独立线程跑 `asyncio.run`——lark handler 在运行 loop 里直接 `run_until_complete` 会 `RuntimeError`；QQ handler 本身 async 直接 `stage`。

#### 多模态看图（vision · `chat_attach` + `read_file`）

vision 模型（`ai.vision=True`）下咕咕真看图——聊天发的图 + 文件库的图：

- **聊天图**：`resolve_for_message` 封图片块随消息发（Anthropic `image` / OpenAI `image_url`）。
- **大图自动压缩**（`_fit_image_for_vision`）：>5MB 或长边 >2048px 时喂模型前等比降采样重压 JPEG（只压副本、存库原图不动）。
- **HEIC/HEIF**：`pillow-heif` 把 iPhone 原图等转 JPEG 再喂。
- `read_file` 读文件库图（仅 vision + Anthropic 通道）：图走 `tool_result` 图片块；持久化时 `strip_vision_for_history` 换 `[图片已查看]` 占位，避免大 base64 撑爆历史。**OpenAI 路工具结果只能纯文本、塞不了图片块，故 `read_file` 看图只在 anthropic 通道生效**——mimo 想让咕咕看库内图，需选 Anthropic 格式（聊天直接发的图两路都能看）。

#### `mcp/`

`client.py` MCP 协议客户端（stdio/SSE/HTTP）+ `registry.py` 动态加载外部 tools 注册为 skill，core 视其与 native 完全相同。**Phase 3，未做。**

### 出入口

#### `adapters/web.py`

Web SSE adapter：`stream()` 同步做配额检查 → 上下文 → 会话 get/create → 存用户消息，再把生成丢到**后台任务** `_generate()`（脱离 HTTP），自身只转发会话生成频道。

- **生成解耦 + 刷新续看**（`genstream.py`）：生成在后台跑，**浏览器刷新/断连杀不掉、回复不丢**。刷新后经 `GET /agent/sessions/{id}/stream`（`resume()`）先补已生成内容、再订阅后续。
  - **首条空气泡修复**：`stream()` 改为 `open_subscription()` **先 attach 订阅、再启动生成**——pub/sub 发完即弃，旧逻辑「先起生成后订阅」会把头几个 token（短回复时是全部）在订阅建好前发空 → 首条消息空气泡（快模型更易触发）。先订阅后，频道消息进连接缓冲不丢。
- **错误文案分类**：精力/配额「咕咕精力不足…」、网络「网络不太好 📡」、其他「开小差了 😵‍💫」；工具异常不在此（已在 dispatch 兜住）。
- **配额能力降级**：精力耗尽不再一刀切拦死，降级到只读工具集（13/53）+ 婉拒重操作，查询/对话照常（`profile.light_tool_names`）。
- **网页生成中排队**（`pendingQueue`）：流式中再发不丢，结束接力发；IM 天生排队（Redis 队列 + worker）。

#### `adapters/qq.py` / `feishu.py` / `supervisor.py`

QQ / 飞书 BYO 网关（botpy / lark-oapi WebSocket 长连）+ supervisor 网关管家。见「IM 接入」+ [`agent-im接入架构.md`](agent-im接入架构.md)。

#### `router.py`（轻量 Intent Router）

**网关入队前**的关键词+状态机路由，决定一条消息要不要进主模型：

- `classify(text)` → `progress / cancel / emotion / ack / agent`（纯关键词，整条匹配；取消/情绪只在短消息上判，**宁漏判进主模型、不误判短路**）
- `decide(text, state)` 结合 State Manager 状态出动作：`reply`（短路回话术，不入队）/ `cancel`（置取消标志）/ `drop`（忙时「嗯/好」忽略）/ `agent`（入队）
- 据状态回话术：THINKING→「还在想哦~~」SEARCHING→「正在查资料~~」GENERATING→「马上就好~」
- 将来可换小模型分类，`decide()` 接口不变。

#### `runtime_state.py`（State Manager）

IM 运行时状态机 + 取消标志，**跨进程共享走 Redis**（worker 写、网关读）：

- 状态 `IDLE/THINKING/SEARCHING/GENERATING/WAITING_CONFIRM`，key `agentstate:{platform}:{puid}`，**TTL 300s**（worker 崩了自动回 IDLE 防卡死）；worker `handle` 进入即 THINKING，core 据 `TOOL_STATE` 打细粒度。
- 取消标志 `agentcancel:{platform}:{puid}`：网关置、core 每轮协作检查命中即中断。
- **为什么状态放 Redis 给网关读**：IM 任务进行中后续消息排在队列里、worker 看不到，所以「还在吗/算了」必须由网关据此状态短路，进不了 worker。

#### `outbound.py`（IM 出口兜底）

IM 回复**发给用户/持久化前**的确定性清洗：小泄露（tool id、trace_id）抹掉，大泄露（系统提示词被复述，多为 injection 得手）整条换安全话术。只管字面泄露，语义泄露靠 policy.md。仅 IM 路（非流式好扫）。

#### 实时刷新（Redis pub/sub → SSE）

web 聊天或 IM 里改了数据、或 IM 来新消息，网页**自动刷新**。挂点是 `registry.dispatch`（所有工具执行的唯一咽喉，web/IM 共用）：

```
工具成功(改动型) → events.publish(uid, 资源)   # 按 RESOURCE_BY_TOOL 映射
IM 消息存下 → publish('sessions', appended=[用户消息])  # 先推
IM 回复完  → publish('sessions', appended=[助手消息])  # 再推
  → Redis PUBLISH events:{uid}（按用户隔离）→ GET /live/stream(SSE) 逐条下发
  → 前端 live store：bump rev[资源] → 各 store 重新拉；带 session_id 的 → GuguChat 追加气泡
```

- **细粒度分两次推**：用户消息先推（先看到发了什么）、回复完再推，呈现正常聊天节奏。
- **IM 会话标题**：`_schedule_title` 后台 fire-and-forget 起 ≤10 字标题、再异步推 `title` 事件，不阻塞回复。
- ⚠️ **新增改动型工具记得登记 `RESOURCE_BY_TOOL`**，否则改完网页不实时刷新。
- ⚠️ 推送 `events` 模块要 `as _evmod` 别名导入，否则覆盖 `run_collect` 里同名日历局部变量。
- 当前 web 自身聊天走 `web.py` 流式（自带刷新），未 publish → 同账号多标签不互相同步（将来让 web 也 publish 即可，链路现成）。

#### `events/`（事件总线 · 未做）

`bus.py` 异步事件总线 + `types.py` 事件类型（类而非字符串）。成就/行为分析/正反馈未来挂 Listener，Core 不耦合业务。**Phase 2b 未实现**（反思现直接在 web.py fire-and-forget，未走总线）。

### 配置

#### `profiles/`

`base.py` Profile 基类（skills / prompt_file / memory_enabled / mcp_enabled）。`default.py` 唯一会话 Profile（web/飞书/QQ 共用）：`skills=[projects,calendar,files,clients,trash,overview,memory,search,conversations]`、`memory_enabled=True`、`light_tool_names`（配额降级用只读集）。

> `im` skill（LLM 版 `react` 表情）已注册但**未进 default**（秒回表情走网关关键词）。早期 qqbot/mini profile 从未接线，已弃。

---

## 五、关键设计

### 用户个性化文件系统

> ⚠️ **本节是 Phase 2b 目标设计，非现状**。当前（2a）只落地 `facts.md` + `daily.md`；`identity.json`/`save_identity` 已作废（昵称用 `User.display_name`）；`facts.json` 结构化、`summary.md`、importance 分级、`weekly/` 层均未实现。

每个文件回答一个独立问题：

| 文件 | 回答的问题 | 由谁写 |
| --- | --- | --- |
| `prompts/persona.md` | 咕咕是谁？ | 开发者定义 |
| `facts.md`（现状） | 咕咕知道用户哪些客观事实？ | 咕咕观察 + 反思写入 |
| `daily.md`（现状） | 近期发生了什么？ | 反思滚动写入（最近 30 条） |
| `preferences.md`（2b） | 用户喜欢什么、习惯什么？ | 咕咕观察 |
| `memory.md`（2b） | 咕咕长期理解到了什么？ | Compressor 提炼 |
| `summary.md`（2b） | 用户现在在做什么？ | importance≥4 触发更新 |

- **信息来源严格区分**：用户主动提供的只有注册填的昵称（`User.display_name`）；其余习惯/偏好/状态全由咕咕对话观察积累，**不向用户提问、不让填表**——这是伙伴和助理的核心区别。
- **facts 更新策略（2b 目标）**：维护结构化 JSON（value/confidence/source：observed 用户说过的、inferred 行为推断的）；已有事实变化更新 value 不追加，避免脏数据。**现状（2a）直接 markdown 列表，去重靠内容包含判断**。
- **压缩定为 daily → memory 两段直压，无 weekly 中间层**（咕咕只需近期/长期两档）。

### 消息序列约束 · 前导 assistant 会被剥（sanitize）

发给 Anthropic/MiniMax 的消息序列**首条必须是 user**。`agent/sanitize.py` 的 `sanitize_messages`（`web.py` 组完 `anthr_messages` 后调）第 4 步据此 `while norm[0].role != "user": pop(0)`——把所有**前面没有 user 的前导 assistant 消息每轮丢掉**（连同孤儿 tool_result、空消息、相邻同角色合并一起清）。这是合法性约束，不是 bug。

**推论**：想让模型「看到」一条**不是用户发出**的 assistant 上下文（对话框默认问候、系统旁白、注入的伪助手发言），**别指望把它当历史里的前导 assistant 消息**——它会被剥掉，模型永远收不到。正确做法是**注入 system prompt**（或拼进某条 user 消息），保持序列 user 开头。

> **踩坑实例（默认问候）**：对话框默认问候用户回复后，曾把它入库为新会话首条 `assistant`（`created_at` 早于用户消息），指望模型看到「自己已打招呼」。结果 sanitize 每轮剥掉它，模型把用户的回复当成对话开头又重新寒暄。改法：`web.py` 在 `is_new_session and req.greeting` 时把问候拼进 system prompt（"你已经说过：「…」，别重复"）；DB 那条 assistant 仍留着只供会话回看显示。详见 `对话默认问候-生成方案.md` §4.2。

**排查提示**：遇到「模型无视某条历史消息」，先确认它在 `sanitize_messages` 之后是否还在（前导 assistant / 孤儿 tool 块 / 空消息都会被清掉）。

### 提醒工作流（Reminder Workflow）

> **架构决定（2026-06-24）**：定时任务结果**不进对话**，走独立链路投递到侧边栏通知弹窗 + IM。✅ 已落地。

- **不进对话**：`execute_task` 用 `run_ephemeral` 跑 agent——不建/不复用 session、不写 `conversation_messages`、不推 `sessions` 事件，结果不出现在任何聊天窗口。
- **统一走 agent**：无 `reminder` 类型，payload 始终经 agent 处理后再投递，咕咕用自然语气包装提醒。`action_type` 字段（reminder|agent|deadline_scan 遗留）已整列删除（迁移 `20260626000001`）——执行器本就不分支它。
- **两种创建入口**：`/schedules` 页面 UI，或**对咕咕说话**——`scheduled_tasks` 技能（`create/update/delete/list_scheduled_task`，见「工具清单」）让咕咕据自然语言生成 cron 直接建。
- **prompt 上下文注入消歧**：用户填的 payload 是面向自己的指令（「让我喝水」），裸传会让 `我` 指向歧义。触发时包裹：

```python
prompt = (f"[定时任务触发：{name}]\n现在是 {now}，用户设置了一条定时任务：{payload}\n"
          f"请以咕咕的身份完成这项任务，并将结果告知用户。")
```

- **执行链**：

```
APScheduler 触发 → execute_task → 构造上下文 prompt → run_ephemeral（静默后台）
  → 按渠道投递（用户勾选 web 通知 / 飞书 / QQ，各自独立）：
       web → events.publish(uid, notification={title,content}) → 铃铛弹窗 + 角标
       im  → _deliver_im(platform)：按平台 imreach 地址主动 DM（飞书可主动；QQ best-effort）
  → 试运行同步返回各渠道结果（已发送 / 无地址 / 失败）给用户看
```

- **多平台精确投递**：`imreach:{uid}:{platform}` 按平台存可触达地址（worker 收消息时记），投递时按渠道精确发、互不覆盖。详见 `app/scheduled_tasks.py` + [`CHANGELOG.md`](../CHANGELOG.md)。

### IM 接入（BYO + 动态网关）

> **完整方案见 [`agent-im接入架构.md`](agent-im接入架构.md)；飞书扫码细节见 [`feishu接入指南.md`](feishu接入指南.md)；拆解过程见 [`devlog.md`](devlog.md)。** 飞书/QQ/微信均**官方直连、不用 OpenClaw**；按「收消息 ↔ 跑大模型」解耦的**队列 + worker 架构**建。

- **BYO（Bring-Your-Own）**：每用户接自己的 bot，**扫码 device-flow 自动创建并连接**（飞书 RFC 8628 设备授权流 / QQ q.qq.com 绑定任务，复刻 QwenPaw，实测无需合作方资质）。凭据存 `user_bots` 表（用户级 CRUD，secret 打码）。早期「Admin 共享 bot + OAuth 绑定」已废，删了 `PlatformBinding`。
- **动态网关 · 进程级**（`adapters/supervisor.py`）：lark/botpy 连接只有 `start()`、**无 `stop()`** → 一个 bot 一个子进程，kill 子进程=断开。supervisor 每 5s 查 `user_bots` reconcile（增/删/崩溃自愈）；**凭据走环境变量注入**（不走 argv，避免 `ps` 泄漏 secret）。
- **认人 · owner 即归属**：bot 天然属于 owner → 网关入队 payload 带 `owner_user_id`，`worker._resolve_user` 直接用（省掉绑定表）。
- **运行模型 · 三进程**：`web`（API/SSE）+ `worker`（消费队列跑大脑）+ `supervisor`（管网关子进程）。
- **各平台**：飞书 ✅（lark-oapi WS）、QQ ✅（botpy WS，C2C 私聊，markdown msg_type=2 无权限回退纯文本）、微信 ⬜（iLink 个人号，封号风险高，最后做）。

### 并发模型

> **完整方案、分期与压测见 [`并发优化ROADMAP.md`](并发优化ROADMAP.md) + [`并发压测结果.md`](并发压测结果.md)。**

worker 已从串行 `for msg: await handle` 改为 **有界并发**（`Semaphore`，默认 16）+ **`user_gate(puid)` 按用户串行**（进程内 `asyncio.Lock`，同用户保序、不同用户并行，单机即终态）+ 优雅 drain + `msg_id` 去重（SETNX），实测 **~6×** 吞吐（串行 ~21 → 并发 ~190 条/分，带工具）；配 **⑦ 慢尾兜底**（429 退避重试）。瓶颈是 **LLM key 额度（单 key 安全并发 ≈16）**、非机器——再扩吞吐靠**多备 provider key**（总并发 ≈16×key 数，least_loaded 分流），多 worker 横向扩按埋点数据触发、暂不做。`并发治排队 · 多 key 治吞吐`。

---

## 六、工具清单（共 54，已实现）

> 下表领域工具，另加 `web`（`http_get`）、`meta`（`use_skill`）两个工具集（见「Tools 与 Skills」）；搜索为 `web_search`(SearXNG) + `deep_research`(Tavily) 两个，合计 54。

> 🔒 = 不可逆操作，受删除二次确认保底（显式 `confirm` 参数，`agent/confirm.py`）保护。所有工具带 `user_id` 所有权校验。

### 项目 · `tools/projects.py`（16）

| 工具 | 说明 |
| --- | --- |
| `list_projects` | 项目列表，可按状态筛选 |
| `create_project` | 新建项目，**可带 `stages` 一次建阶段+待办** |
| `update_project` | 改状态/起止日期/客户/备注/名称 |
| `get_project` | 单项目完整结构（阶段 + 各阶段待办） |
| `set_stages` | **声明式整体替换阶段**（增/删/改名/重排一步到位，同名阶段待办自动保留） |
| `update_stage` | 切当前阶段 / 勾选已有待办 |
| `add_stage` / `remove_stage` / `rename_stage` | 阶段增删改 |
| `add_todo` / `update_todo` / `remove_todo` | 待办增删改（`add_todo` 批量；`update_todo` 可移到别的阶段） |
| `set_priority` / `set_color` | 优先级 / 颜色 |
| `archive_project` | 归档 / 取消归档 |
| `delete_project` 🔒 | 永久删除项目 |

### 日历 · `tools/calendar.py`（4）

`create_event` / `list_events`（日期范围/类型）/ `update_event` / `delete_event` 🔒（无回收站，不可逆）

### 文件 · `tools/files.py`（14）

| 工具 | 说明 |
| --- | --- |
| `list_files` | 查询（空间/项目/扩展名/关键词） |
| `read_file` | 文本（≤256KB）直读 / PDF·Office 提文本 / **图片识别**（vision + Anthropic，含 HEIC，大图自动压缩） |
| `edit_file` | 改文本（整体替换/追加/查找替换） |
| `create_document` | md/txt/json/csv 直写；docx/pdf 由 HTML、xlsx 由 CSV 经 LibreOffice 转 |
| `rename_file` / `move_file` / `copy_file` | 重命名 / 移动 / 复制 |
| `delete_file` | 删除（进回收站，可还原） |
| `create_folder` / `list_folders` / `rename_folder` / `delete_folder` | 文件夹增删改查（删夹内文件移至根） |
| `send_file` | 给用户发可下载文件（见「发送文件」） |
| `save_uploaded_file` | 把暂存上传附件存进文件库（见「接收文件」） |

### 客户 · `tools/clients.py`（4）

`list_clients` / `create_client` / `update_client` / `delete_client` 🔒

### 回收站 · `tools/trash.py`（3）

`list_trash`（只列最近 50、不翻页，列满附"还有更多"提示）/ `restore_file` / `permanent_delete` 🔒（`file_id` 删单个，或 **`all=true` 一次清空整个回收站**——避免逐个删撞轮次上限）

### 聚合 · `tools/overview.py`（2）

`get_upcoming`（近期截止项目+日历合并，默认 7 天）/ `get_dashboard_stats`（项目按状态/事件/文件/客户计数）

### 记忆 · `tools/memory.py`（1）

`remember`：把一条关于用户的长期信息写进 `.agent/facts.md`（与反思共用 `merge_facts` 去重）

### 联网搜索 · `tools/search.py`（2）

- `web_search`：**通用搜索，走自建 SearXNG**（`settings.search.searxng_url`，免费、无配额、快）。返回标题+链接+摘要，适合找官网/文档/GitHub/事实/新闻标题。国内服务器只有 `sogou/quark/360search` 可达，固定带 `engines` 避开会超时的 google/bing。
- `deep_research`：**深度研究，走 Tavily**（`settings.search.tavily_api_key`，抓正文+清洗+给 answer），适合读+总结+比较+研究+给引用；受每日次数配额（`SearchUsage`）。
- 路由（见 `skills.md`）：普通查找走 web_search，读总结走 deep_research，SearXNG 超时/没结果由模型兜底转 deep_research。后台 Admin → Agent 可配两者并各带「测试」按钮（`/admin/config/test-search`）。

### 对话 · `tools/conversations.py`（2）

`search_conversations` / `read_conversation`：搜读用户**过去的对话**，严格多用户隔离

### 定时任务 · `tools/scheduled_tasks.py`（4）

`list_scheduled_tasks`（一次返回全部）/ `create_scheduled_task`（一次带齐 name+instruction+cron+channels，cron 由模型从自然语言生成、Asia/Shanghai，`@once:<ISO>` 一次性）/ `update_scheduled_task`（按 task_id 或**任务名 task** 定位，含启停）/ `delete_scheduled_task` 🔒（两步确认）。少调用：update/delete 按名字直接操作、无需先 list；**不进 `RESOURCE_BY_TOOL`**（单行写入、风险低，不触发自我核实那轮，省调用）。到点统一交 agent 执行 payload 并按渠道(web/feishu/qq)投递。

> 另：`im` skill 的 `react`（LLM 版飞书表情）已注册但**未进 default profile**（秒回表情走网关关键词）；站内全局搜索是顶栏 UI（`GET /api/v1/search`），**不是 agent 工具**。

### 工具一等公民（Profile 组合工具集，不再手抄工具名）

原 `DefaultProfile.tool_names` 手列工具名，与各工具集的 `Tool` 声明双重维护（漏一处静默失效）。已重构为：`registry` 增 `tools_of(...)`，`BaseProfile.skills`（工具集名列表，沿用旧字段名）+ `tool_names` 派生属性（去重保序）。新增工具 = 在对应工具集（`agent/tools/*.py`）加 `Tool` 声明 + handler（自动派生 Anthropic/OpenAI 双格式并注册），不可逆操作加 `destructive=True`。

---

## 七、现状与演进

> 分期/扩量权威 → [`并发优化ROADMAP.md`](并发优化ROADMAP.md)（P0–P4 + ①–⑨ + 压测）；变更逐条 → [`CHANGELOG.md`](../CHANGELOG.md)；决策过程 / 踩坑 → [`devlog.md`](devlog.md)；产品设计依据 → [`agent设计/`](agent设计/) 八份文档。

### 已落地能力一览

- **核心**：独立 `agent/` 包、双路 LLM 工具循环、47 工具、工具一等公民（Profile 组合工具集）、prompt 分层（persona/skills/policy）、删除二次确认、单次流式调用、token 预算历史窗口。
- **记忆（2a）**：`facts.md` + `daily.md` 两层，对话后 fire-and-forget 反思，`remember` 主动记忆。
- **IM 接入**：飞书 + QQ BYO 官方直连，扫码 device-flow 自动连接，三进程（web/worker/supervisor）。
- **运行时（Phase 1.7）**：轻量 Intent Router + State Manager（网关短路「还在吗/算了」，自然语言取消轮间中断）。
- **并发（P1）**：worker 有界并发 + `user_gate` + drain + 去重（~6×），⑦ 慢尾兜底，模型解析层多 key 分流（least_loaded）。
- **韧性/运维（P1/P2）**：配额能力降级（只读集），稳定 consumer 名 + 死 consumer 清理，服务状态页（三进程状态/PID/心跳/一键重启 + IM 队列水位）。
- **定时任务**：用户自定义任务 + 提醒工作流（结果走通知/IM 不进对话）。

### 关键架构决策

- **默认单机部署**：web+worker+supervisor+网关同机，一套 `.env`/override 管全部。瓶颈是大模型延迟非机器，一台远超 50 人才到头 → `user_gate` 进程内锁即**终态**，多 worker/分片 park。
- **BYO bot**：每用户自带 bot、扫码自动创建，bot 即归属 owner → 省掉绑定表 + OAuth。
- **配额「能力降级」而非硬切**：精力耗尽降到只读工具集，查询/对话照常。
- **不预造 Planner / 多 Agent**：当前 LLM 工具循环本身即轻量 planner；雄心路线常死在过早抽象，等出现具体「模型编排不了」的场景再加。
- **安全瘦身**：咕咕不跑 shell，不引入命令白名单/Docker 沙箱；「二次确认 + 审计 + 权限分级」即覆盖。
- **记忆刻意简化（2a）**：facts.md 而非结构化 JSON、两层而非三层、反思直接 fire-and-forget 不走 events 总线——结构化/分层压缩/summary/events 总线（2b）等数据量上来再做。

### 未做 / 按需（数据驱动，别提前）

- **记忆 2b**：`facts.json` 结构化、`summary.md` 快照、daily→memory 分层压缩、events 总线、控制命令（/newchat /forget …）。
- **扩展能力（Phase 3）**：MCP 外部工具、多 Profile 路由、🅼 小模型意图分类（需自托管 GPU）。
- **伙伴深化**：主动触达（异常沉默/情绪关注）、成就/正反馈系统、行为分析 Listener。
- **多 worker + 分片**：撞单进程 CPU 上限才上（届时 `user_gate` 换 Redis 锁，上层不动）。
