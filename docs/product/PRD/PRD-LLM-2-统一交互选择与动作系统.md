# 统一交互选择、动作与 Agent 事件系统

> 状态：协议骨架已开始实现，Round/Tool 展示与完整 Interaction Service 尚未开始
> 创建：2026-08-03
> 最近更新：2026-08-22
> 所属层：LLM / Agent 交互层
> 关联模块：`backend/agent/interactions/`、`backend/agent/core.py`、`backend/agent/runner.py`、`backend/agent/tools/base.py`、`backend/app/models/__init__.py`、`frontend/src/components/common/gugu-chat/`
> 平台适配：`backend/agent/gateway/qq.py`、Guguchat、网页、飞书
> 关联文档：[[【已完成】PRD-LLM-1-provider适配层重构与core瘦身.md]]；[[【已完成】PRD-IM-1-im接入稳定性与qq自建websocket.md]]；[[../../agent/22-IM用户数据结构.md]]

本 PRD 定义 Agent 在“需要用户输入后才能继续”时的统一交互协议。QQ Keyboard、Guguchat 按钮、网页弹窗和飞书卡片都是该协议的渲染与回调适配器，不在各平台内重复实现确认逻辑。

## 当前实现边界

当前只落地选择协议的薄骨架；QQ 身份绑定已改为独立的一次性验证码流程：

- `agent/selection/models.py` 提供 `SelectionPrompt`、`SelectionOption`。
- 网页端为当前用户的 QQ Bot 生成 6 位、10 分钟有效的一次性绑定码。
- 用户在 QQ 私聊机器人发送“绑定 6 位验证码”，网关校验后原子写入
  `owner_platform_user_id`；首次普通私聊不会自动获得 owner 权限。
- 绑定码只保存 HMAC 摘要，不把明文写入 Redis 或日志；验证码输入不进入 Agent。
- 暂不发送 Keyboard，不保存选择状态，不处理点击回调、过期和重复消费。

因此这不是完整选择系统，只是为后续 Keyboard 和 Guguchat 选择气泡提供稳定调用边界。

当前还已建立交互协议目录的骨架：

- `agent/interactions/events.py`：交互事件名和协议常量；
- `agent/interactions/stream_events.py`：SSE 事件编码/解析；
- `agent/interactions/confirmations.py`：确认凭证与确认交互入口；
- `agent/security/confirm.py`：保留旧导入路径的兼容入口。

这部分只整理协议边界，不改变现有 Agent Loop 的执行行为。

## 0. 目标与边界

### 0.1 目标

- 让 Agent 可以向用户提出选择题、确认题、补充问题和简单表单。
- 让用户点击选项后恢复原 Agent 任务，而不是把按钮点击当成一条普通闲聊。
- 统一处理动作的身份、会话、过期、重复点击、权限和业务执行结果。
- 支持自然语言输入作为按钮不可用时的兜底，但仍经过同一套动作校验。
- 让结果表达沿用用户语气设置和咕咕人设，不暴露内部 action ID、token 或状态枚举。
- 为 QQ Keyboard 铺路，同时让 Guguchat 成为第一等交互客户端。
- 让一次 Agent Run 内的 Round、工具调用和工具结果可被用户理解和回看。
- 让 Web、LoopScope 和 IM 复用同一份交互事件，不各自拼装一套工具调用状态。
- 在“接入咕咕”设置顶部提供统一的工具信息显示偏好，所有 IM 平台遵循同一个用户级设置。

### 0.2 不在本期范围

- 不把所有 Agent 回复都改成按钮或卡片。
- 不在本 PRD 内重新设计 IM 身份表、群成员权限或工具白名单；这些由 IM 文档和权限阶段负责。
- 不让平台适配器直接执行删除文件、修改项目等业务操作。
- 不假设所有平台都支持按钮；不支持时必须退回网页确认或自然语言输入。
- 不实现复杂多页表单、多人协同审批和跨用户投票。
- 不把每个 Round 拆成独立 HTTP 请求；一个用户请求仍然对应一个 Run。
- 不把 system prompt、动态上下文、用户附件路径、签名 URL 或完整工具 JSON 默认展示给用户。
- 不为 QQ、飞书、微信分别维护独立的工具显示开关；平台差异只影响展示能力，不改变用户偏好语义。

