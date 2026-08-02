# 统一交互提示与按钮动作

> 状态：Phase 1 🔲 待评估
> 创建：2026-08-03
> 最近更新：2026-08-03
> 关联模块：`backend/agent/adapters/qq.py`、`backend/agent/runner.py`、`backend/agent/tools/base.py`、`backend/app/models/__init__.py`
> 背景参考：QQ Keyboard/interaction event；[[../../agent/22-IM用户数据结构.md]]；[[PRD-IM-1-im接入稳定性与qq自建websocket.md]]

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 需求与交互模型 | 🔲 待评估 | 已确定统一动作模型和平台适配边界，尚未实现。 |
| Phase 1：一次性动作与确认服务 | 🔲 待评估 | 创建、签发、校验、消费交互动作。 |
| Phase 2：QQ Keyboard 接入 | 🔲 待评估 | 发送按钮并处理 QQ interaction event。 |
| Phase 3：破坏性操作接入 | 🔲 待评估 | 首先接入文件删除、回收站清空等确认门。 |
| Phase 4：其他 IM 平台适配 | 🔲 待评估 | 飞书、微信按平台能力逐步接入。 |

权限相关实施不单独复制一套流程，统一遵循 [[../../agent/22-IM用户数据结构.md]] 第 6 节：身份采集 → 所有者绑定 → 权限解析 → 工具白名单 → 会话级配置 → 记忆隔离。Keyboard 只负责“确认动作”，不直接决定权限。

## 1. 背景与目标

### 1.1 背景

当前确认动作主要依赖文本确认或工具层约定。不同 IM 平台的按钮、卡片和交互回调没有统一模型，导致 QQ 身份绑定、文件删除确认、归档和群聊开关容易各自实现一套逻辑。

QQ Bot 支持 Keyboard/按钮交互：咕咕发送带按钮的消息，用户点击后平台回传交互事件。用户体验上是“点击确认后自动收到结果”，后台实际上需要校验按钮动作、会话和点击者身份。

### 1.2 目标

- 建立平台无关的 `InteractionPrompt` 和 `InteractionAction` 模型。
- 让工具只声明“需要用户确认什么”，不直接拼 QQ 或飞书消息 JSON。
- 所有按钮动作使用短期、一次性、绑定身份的 challenge，防止重复点击和跨用户触发。
- 让删除文件等 destructive 操作继续经过现有确认门，按钮不能绕过安全校验。
- 支持依据用户的语气偏好生成自然的确认结果，不把内部动作 ID 直接暴露给用户。
- QQ 先落地，未来允许飞书、微信和网页使用相同动作模型。

### 1.3 不在本期范围

- 不重写现有工具 dispatch 和确认门。
- 不把所有普通提示都改成按钮；纯信息通知仍可使用普通消息。
- 不把平台按钮能力假设成所有 IM 都支持；不支持交互回调的平台必须有文本或网页兜底。
- 不在本 PRD 内解决完整的 IM 用户身份表；绑定关系遵循 [[../../agent/22-IM用户数据结构.md]]。

## 2. 功能需求

### FR-INT-1：统一交互提示模型（🔲 待评估）

系统提供平台无关的交互提示对象：

```text
InteractionPrompt
├── title
├── body
├── actions[]
├── expires_at
├── target_platform
├── target_chat_id
├── target_platform_user_id
└── context

InteractionAction
├── action_id
├── label
├── style: normal / primary / danger
├── destructive
└── payload_ref
```

工具只提供动作语义和受保护的上下文引用，不直接提供平台消息字段。

### FR-INT-2：一次性动作生命周期（🔲 待评估）

每个动作必须具备：

- 10 分钟以内的有效期，具体时长由场景决定；
- 一次性消费状态：`pending`、`consumed`、`expired`、`cancelled`；
- 绑定 Gugu 用户、Bot、会话和平台用户身份；
- 服务端保存真正的业务上下文，按钮只携带不可猜测的 `action_token`；
- 重复点击返回友好提示，不重复执行原操作。

### FR-INT-3：QQ Keyboard/按钮渲染（🔲 待评估）

