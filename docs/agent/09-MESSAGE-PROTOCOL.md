# Agent 消息协议

> 本文描述当前 Agent 的消息、流式事件、工具事件、交互请求、附件和引用协议。协议分为 canonical history、Agent stream event 和渠道出站 parts 三层；三层不能互相替代。

## 1. 三层协议边界

```text
平台原始消息
    -> PlatformMessage
    -> AgentRequest / Context
    -> canonical history
    -> Agent stream events
    -> PlatformReply parts
    -> 平台 wire message
```

### Canonical history

canonical history 是持久化和跨 Provider 恢复的语义事实源，保存用户消息、助手消息、工具调用、工具结果、引用、附件以及必要的运行时上下文块。Provider 私有 reasoning state 使用独立受保护存储，仅在匹配的 `owner_user_id + session_id` 和 Provider boundary 恢复；它不进入 canonical history、RAG 或渠道展示。它不等于某次 SSE 输出，也不等于某个平台最终显示的气泡。

推理状态的 LoopScope 诊断只表示 run 生命周期状态、Provider/API/模型标识、状态计数、大小、版本和
digest；`payload`、thinking 正文、签名、用户正文和完整工具参数禁止进入消息协议或诊断快照。

### Agent stream event

stream event 是一次 Run/生成期间的实时事件。Web 前端用它增量渲染，IM 用它发送工具进度或收集各 Round 文本。事件可能只存在于运行时，例如 token、交互 token 和内部进度，不应全部写入历史。

### PlatformReply

`PlatformReply` 是出站适配前的平台无关回复，包含目标、parts、回复关联 ID 和能力声明。QQ、微信、飞书根据各自能力把它转换为平台消息；平台消息的分段、卡片和 mention 语法不改变 canonical history。

## 2. 入站消息

`backend/agent/im/models.py` 的 `PlatformMessage` 是 IM 网关的统一入站结构：

| 字段 | 语义 |
|---|---|
| `platform` | `qq`、`wechat` 或 `feishu` |
| `bot_id` | 当前 bot/渠道配置 ID |
| `message_id` | 平台消息或事件 ID；微信兼容使用 `context_token` |
| `chat` | `ChatTarget(id, type)`，内部 type 为 `group` 或 `c2c` |
| `sender` | `PlatformSender(id, name)`，ID 是稳定平台身份 |
| `content` | 当前消息正文，不包含引用原文 |
| `attachments` | 当前消息附件元数据列表 |
| `quoted_text` | 被引用消息正文，单独字段 |
| `mentioned` | 当前消息是否明确 @ bot |
| `received_at` | 平台接收时间，如有则保留 |
| `metadata` | 平台特有但尚未被共享 Loop 消费的字段 |

`normalize_payload()` 负责兼容旧网关 dict。归一化必须保留 owner、平台用户、群、引用、附件和平台特有字段；私聊不应为了统一形状强行添加 `chat_id`，否则会改变会话路由。

入站消息还会携带 `owner_user_id`、`platform_user_name`、`platform_bot_user_id`、`context_token`、`trace_id`、群聊策略和消息格式等 Loop 字段。这些字段用于身份、路由、权限和平台发送，不应交给模型自由修改。

## 3. 用户消息与附件

### 3.1 正文边界

- `content`/`text` 只表示用户自己发送的正文。
- 引用原文写入 `quoted_text`，模型上下文通过统一的 quote block 注入；网页展示也独立显示引用块。
- QQ、微信的引用附件保留 `quoted=true`、来源消息 ID 和附件序号等 provenance，不能把引用媒体当作当前用户重新上传的附件。微信 iLink 当前不能通过 `ref_msg` 还原普通文字引用原文，只能读取平台提供的摘要，或写入明确的“不支持消息引用识别”占位；图片、文件等引用媒体仍可识别和暂存。
- 空正文但有有效附件时，消息仍然有效；只有正文、引用和附件全部为空时才丢弃。
- 语音转写属于当前消息正文语义；平台未能转写时保留明确的失败提示，不静默伪造文本。