## 1. 交互类型

统一对象为 `InteractionPrompt`，由 Agent 或工具层创建：

```text
InteractionPrompt
├── kind: choice | confirm | question | form
├── title
├── body
├── options[]
├── fields[]
├── allow_text_input
├── session_id
├── expires_at
└── target
```

### 1.1 choice：选择

用于 Agent 不确定用户意图或存在多个合理方案时。

例：

- “你想按名称还是按修改时间排序？”
- “要放到哪个项目？”
- “使用 DashScope 还是 OpenAI 兼容接口？”

支持单选，后续再扩展多选。每个选项包含稳定的 `option_id`，显示文案和业务值分离。

### 1.2 confirm：确认/取消

用于已有明确动作但需要用户确认。

例：

- 删除文件
- 覆盖同名文件
- 清空回收站
- 绑定 QQ 身份

确认按钮不能替代工具的 `confirm` 参数、资源归属检查或 destructive 确认门。

### 1.3 question：补充问题

用于缺少必要参数时向用户提问。可以提供选项，也可以允许用户输入自然语言。

例：

- “截止日期要设为哪一天？”
- “你说的‘方案’是哪个文件夹？”

### 1.4 form：结构化输入

本期只支持少量字段：文本、数字、日期、单选。字段必须有服务端定义的类型、长度和合法值，不能把任意表单 JSON 直接交给业务层。

### 1.5 `ask_user`：模型主动询问

`ask_user` 是 Agent 可调用的内置交互工具，用于在多个合理路径之间无法安全推断，或缺少继续执行所必需的信息时，向用户发出结构化问题。它只创建交互，不直接修改业务数据；用户回答会作为原工具调用的结果返回给 Agent，随后继续同一个 Run。

#### 工具输入

```json
{
  "kind": "choice",
  "title": "选择处理方式",
  "body": "这张图片要保存到哪里？",
  "options": [
    {"id": "project", "label": "放入项目"},
    {"id": "folder", "label": "放入文件夹"},
    {"id": "cancel", "label": "取消"}
  ],
  "allow_text_input": false
}
```

约束如下：

- `kind` 复用 `choice`、`question`、`form`；普通二选一确认仍使用 `confirm`，不通过 `ask_user` 绕过 destructive 确认门。
- `title`、`body` 和选项文案由服务端限制长度；选项数量首版限制为 2～8 个。
- `option.id` 是短且稳定的标识，客户端只提交 action token 和 `option.id`，不提交完整业务参数。
- `allow_text_input=true` 时允许用户补充自然语言；文本仍需经过长度、内容和业务参数校验，不能直接当作已授权的操作参数。
- 模型不应在问题可以从上下文明确推断时调用该工具，也不应把普通闲聊或简单确认包装成选择器。

#### 适用边界

- **`confirm`**：动作明确但有破坏性或不可逆风险，例如清空回收站。
- **`ask_user(kind=choice)`**：下一步有多个合理分支，例如保存位置、目标项目或检索范围不同。
- **`ask_user(kind=question)`**：缺少一个必要信息，例如无法确定用户说的是哪个文件夹。
- **普通文本追问**：不需要按钮、且不涉及当前 Run 必须暂停的轻量澄清。

`ask_user` 不替代资源归属检查、工具参数校验或 `confirm` 确认门。任何业务写入必须在用户回答后重新执行权限和资源状态校验。

### 1.6 InteractionResult：回答回传

按钮回答和文本回答统一转换为受限的 `InteractionResult`，并作为 `ask_user` 的工具结果交给原 Agent，不创建一条无关的新用户消息：

```json
{
  "kind": "choice",
  "status": "selected",
  "prompt_id": 123,
  "option_id": "project",
  "value": "project",
  "text": null
}
```

文本回答示例：