QQ 适配器负责把统一模型转换成 QQ Keyboard 消息，并处理 WebSocket interaction event：

```text
InteractionPrompt
  → QQ keyboard payload
  → QQ interaction event
  → action_token 校验
  → 业务 handler
  → QQ 普通消息确认结果
```

点击者必须与动作创建时绑定的 `platform_user_id` 一致。其他群成员点击同一按钮时不得执行动作，只能收到“这个确认不属于你”一类的自然提示。

### FR-INT-4：破坏性操作确认（🔲 待评估）

优先接入：

- 删除文件；
- 清空回收站；
- 删除项目或画布；
- 取消定时任务；
- 批量移动或覆盖文件。

流程：

```text
工具判断为 destructive
  → 现有确认门创建 InteractionPrompt
  → 用户点击“确认”或“取消”
  → action handler 再次检查权限和资源归属
  → 执行一次业务操作
  → 验证结果并用自然语言回复
```

按钮确认不能代替 `confirm` 参数，也不能绕过 `get_owned()`、权限校验或幂等检查。

### FR-INT-5：QQ 身份绑定确认（🔲 待评估）

需要绑定 QQ 身份时，若已有候选 QQ `user_openid`，直接通过 C2C 发送确认消息，不要求群消息读取、不要求用户 `@咕咕`，也不生成或发送验证码：

```text
网页发起 QQ 身份绑定请求，生成一次性 pending action
  → QQ 通过候选 user_openid 发送“确认 / 取消”按钮
  → 用户点击按钮
  → 校验 Bot、咕咕用户、pending action 和 user_openid
  → 确认后写入 platform_identities，成为该 Bot 的 owner
```

按钮回调完成前不进入 Agent Loop、不读取群上下文、不执行工具。当前 QQ Bot 实测同一账号的 C2C `user_openid` 与群聊 `member_openid` 指纹一致，不同账号的指纹不同；但当前 worker 仍直接使用 Bot 的 `owner_user_id`，因此正式开放群聊 CUD 前必须改为按已绑定 `platform_user_id` 做 owner 判断。若没有候选 `user_openid`，QQ Bot 无法主动找到该用户并发送 C2C 消息，应先提示完成身份采集。具体身份表和权限关系以 `IM 用户数据结构` PRD 为准。

### FR-INT-6：自然语言结果（🔲 待评估）

点击结果不直接输出“action=delete_file, status=success”等内部结构，而是：

- 根据实际执行结果说明做了什么；
- 明确哪些项目成功、哪些失败；
- 沿用当前用户的语气风格和 IM 人设；
- 不把无失败项写成机械的“没有失败项”，除非用户需要结构化结果；
- 执行失败时如实说明未完成，不把按钮点击成功误报成业务成功。

## 3. 技术方案

### 3.1 模块边界

建议新增：

```text
backend/agent/interactions/
├── models.py          # InteractionPrompt、InteractionAction、状态
├── service.py         # 创建、签发、校验、消费、过期
├── registry.py        # action handler 注册和路由
└── adapters/
    ├── base.py        # 平台渲染/回调接口
    └── qq.py          # QQ Keyboard 和 interaction event
```

工具层只依赖 `service.create_prompt()`；QQ 适配器只负责平台协议，不知道文件删除、身份绑定等业务细节。

### 3.2 动作存储

建议新增 `interaction_actions` 表：

```text
id
token_hash
gugu_user_id
bot_id
chat_id
platform
platform_user_id
action_type
context_json
status
expires_at
consumed_at
created_at
```

数据库只保存 token hash；原始 token 只在生成时返回给平台消息。`context_json` 只能保存业务引用，例如 `file_id`、`project_id`，不能保存密钥、完整用户消息或未经脱敏的上游响应。

### 3.3 权限与执行

处理回调时固定执行：

```text
解析平台事件
→ 按平台和 Bot 定位动作
→ 比对 token hash
→ 检查有效期和未消费状态
→ 校验 chat_id / platform_user_id
→ 校验 Gugu 用户权限和资源归属
→ 消费动作（原子更新）
→ 调用业务 handler
→ 发送结果
```