### 3.2 附件生命周期

```text
平台媒体
    -> 下载/解密/暂存
    -> attach_id + 元数据
    -> AgentRequest.attachments
    -> 模型媒体内容或附件引用
    -> 消息持久化并 claim
    -> 工具/最终回复发送
```

Web 上传和 IM 媒体都先形成用户归属的 attachment 元数据。消息落库时要在同一语义事务中 claim 附件，避免附件已被清理但消息仍声称拥有它。模型使用的图像/文件内容与历史展示引用分开：history 保存最小引用和类型信息，Provider 适配器在需要时生成对应 content block。

### 3.3 出站文件

模型通过统一文件结果声明要发送的文件，`agent.im.files` 负责读取元数据和存储，`agent.im.replies.send_file()` 只负责按平台选择发送函数。各平台有不同文件/图片大小和类型限制；失败必须返回失败状态或用户可见的通用说明，不能先发“已发送”。

## 4. 流式事件协议

事件常量定义在 `backend/agent/interactions/events.py`，编码由 `backend/agent/interactions/stream_events.py` 统一处理。当前 Web 兼容格式是：

```text
data: {"type":"token","content":"..."}

```

每条事件是一个 JSON 对象，必须包含 `type`；事件中的 `run_id`、`round_id`、`tool_call_id` 和 `seq` 用于关联和排序，存在时应原样透传。`decode_event()` 对非 `data: `、空内容和非法 JSON 返回空结果，不应让单条坏事件击穿整个流。

### 4.1 当前事件类型

| 事件 | 作用 | 是否默认进入 history |
|---|---|---:|
| `session_id` | Web 首次建立/确认会话 | 否，作为客户端路由信息 |
| `session_goal` | 当前会话目标状态 | 否，状态查询结果 |
| `round_start` | 新 Round 开始 | 作为运行边界，不直接展示 |
| `_new_round` | 兼容旧链路的 Round 分隔符 | 否，收集器用它切分文本 |
| `round_end` | Round 结束 | 运行元数据，历史由 canonical 记录 |
| `token` | 增量文本片段 | 仅在最终文本持久化后进入 history |
| `tool_call_start` / `tool_call` | 工具开始或兼容工具事件 | 以 canonical tool call 保存 |
| `tool_call_result` / `tool_done` | 工具结果或兼容完成事件 | 以 canonical tool result 保存 |
| `interaction_required` | 需要用户确认/选择/补充 | 保存为交互等待状态，不保存 token |
| `file` | Agent 要发送或关联的文件 | 以附件/文件结果保存 |
| `error` | 本轮或 Run 失败 | 保存失败状态，不当作成功助手正文 |
| `done` | 流结束 | 否，最终状态和助手消息已持久化 |
| `_cancelled` | 用户或系统取消 | 保存取消状态，不补发正常完成消息 |

旧事件名仍用于兼容 Web/IM：`_new_round`、`tool_call`、`tool_done` 和 `_cancelled`。新增事件优先在常量文件登记，不在 Provider、Gateway 和前端分别散落字符串。

### 4.2 文本收集规则

`agent.runner._collect()` 按 `_new_round` 分隔文本，得到 `round_texts`；兼容字段 `text` 仍取最后一个非空 Round。规则如下：

- token 只能追加到当前 Round；不能跨 `_new_round` 拼接。
- 空 Round 不发送，也不产生空的 IM 消息。
- 工具结果后如果续轮没有真正开始，不能把上一轮的过程文本伪装成最终成功回复。
- Web 可实时显示 token，但最终内容以数据库持久化的助手消息为准。
- IM 发送层按 `round_texts` 独立发送，避免多个 Round 在平台侧堆积成一条消息；已经通过回调发送的 Round 由 `already_sent_rounds` 去重。
- 附件发送失败提示不属于 Round 文本索引，不能因为对应 Round 已发送就吞掉失败提示。