```json
{
  "kind": "question",
  "status": "answered",
  "prompt_id": 123,
  "option_id": null,
  "value": null,
  "text": "放到旅行项目"
}
```

`status` 至少包括 `selected`、`answered`、`cancelled`、`expired`。客户端不得自行拼接业务结果；服务端负责把回答绑定到 prompt、session、用户和原始 tool call。

## 1.7 Agent Round 与工具事件展示

统一交互对象不仅包括“等待用户输入”的 Prompt，也包括一次 Run 内已经发生的 Agent 事件。Web 聊天和 LoopScope 应按 Round 展示，工具调用和工具结果不再伪装成普通助手文本。

### 展示结构

```text
用户消息
  └─ Run
      ├─ Round 1
      │   ├─ 助手中间文本
      │   ├─ 工具调用气泡
      │   └─ 工具结果气泡
      ├─ Round 2
      │   └─ 工具调用气泡
      └─ 最终助手回复
```

工具气泡默认只显示工具名、状态和耗时，点击后再显示经过脱敏、截断的参数摘要和结果摘要。最终助手气泡不得混入工具 JSON、内部调用 ID 或未发送给用户的中间旁白。

### 事件协议

现有 `_new_round`、`tool_call`、`tool_done` 继续兼容；新协议逐步补充稳定的 `run_id`、`round_id`、`tool_call_id` 和 `seq`：

```text
round_start
token
tool_call_start
tool_call_result
file
round_end
done
error
_cancelled
```

统一事件协议位于 `backend/agent/interactions/`，不放入业务资源事件总线。第一阶段继续使用 SSE，未来切换 WebSocket 时复用同一套 payload。

### 前端状态

```text
ChatRound
├── id
├── status: running | done | error
├── messages: ChatMessage[]
└── tools: ChatToolCall[]

ChatToolCall
├── id
├── name / label
├── status: running | success | error | cancelled | timeout | blocked
├── input
├── result
└── duration_ms
```

`useChatStream.ts` 负责按 `run_id + round_id + seq` 归档事件；`GuguChatMessageList.vue` 负责顺序和滚动；`GuguChatRound.vue`、`GuguChatToolBubble.vue` 负责展示。

### 多平台降级

| 平台 | 展示方式 |
|---|---|
| Guguchat/Web | Round 容器、可展开工具气泡、确认按钮 |
| LoopScope | 完整结构化事件、参数、结果和耗时 |
| QQ/飞书/微信 | 状态文本或平台卡片，按能力降级 |

平台不支持结构化交互时，必须退回自然语言确认；不能因为 UI 能力不足而阻塞 Agent 执行或绕过服务端确认门。

### 1.6 工具信息显示偏好

在“接入咕咕”设置区域顶部增加用户级设置：

```text
显示工具调用信息    [开 / 关]
```

设置语义：

- 开启：IM 展示 Round 状态、工具名称、执行状态和简短结果摘要；详细参数和完整结果仍需点击展开或通过 LoopScope 查看。
- 关闭：IM 不展示工具调用过程，只保留必要的“正在处理”状态和最终回复；确认按钮、错误提示和最终结果不受影响。
- 设置对当前用户生效，QQ、飞书、微信等所有 IM 会话统一使用。
- 设置变化只影响后续发送的交互事件，不改变已经发送的历史消息。
- 默认关闭，避免首次接入时把聊天界面变成调试日志。

建议字段名：`show_tool_interactions`。它属于用户偏好，不属于单个 `UserBot` 或平台连接配置。

## 2. 统一生命周期

```text
Agent / Tool 判断需要输入
        ↓
创建 InteractionPrompt 和一次性 actions
        ↓
当前任务进入 WAITING_INPUT
        ↓
平台渲染提示
        ↓
用户点击选项或发送文本
        ↓
解析为 InteractionResult
        ↓
校验身份、会话、token、过期时间和业务权限
        ↓
原子消费 action
        ↓
恢复 Agent / 执行 handler
        ↓
发送自然语言结果
```

### 2.1 Agent 状态

新增或复用 `WAITING_INPUT` 状态，语义与“正在思考/工具执行”不同：

