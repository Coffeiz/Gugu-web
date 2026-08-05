# 统一交互选择与动作系统

> 状态：协议骨架已开始实现，完整 Interaction Service 尚未开始
> 创建：2026-08-03
> 最近更新：2026-08-03
> 所属层：LLM / Agent 交互层
> 关联模块：`backend/agent/runner.py`、`backend/agent/tools/base.py`、`backend/app/models/__init__.py`
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

## 0. 目标与边界

### 0.1 目标

- 让 Agent 可以向用户提出选择题、确认题、补充问题和简单表单。
- 让用户点击选项后恢复原 Agent 任务，而不是把按钮点击当成一条普通闲聊。
- 统一处理动作的身份、会话、过期、重复点击、权限和业务执行结果。
- 支持自然语言输入作为按钮不可用时的兜底，但仍经过同一套动作校验。
- 让结果表达沿用用户语气设置和咕咕人设，不暴露内部 action ID、token 或状态枚举。
- 为 QQ Keyboard 铺路，同时让 Guguchat 成为第一等交互客户端。

### 0.2 不在本期范围

- 不把所有 Agent 回复都改成按钮或卡片。
- 不在本 PRD 内重新设计 IM 身份表、群成员权限或工具白名单；这些由 IM 文档和权限阶段负责。
- 不让平台适配器直接执行删除文件、修改项目等业务操作。
- 不假设所有平台都支持按钮；不支持时必须退回网页确认或自然语言输入。
- 不实现复杂多页表单、多人协同审批和跨用户投票。

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

## 4. 模块结构

建议新增：

```text
backend/agent/interactions/
├── __init__.py
├── models.py              # Prompt、Action、Result、状态枚举
├── service.py             # 创建、签发、校验、消费、取消、过期
├── registry.py            # action handler 注册与路由
├── agent_bridge.py        # WAITING_INPUT、恢复和取消
└── gateway/
    ├── base.py            # 平台无关渲染/回调接口
    └── qq.py              # QQ Keyboard payload 与 interaction event
```

边界：

- Agent/工具层只描述交互意图和业务引用。
- `InteractionService` 负责安全生命周期，不负责发消息。
- `registry` 根据 action type 找业务 handler，但 handler 必须再次做权限和资源归属检查。
- 平台 adapter 只做 payload 转换、回调解析和结果发送。
- Guguchat/web 前端可以直接使用同一 API，不应复制一套确认状态机。

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
| Phase 0.5：薄协议骨架 | 🔄 | 已实现选择模型和 QQ `platform_user_id` 注册动作；暂不接 Keyboard 和状态机。 |
| Phase 1：Interaction Service | 🔲 | 建表，实现 token hash、创建、校验、原子消费、取消和过期。 |
| Phase 2：Agent Bridge | 🔲 | 接入 Agent Loop 的等待、恢复、取消和 session 恢复。 |
| Phase 3：Guguchat/Web | 🔲 | 先实现聊天气泡选择和网页确认，验证完整生命周期。 |
| Phase 4：QQ Keyboard | 🔲 | 根据真实 interaction event 样本实现渲染和回调 adapter。 |
| Phase 5：业务接入 | 🔲 | 先接 QQ 身份绑定，再接文件删除、覆盖和其他 destructive 工具。 |
| Phase 6：其他平台 | 🔲 | 飞书卡片、微信或其他平台按能力逐步适配。 |

每个阶段单独提交。任一阶段出现生命周期或权限行为差异，不进入下一阶段。

## 10. 测试与验收

### 10.1 自动测试

- Prompt 创建、过期、取消和重复消费。
- 错误用户、错误 Bot、错误会话和错误群不能消费 action。
- token 只保存 hash，日志不泄露 token 或聊天原文。
- 并发点击同一 action 只有一次 handler 执行。
- Agent 进入 `WAITING_INPUT` 后能恢复原 session。
- 用户直接输入可正确映射，模糊输入不会误执行。
- Guguchat/Web payload 与统一模型双向转换。
- QQ Keyboard payload 和 interaction event 使用固定样本解析。
- destructive handler 仍经过确认门、ownership 和幂等检查。

### 10.2 人工验收

1. Agent 对不确定问题展示选项，点击后继续原问题。
2. 点击确认/取消不会创建一条无关的新聊天任务。
3. 刷新 Guguchat 页面后，未过期的选择仍可继续。
4. 用户直接回复自然语言时，能正确选择或继续追问。
5. 过期按钮不会执行操作。
6. 其他用户点击按钮不能触发原用户的动作。
7. QQ Keyboard 成功发送、点击回调和重复点击均符合预期。
8. QQ 不支持按钮时能进入网页或文本兜底。
9. 删除文件确认取消后文件不变，确认后只执行一次。
10. 成功、失败和部分成功结果符合用户语气设置，不暴露内部 action 名称。

## 11. 待确认问题

- QQ Keyboard 使用模板键盘还是自定义键盘；需要先保存真实 interaction event 样本。
- Guguchat 选择气泡是否支持多选和输入框，第一版先按单选/确认实现。
- Agent 等待输入的最长保留时间，以及服务重启后的恢复策略。
- 一个 prompt 是否允许多个平台同时显示；默认只允许一个主平台，其他平台显示失效提示。