## 5. 工具事件

工具事件必须至少能关联 `run_id`、`round_id`、`tool_call_id`、工具名和状态。共享语义是：

```text
tool_call_start / tool_call
    -> 参数解析与 Schema 校验
    -> 权限与 ownership 校验
    -> destructive confirmation（如需要）
    -> tool execution
    -> tool_call_result / tool_done
    -> 下一 Round 或最终收束
```

- 工具调用和工具结果必须成对保存，结果不能脱离对应调用独立进入 Provider history。
- 工具输入参数属于内部执行事实；IM 展示默认使用受限摘要，不能把完整敏感参数直接发给用户。
- Web 可展示结构化工具轨迹；QQ 纯文本模式只展示完成、等待确认或失败状态，避免把 Markdown/Schema 原样打到聊天中。
- 工具进度消息是出站展示，不替代工具结果；没有真实回执时不得发送“已完成”。
- 工具结果失败仍需进入 canonical history，使模型能够修正或向用户说明失败原因。
- 同一 `tool_call_id`、`run_id` 和 `round_id` 的重复事件不得重复执行工具；重放只允许恢复展示状态。

工具事件顺序由 `seq` 和收集顺序共同约束。跨 Round、跨 Run 的事件不能合并到同一个 IM 进度消息。

## 6. 交互协议

`ask_user`、危险操作确认和部分平台按钮都归一为 `interaction_required`：

```json
{
  "type": "interaction_required",
  "prompt_id": 17,
  "kind": "confirm",
  "title": "确认操作",
  "body": "...",
  "options": [{"id": "confirm", "label": "确认", "token": "服务端短期凭证"}],
  "expires_at": "...",
  "run_id": "...",
  "round_id": "...",
  "tool_call_id": "..."
}
```

协议约束：

- token 是一次性、短期、服务端可验证凭证，不能写入普通日志、模型历史或 URL。
- 服务端消费时重新校验用户、平台、会话、原工具调用和过期时间；成功消费后立即失效。
- Web 使用交互 API 恢复同一个 Run；QQ 优先使用 Inline Keyboard，飞书优先使用卡片，微信和不支持原生按钮的平台使用文本选项。
- 文本降级必须提供可回复的选项序号或选项文字，不能显示“请在网页点击”这类当前平台无法执行的提示。
- 交互等待期间 Run 暂停；交互回复应走快速消费路径，不能被原会话锁阻塞到过期。

## 7. Web 流与 IM 出站的差异

### Web

- `POST /api/v1/agent/chat` 返回 `text/event-stream`。
- 生成任务脱离 HTTP 请求运行，浏览器断开后任务仍可完成；刷新页面通过 `/sessions/{id}/stream` 续看。
- 续看先补发当前快照中的文本、文件和工具准备状态，再订阅后续事件；若无运行任务立即返回 `done`/`idle`，客户端回数据库加载完整历史。
- Web 的资源实时更新使用独立的 `/api/v1/live/stream` 和 `live-event-v1`，不与 Agent token 流混用。

### IM

- IM worker 不把 token 逐字发送到 QQ、微信或飞书；统一收集 Round 文本、工具事件、交互和文件后按平台能力发送。
- 慢工具可先发送工具状态，最终回复仍需等 Run 的真实结果。
- 目标由当前 IM Context 决定：群发到 `chat_id`，私聊发到 `platform_user_id`；不能由模型输出覆盖。
- QQ mention、飞书卡片和微信 `context_token` 只存在于平台适配层；普通正文和 canonical history 不应保存平台 wire 标签作为唯一语义。

## 8. Canonical history 结构

历史恢复由 `agent.context.history` 和 `agent.context.canonical_context` 负责。稳定原则如下：