- 当前任务没有失败，也没有继续执行。
- Agent 正在等待用户的选择或回答。
- 新的普通消息不能无条件覆盖等待中的 prompt。
- 取消、过期和用户明确改换话题时，必须结束旧 prompt。

### 2.2 中断和恢复

- 每个 prompt 绑定一个 Agent session 和一个 prompt 版本。
- 同一 session 只能有一个 active prompt；新 prompt 出现时旧 prompt 标记 `cancelled`。
- 用户回答后恢复原 session，而不是新建一轮无上下文的 Agent 请求。
- 任务已取消、超时或完成后，旧按钮点击只能得到自然语言提示，不得重新执行。

### 2.3 `ask_user` 暂停流程

```text
模型调用 ask_user
        ↓
服务端校验 schema、session、用户和当前 Run
        ↓
创建 Prompt/Action，持久化 WAITING_INPUT
        ↓
发送 interaction_required，当前 Run 立即停止继续调用模型
        ↓
用户点击按钮或提交文本
        ↓
校验 token、session、过期时间和回答内容，原子消费 action
        ↓
把 InteractionResult 作为 ask_user 工具结果注入原 Run
        ↓
恢复 Agent Loop，继续后续判断或工具调用
```

- 等待期间不得继续发送新的 LLM 请求或执行后续工具，避免回答尚未产生时抢跑。
- 同一 session 只允许一个 active prompt；重复调用和重复点击必须通过 `event_id`/action 状态幂等处理。
- 首版默认等待 10 分钟，服务端允许配置但不得超过 30 分钟；超时后向 Agent 返回 `expired`，由模型决定是否结束或重新提问。
- 用户取消、切换话题或提交不合法回答时，旧 prompt 必须结束，不能残留可执行按钮。
- Web、QQ 等平台只负责展示和提交回答，不能直接执行 `ask_user` 背后的业务动作。

## 3. 数据模型

### 3.1 InteractionPrompt

Prompt 可以先以内存/会话状态存在，跨进程和需要恢复的动作必须落库。业务上下文只保存引用，不保存聊天原文或上游响应。

```text
InteractionPrompt
├── id
├── session_id
├── gugu_user_id
├── bot_id                 # 可为空，网页 prompt 不一定经过 IM Bot
├── platform
├── chat_id
├── platform_user_id
├── kind
├── title
├── body
├── schema_json             # options / fields 的受限结构
├── status                  # active / resolved / expired / cancelled
├── expires_at
├── resolved_at
└── created_at
```

### 3.2 InteractionAction

每个可点击选项对应一个 action。按钮只携带不可猜测的短期 token，不携带完整业务参数。

```text
InteractionAction
├── id
├── prompt_id
├── token_hash
├── action_type
├── option_id
├── context_json            # file_id/project_id 等业务引用
├── status                  # pending / consumed / expired / cancelled
├── expires_at
├── consumed_at
├── created_at
└── consumed_event_id       # 平台事件去重
```

约束：

- 数据库只保存 token hash，原始 token 只在渲染时短暂使用。
- action 默认有效期不超过 10 分钟，具体场景可以更短。
- 消费必须是原子条件更新：`status=pending AND expires_at > now`。
- 校验失败不能改变新 action 的状态。
- `context_json` 不得保存密钥、完整用户消息、文件正文或未脱敏上游响应。

### 3.3 InteractionResult

所有入口统一转换为：

```text
InteractionResult
├── prompt_id
├── action_id
├── option_id
├── text_input?
├── source: button | text | web
└── event_id?
```

业务 handler 只接收经过校验的结果，不直接解析 QQ、网页或飞书 payload。

### 3.4 工具显示偏好的读取边界

Agent 执行仍然产生完整的结构化工具事件；显示偏好只在出站渲染层生效：

```text
Agent Loop 产生完整事件
        ↓
Interaction renderer 读取用户偏好
        ├─ show_tool_interactions=true  → 展示工具摘要/状态
        └─ show_tool_interactions=false → 过滤工具展示，保留最终回复/必要错误
```