动作消费和 destructive handler 必须支持幂等。旧回调不能清理或覆盖新动作的状态。

### 3.4 平台适配

| 平台 | 第一阶段策略 |
|---|---|
| QQ | 使用 Keyboard 和 WebSocket interaction event；优先实现 |
| 飞书 | 使用消息卡片按钮回调，沿用同一 action token |
| 微信 | 若网关没有按钮回调，退回文本验证码或网页确认 |
| 网页 | 直接渲染为确认弹窗，复用相同 action handler |

平台不支持按钮时，不能伪造“已点击确认”；应明确走文本或网页兜底。

### 3.5 日志与隐私

- 不记录原始 token、完整按钮 payload、聊天正文或文件名；日志只记录 action 类型、结果、哈希指纹和 trace ID。
- 可见错误经过 `redact()`；原始异常只进入受限诊断日志。
- 不把用户身份、资源 ID 和 token 拼进公开 URL。
- interaction event 需要防重放，平台事件 ID可作为去重键。

## 4. 验证与上线

### 4.1 自动测试

- 创建动作、过期动作、取消动作和重复消费；
- 错误 Bot、错误群、错误用户不能消费；
- token 只保存 hash，日志不泄露 token；
- destructive 动作仍经过确认门、权限和资源归属检查；
- 同一 interaction event 重放不会重复执行；
- QQ Keyboard payload 和 interaction event 解析；
- 平台不支持按钮时正确进入文本/网页兜底。

### 4.2 人工验收

1. 已保存 QQ `user_openid` 的用户收到 C2C 确认按钮，不需要群消息或 `@咕咕`。
2. 用户点击确认后，QQ 身份绑定成功并收到自然语言回复；该身份在 Bot 的所有群中拥有完整 CUD。
3. 用户点击取消，绑定不发生且 pending action 失效。
4. 按钮被转发或其他身份点击，不能抢占绑定。
5. 重复点击或重复投递 interaction event，不重复开启群聊。
6. 没有已保存 `user_openid` 时，网页明确提示先完成身份采集，不尝试从群消息猜测身份。
7. 删除文件点击取消，文件保持不变。
8. 删除文件点击确认，只执行一次并核对结果。
9. QQ 按钮不可用时，按平台能力进入网页确认，不依赖群内 `@`。
9. 成功、失败和部分成功结果符合用户语气设置，不暴露内部 action 名称。

### 4.3 上线策略

- 先以 QQ 身份绑定作为灰度场景，不开放所有破坏性工具。
- 再接入单文件删除，观察重复消费和越权拒绝日志。
- 最后逐个迁移其他 destructive 工具。
- 回滚方式：关闭交互动作入口，恢复原有文本确认；未消费的动作自然过期。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| QQ 不同消息类型的 Keyboard 回调字段不一致 | 按钮点击无法路由 | 先用真实 QQ Bot 抓取 interaction event，固定适配器测试样本 |
| 群内按钮对所有成员可见 | 可能出现误点击或恶意点击 | challenge 绑定点击者，回调时再次校验 `platform_user_id` |
| 业务执行完成但结果消息发送失败 | 用户误以为未执行而重复点击 | 动作先原子消费，结果发送失败时保留可查询执行记录 |
| 旧服务与新服务并存 | 新旧动作状态解释不同 | token 版本化，灰度期间只允许新服务消费新动作 |
| 上下文引用包含敏感数据 | 日志或动作表泄露隐私 | 只保存资源 ID 和脱敏摘要，不保存原文 |

- 🔲 QQ interaction event 的真实字段、确认方式和消息 ack 语义待 devserver 实测。
- 🔲 `interaction_actions` 是否使用数据库表还是 Redis + 数据库审计，需要按动作数量和过期清理成本决定。
- 🔲 飞书卡片按钮是否能统一复用 `action_token`，待现有卡片网关验证。
- 🔲 微信是否具备可用的按钮回调，若没有则保持文本/网页兜底。