- 普通 user/assistant 文本保持原有 role 和顺序。
- 引用作为 quote block/`quoted_text` 恢复在对应 user 消息前后固定位置，不拼写进用户正文。
- 附件使用最小 attachment reference，Provider 需要时再转换为媒体 content block；历史恢复不能把临时下载 URL 当作永久事实。
- OpenAI、Anthropic 等 Provider 的 tool call/tool result wire format 可以不同，canonical tool block 必须保持同一调用 ID、参数对象、结果和顺序。
- 历史中的 `knowledge-context`、`tool-schema`、`skill-schema`、`time-context` 和 `runtime-context` 等结构化块不能随意转成普通文本，否则会破坏下一轮的消息边界和缓存前缀。
- thinking/reasoning 是否发送给 Provider 由配置和适配器决定；不应把内部思考泄漏到用户消息或普通历史展示。
- 旧历史格式由 Provider boundary 做兼容转换；兼容逻辑不能重新定义新的 canonical 语义。

## 9. 错误、取消与重连

- 非法事件只丢弃该事件并记录脱敏诊断，不能让整个订阅任务崩溃。
- `error` 表示本次执行未正常完成；客户端不能因为已经收到部分 token 就把它当作成功。
- 取消后停止后续模型/工具处理，发送取消结果或结束事件，不补发旧的最终文本。
- Web 重连以 session snapshot、事件订阅和数据库最终历史为准；SSE 本身不保证补发全部历史 token。
- IM 入站使用 Redis Stream 幂等和 ack；出站发送只对明确瞬时错误有限重试，非幂等平台消息不能无限重放。
- 附件发送、卡片发送或 mention 发送失败时，错误状态必须与普通文本回复区分，不能伪造一个完整成功结果。

## 10. 安全与日志

- 事件 payload 不得携带 token、API key、bot secret、完整附件 URL 或未脱敏用户内容到普通日志。
- 日志只记录事件类型、长度、状态、耗时、计数和 fingerprint；原始异常进入受限诊断出口。
- 工具参数、引用正文和附件名不能因为格式化成 JSON/Markdown 就绕过日志脱敏。
- 用户可见错误通过统一 redaction 处理；内部错误码、Provider 原始响应和平台凭据不直接返回。
- 每个消息和事件都应保留 owner、platform、bot、chat scope 的服务端关联，避免跨用户、跨群或跨 bot 重放。

## 11. 测试与修改边界

| 范围 | 代表测试 |
|---|---|
| 事件编码/解码和稳定事件名 | `test_interaction_events.py`、`test_interaction_protocol.py` |
| Round 文本、工具事件和多 Run 隔离 | `test_runner_collect.py`、`test_core_loop_characterization.py` |
| canonical history 和 Provider 转换 | `test_context_history.py`、`test_history_persist_filter.py` |
| 引用、附件归属和媒体 | `test_context_history.py`、`test_chat_attachments_ownership.py`、`test_wechat_quotes.py` |
| IM reply parts、平台能力和降级 | `test_im_protocol.py`、`test_im_replies.py`、`test_feishu_interactions.py` |
| QQ mention、文件和群消息 | `test_qq_raw_send.py`、`test_qq_raw_ws.py`、`test_qq_group_history.py` |

修改协议时，优先修改 `agent/interactions/events.py`、`agent/interactions/stream_events.py`、`agent/im/models.py` 或 `agent/im/replies.py` 的共享边界，再补 Web、IM 和平台适配测试。不要只在某个 Gateway 中新增同名事件或绕过 `PlatformReply` 发送。

## 12. 当前限制

- 流式传输当前仍以 SSE 文本帧为主；协议事件已经抽出编码常量，但 Web/IM 尚未统一为同一种网络连接。
- 部分兼容事件仍使用下划线旧名称，新代码应优先使用稳定常量并保持旧消费者可读。
- IM 平台不能完全对称展示 token、工具输入、键盘和文件；“语义一致”不等于“字节一致”。
- canonical history、实时事件和平台展示之间仍需持续增加端到端重连、重复事件、附件失败和多 Round 出站回归测试。