不能在 Agent Loop 内根据这个偏好跳过工具调用，也不能因为关闭展示而删除工具历史、影响缓存或改变工具执行结果。

## 4. 模块结构

建议新增：

```text
backend/agent/interactions/
├── __init__.py
├── events.py              # Round/Tool/Prompt 事件名和协议常量
├── stream_events.py       # SSE 编码/解析，未来可复用于 WebSocket
├── confirmations.py       # 确认凭证与确认交互协议入口
├── models.py              # Prompt、Action、Result、状态枚举
├── service.py             # 创建、签发、校验、消费、取消、过期
├── registry.py            # action handler 注册与路由
├── agent_bridge.py        # WAITING_INPUT、恢复和取消
└── gateway/
    ├── base.py            # 平台无关渲染/回调接口
    └── qq.py              # QQ Keyboard payload 与 interaction event

frontend/src/components/common/gugu-chat/
├── interactions/
│   ├── interactionTypes.ts # Prompt/Action/Round/Tool 类型
│   ├── ChatRound.vue       # Round 容器
│   ├── ChatToolBubble.vue  # 工具调用/结果气泡
│   ├── ChatConfirmation.vue
│   └── ChatChoicePanel.vue
└── composables/useChatStream.ts # 事件归档与恢复去重
```

边界：

- Agent/工具层只描述交互意图和业务引用。
- `InteractionService` 负责安全生命周期，不负责发消息。
- `registry` 根据 action type 找业务 handler，但 handler 必须再次做权限和资源归属检查。
- 平台 adapter 只做 payload 转换、回调解析和结果发送。
- Guguchat/web 前端可以直接使用同一 API，不应复制一套确认状态机。
- `core.py`、`runner.py` 负责 Agent 执行与事件产生，不负责前端气泡布局。
- `gateway/web.py`、`gateway/*.py` 负责传输和平台能力适配，不重新定义事件语义。

## 5. 平台适配

### 5.1 Guguchat

Guguchat 是优先适配端：

- Prompt 以气泡内的选择项、确认按钮或输入控件呈现。
- 选择结果通过现有聊天 API 提交 `prompt_id + action_token`。
- 交互期间气泡保持可见，状态文字可以从“正在等待选择”更新为“已选择”。
- 页面刷新后，仍可从 active session 恢复未过期 prompt。

### 5.2 网页

- 复用现有弹窗和普通提示组件。
- destructive 操作优先使用网页确认弹窗。
- 网页直接使用统一 action handler，不绕过服务端 token 校验。

### 5.3 QQ Keyboard

QQ 是 Guguchat 之外的第一个 IM adapter：

```text
InteractionPrompt
  → QQ Keyboard message payload
  → QQ WebSocket interaction event
  → action_token 校验
  → InteractionResult
  → handler / Agent resume
```

实现约束：

- 不在 QQ adapter 内写绑定、删除或项目业务逻辑。
- 点击者必须匹配 prompt 绑定的 `platform_user_id`。
- interaction event 必须使用平台 event ID 去重。
- 真实 QQ event 字段以开发环境抓到的 payload 为准，先固定样本再实现解析。
- 若当前 Bot 或消息类型不支持 Keyboard，回退到 Guguchat/网页或自然语言确认。

### 5.4 其他平台

| 平台 | 适配方式 |
|---|---|
| 飞书 | 消息卡片按钮回调，复用 action token |
| 微信 | 网关支持按钮时接入；否则网页或文本兜底 |
| QQ | Keyboard + WebSocket interaction event |
| Guguchat | 内嵌选择气泡和表单 |
| Web | 弹窗、下拉和确认组件 |

所有 IM adapter 在渲染工具事件前读取同一个用户级 `show_tool_interactions` 偏好；不得各自缓存一份长期配置。短时缓存失效后应重新读取，确保设置变更能逐步生效。

## 6. Agent 与工具接入

工具不直接拼平台消息，只声明交互需求：

```text
raise InteractionRequired(
  kind="confirm",
  title="删除文件",
  body="确定删除这个文件吗？",
  options=[confirm, cancel],
  context={"file_id": file_id},
)
```

Agent bridge 负责：

1. 创建 prompt/action。
2. 把任务置为 `WAITING_INPUT`。
3. 调用当前平台渲染器。
4. 接收并校验 InteractionResult。
5. 恢复原任务或结束任务。

破坏性工具仍必须：

- 标记 `destructive=True`；
- 引用现有确认门；
- 执行时使用 `get_owned()` 和权限检查；
- 依赖幂等键避免重复副作用。

按钮确认只是输入渠道，不是安全边界。

## 7. 自然语言与兜底

当按钮不可用或用户直接回复文字时：

- 先在当前 session 查找 active prompt。
- 只有文本能无歧义映射到选项时才自动消费。
- “好”“那个”“可以”等模糊回答继续追问，不猜测业务选择。
- 过期 prompt 不执行，并用符合人设的方式提示用户重新开始。
- 用户明确换话题时，旧 prompt 标记取消，普通消息进入新的 Agent 回合。

## 8. 隐私、安全与可观测性

- 日志只记录 prompt/action 类型、状态、trace ID 和脱敏指纹。
- 不记录原始 token、完整按钮 payload、聊天正文或文件名。
- 可见错误经过 `redact()`；原始异常只进入受限诊断出口。
- 所有跨用户资源操作继续走 ownership 校验。
- 绑定 QQ 身份遵循 IM 用户数据结构文档；Keyboard 不自动发现未知身份，也不决定群成员权限。
- 同一 event 重复投递只能得到同一结果，不能重复执行 handler。

## 9. 实施阶段

| 阶段 | 状态 | 内容 |
|---|---|---|
| Phase 0：协议和状态定义 | ✅ | 确定 choice、confirm、question、form、WAITING_INPUT 和统一结果结构。 |
| Phase 0.5：交互协议骨架 | ✅ | 已实现 `agent/interactions/` 的事件/确认入口和 QQ `platform_user_id` 注册动作；Keyboard 仍留给后续平台适配阶段。 |
| Phase 1：Round/Tool 流式事件 | ✅ | `round_start`、兼容 `_new_round`、`tool_call`、`tool_done` 和 `interaction_required` 携带 `run_id/round_id/tool_call_id/seq`，旧客户端仍可消费旧事件名。 |
| Phase 2：Interaction Service | ✅ | 建立 Prompt/Action 表和迁移，实现 token hash、创建、列表、过期校验、原子消费和 event_id 幂等字段。 |
| Phase 3：Agent Bridge | ✅ | Agent Loop 将工具确认结果桥接为统一交互事件；按钮消费服务端 token 后复用现有会话发送链恢复下一轮，切会话/刷新可通过 active prompt 列表恢复。 |
| Phase 4：Guguchat/Web | ✅ | 工具调用作为独立消息气泡展示，支持展开输入/结果；确认事件展示按钮并提交统一 API，保留原有状态气泡和流式正文。 |
| Phase 5：统一显示偏好 | ✅ | “接入咕咕”设置顶部增加 `show_tool_interactions`；统一 `AgentResponse.interactions` 出口，IM 默认关闭展示且不影响工具执行。 |
| Phase 6：QQ Keyboard | ✅ | 增加 QQ action payload 编解码、嵌套 interaction event 解析和回调消费；未确认 QQ 原生按钮字段前使用安全文本兜底，不宣称平台已支持原生 Keyboard。 |
| Phase 7：业务接入 | ✅ | QQ 身份绑定沿用既有 owner 校验；所有注册表 `destructive` 工具的 `needs_confirm` 统一桥接 Prompt/Action，按钮/文本确认复用原 session，非 destructive 结果不会生成危险交互。 |
| Phase 8：其他平台 | 🔲 | 飞书卡片、微信或其他平台按能力逐步适配。 |
| Phase 9：`ask_user` 工具协议 | 🔲 | 注册内置工具，完成 choice/question/form 的 schema 校验、长度限制和统一 `InteractionResult`。 |
| Phase 10：暂停与恢复 | 🔲 | 接入 `WAITING_INPUT`，保存 pending Run，回答后原 session 原地恢复；补齐超时、取消、重复点击和服务重启恢复。 |
| Phase 11：多端展示 | 🔲 | Web 使用按钮/输入框交互，IM 使用平台能力或文本兜底；统一权限校验、脱敏和历史展示。 |

每个阶段单独提交。任一阶段出现生命周期或权限行为差异，不进入下一阶段。

## 10. 测试与验收

### 10.1 自动测试

- 流式事件编码/解析 round-trip，`run_id`、`round_id`、`tool_call_id` 和 `seq` 保持不变。
- 同一 Run 的多 Round、多工具调用按序归档；并发 Run 不串线。
- 工具开始、完成、失败、取消和超时更新同一个工具气泡。
- 切换 Session、刷新页面和恢复流式生成不会重复创建 Round 或工具气泡。
- `show_tool_interactions` 开启/关闭时，所有 IM 使用一致语义；关闭只影响展示，不影响工具执行和历史记录。
- Prompt 创建、过期、取消和重复消费。
- 错误用户、错误 Bot、错误会话和错误群不能消费 action。
- token 只保存 hash，日志不泄露 token 或聊天原文。
- 并发点击同一 action 只有一次 handler 执行。
- Agent 进入 `WAITING_INPUT` 后能恢复原 session。
- 用户直接输入可正确映射，模糊输入不会误执行。
- Guguchat/Web payload 与统一模型双向转换。
- QQ Keyboard payload 和 interaction event 使用固定样本解析。
- destructive handler 仍经过确认门、ownership 和幂等检查。
- `ask_user` choice：模型调用后只生成一个 active prompt，回答前不再产生后续 LLM/tool 调用。
- `ask_user` button：点击后只消费一次 action，并在原 session 中收到结构化 `InteractionResult`。
- `ask_user` text：允许文本时能恢复原 Run；超长、越权或无法解析的文本不会被当作已确认参数。
- `ask_user` timeout/cancel：过期或取消后不能执行原动作，模型收到对应状态。
- `ask_user` reduction：问题可以从上下文确定时不生成 prompt；destructive 操作仍走 `confirm`。

### 10.2 人工验收

1. 一次多工具、多 Round 请求按 Round 顺序显示，工具调用不混入最终回复气泡。
2. 点击工具气泡可以查看脱敏后的参数和结果摘要。
3. Agent 对不确定问题展示选项，点击后继续原问题。
4. 点击确认/取消不会创建一条无关的新聊天任务。
5. 刷新 Guguchat 页面后，未过期的选择仍可继续。
6. 用户直接回复自然语言时，能正确选择或继续追问。
7. 过期按钮不会执行操作。
8. 其他用户点击按钮不能触发原用户的动作。
9. QQ Keyboard 成功发送、点击回调和重复点击均符合预期。
10. QQ 不支持按钮时能进入网页或文本兜底。
11. 删除文件确认取消后文件不变，确认后只执行一次。
12. 成功、失败和部分成功结果符合用户语气设置，不暴露内部 action 名称。
13. 在“接入咕咕”设置顶部关闭工具信息后，QQ、飞书、微信都不再展示工具过程，但最终回复和确认消息仍正常发送。
14. 重新打开设置后，工具信息恢复展示；已经发送的历史消息不被重写。
15. Agent 需要在多个合理路径中选择时展示 `ask_user` 按钮；回答后继续原任务，而不是新建无关对话。
16. 用户直接输入补充信息时，`allow_text_input` 为真才允许恢复；错误回答不会触发工具执行。

## 11. 待确认问题

- QQ Keyboard 使用模板键盘还是自定义键盘；需要先保存真实 interaction event 样本。
- Guguchat 选择气泡是否支持多选和输入框，第一版先按单选/确认实现。
- Agent 等待输入的最长保留时间，以及服务重启后的恢复策略。
- 一个 prompt 是否允许多个平台同时显示；默认只允许一个主平台，其他平台显示失效提示。
