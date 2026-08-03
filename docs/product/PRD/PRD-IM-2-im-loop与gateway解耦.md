# IM Loop 与 Gateway 解耦 PRD

> 状态：Phase 0 设计完成，Phase 1 待实施
> 创建：2026-08-03
> 最近更新：2026-08-03
> 关联模块：`backend/agent/adapters/qq.py`、`backend/agent/adapters/feishu.py`、`backend/agent/adapters/wechat.py`、`backend/worker.py`、`backend/agent/runner.py`
> 关联文档：[`PRD-IM-1-im接入稳定性与qq自建websocket.md`](./PRD-IM-1-im接入稳定性与qq自建websocket.md)、[`20-IM接入架构.md`](../../agent/20-IM接入架构.md)、[`21-群聊消息架构.md`](../../agent/21-群聊消息架构.md)、[`22-IM用户数据结构.md`](../../agent/22-IM用户数据结构.md)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：边界与协议设计 | ✅ 已完成 | 明确 Gateway、IM Loop、通用 Agent Runtime 的职责边界和消息协议。 |
| Phase 1：统一消息协议 | 🔲 待实施 | 新增入站 `PlatformMessage` 和出站 `PlatformReply`，保持现有 adapter 可兼容运行。 |
| Phase 2：抽出身份与权限层 | 🔲 待实施 | 将 owner/member/unknown 识别、工具白名单和上下文策略移出 `worker.py`。 |
| Phase 3：建立 IM Loop | 🔲 待实施 | IM 独立负责会话、群消息窗口、上下文组装和 Agent 调用。 |
| Phase 4：收窄 Gateway | 🔲 待实施 | Gateway 只负责平台连接、事件解析、入队和发送，不再处理业务身份。 |
| Phase 5：迁移与清理 | 🔲 待实施 | QQ、飞书、微信逐个平台迁移，删除旧的 IM 分支逻辑。 |
| Phase 6：群组与成员记忆 | 🔲 后续 | 复用 memory 组件，但使用独立的群组/平台用户 namespace，不与 owner 记忆混用。 |

## 1. 背景与目标

### 1.1 当前问题

当前 `agent/runner.py` 同时承担 Web 和 IM 的大量流程：

- Web 与 IM 的会话创建、历史加载和持久化。
- IM 平台身份解析和 owner/member 权限判断。
- 群聊消息窗口拼接。
- owner 的项目、文件、日程、profile、pattern、memory 注入。
- 工具白名单过滤、语音和附件处理、平台回复。

随着 QQ 群聊、群成员权限和平台用户名接入，`worker.py` 与 `runner.py` 中逐渐出现大量 `if platform`、`if chat_type`、`if im_role` 分支。最危险的后果是：非 owner 的群消息沿用了 owner 的 `user_id`，从而误注入 owner 的个人上下文或写入 owner 的长期记忆。

### 1.2 目标

建立一条独立的 IM 编排链路：

```text
Platform Gateway
  -> PlatformMessage
  -> ImLoop
  -> Identity / Permission / Context Policy
  -> Agent Runtime
  -> PlatformReply
  -> Platform Gateway
```

目标包括：

1. Web 保持当前行为和入口，但与 owner IM 共享同一套完整 AgentLoop 和能力组件。
2. IM 负责用户识别、owner/member 隔离、群消息上下文和平台回复编排。
3. Gateway 只负责平台连接、消息解析、入队和发送。
4. owner 在 IM 中保持 Web 同等权限和用户记忆，并按会话路由规则复用 Web 上下文。
5. 非 owner 进入轻量的 member 编排，不读取或写入 owner 的个人上下文。
6. 模型、工具、记忆接口、会话、附件和回复渲染等底层能力全部复用，不复制多套 Agent 实现。

### 1.3 非目标

- 不重写 Web runner。
- 不改变现有 QQ 自建 WebSocket、飞书 WebSocket、微信 iLink 的连接方式。
- 不在本 PRD 中实现群成员长期记忆；只为后续留出隔离边界。
- 不把平台名称、群名称当作身份主键。
- 不把 `owner_user_id` 继续作为当前发言人的身份字段传递给模型。

## 2. 功能需求

### FR-IM-1：统一入站消息协议（待实施）

所有 Gateway 将平台事件转换成统一的 `PlatformMessage`。IM Loop 不直接依赖 QQ、飞书或微信 SDK 的事件对象。

```python
PlatformMessage(
    platform="qqbot",
    bot_id="...",
    message_id="...",
    chat=ChatTarget(id="...", type="group"),
    sender=PlatformSender(id="...", name="..."),
    content="...",
    attachments=[],
    quoted_message=None,
    mentioned=True,
    received_at=...,
)
```

要求：

- `sender.id` 是平台身份识别字段。
- `sender.name` 只用于称呼，不参与权限和身份判断。
- `chat.id` 只用于回复路由和群消息窗口。
- `mentioned`、引用和附件是平台元数据，不在 Gateway 做业务决策。
- 保留消息去重所需的 `message_id`。

### FR-IM-2：统一出站回复协议（待实施）

IM Loop 输出平台无关的 `PlatformReply`，Gateway 只负责转换为对应平台的发送请求。

```python
PlatformReply(
    target=ChatTarget(id="...", type="group"),
    messages=[
        ReplyPart(type="text", text="..."),
        ReplyPart(type="file", file_id="..."),
        ReplyPart(type="keyboard", payload={...}),
    ],
    reply_to_message_id="...",
)
```

### FR-IM-3：owner 身份与上下文（待实施）

owner 消息进入 `OwnerContext`：

- 读取 owner 的 profile、pattern、preferences、memory 和 daily。
- 读取 owner 的项目、文件、日程和个人设置。
- 使用 Web 同等的完整工具权限。
- 允许写入 owner 的对话记忆。
- 群聊中的近期消息可作为额外 `GroupContext` 注入，但必须标明每条消息的发送者。

### FR-IM-4：非 owner loop 隔离（待实施）

member/unknown 消息进入独立的 `MemberContext`：

- 只保留当前平台身份元数据和必要的群聊消息窗口。
- 不注入 owner 用户名、profile、pattern、preferences、memory、项目、文件或日程。
- 不注入 owner 的跨会话续接桥。
- 不写入 owner 的长期记忆。
- 默认只开放网页搜索等明确白名单工具。
- 当前平台用户名可以用于自然称呼，但不能作为身份或权限依据。

非 owner 的 `owner_account_id` 只用于定位机器人所属账号和读取权限配置，不代表当前发言人。

### FR-IM-5：群聊上下文隔离（待实施）

群聊近期消息作为独立窗口保存和注入：

- 按 `platform + bot_id + chat_id` 区分群聊窗口。
- 每条消息保留 `sender_id`、`sender_name`、正文和时间。
- 当前阶段最多注入最近 50 条有效群消息。
- owner 的个人记忆不进入群成员 loop。
- 群成员消息不进入 owner 的长期记忆。
- 模型必须根据 `sender_id` 区分发言人，不能根据昵称或历史语气猜测身份。

### FR-IM-5A：群组与平台用户记忆（待实施）

群组/member 记忆复用现有 memory 组件的提取、压缩和检索能力，但不复用 owner 的记忆 namespace、加载范围和写入策略。两类记忆按平台、Bot 和作用域隔离：

```text
.agent/im/
├── qq/
│   ├── platform-users/{platform_user_id}/
│   │   ├── profile.md
│   │   ├── pattern.md
│   │   └── summary.md
│   └── groups/{group_id}/
│       ├── profile.md
│       ├── daily.md
│       └── memory.md
├── feishu/
└── weixin/
```

逻辑唯一作用域必须包含 `platform + bot_id`：

```text
platform + bot_id + platform_user_id
platform + bot_id + group_id
```

平台用户记忆只记录轻量资料、表达模式和阶段性摘要；群组记忆沿用现有 `profile.md`、`daily.md`、`memory.md` 结构，分别记录群资料、近期群聊和压缩后的稳定群知识。成员个人资料不能自动写入群记忆，群内公开信息也不能反向写入 owner memory。

MemberLoop 的读取顺序为：当前群 `daily.md` → 当前群 `memory.md` → 当前群 `profile.md` → 当前发言人的平台用户记忆 → 当前群消息窗口。写入和压缩应异步执行，不阻塞群聊回复；成员记忆需要独立的可见范围、删除、过期和群解散清理策略。

### FR-IM-6：Gateway 纯传输职责（待实施）

Gateway 只负责：

- 建立和维护平台连接。
- 解析平台事件为 `PlatformMessage`。
- 平台级消息去重、ack、重连和限流。
- 将消息送入 Redis Streams 或 IM Loop 队列。
- 将 `PlatformReply` 转换为平台发送 API。

Gateway 不负责：

- 判断 owner/member/unknown。
- 查找咕咕账号绑定关系。
- 加载 profile、memory、项目、文件或日程。
- 选择工具白名单。
- 拼接 Agent prompt。
- 决定是否写入长期记忆。

平台特有的 `@`、引用、附件下载和消息类型解析仍属于 Gateway 的协议适配职责，但是否回复、是否记录、是否调用模型由 IM Loop 决定。

## 3. 目标架构

### 3.1 分层关系

```text
Web Request
  -> OwnerAgentLoop
      -> OwnerContextAssembler
      -> Shared Agent Runtime
      -> Web Reply Adapter

QQ / 飞书 / 微信 Gateway
  -> PlatformMessage
  -> Redis Streams
  -> ImLoop
      -> IdentityResolver
      -> ImSessionStore
      -> OwnerAgentLoop       # owner：完整上下文和权限
      -> MemberAgentLoop      # member/unknown：轻量上下文和白名单
          -> Shared Agent Runtime
      -> PlatformReply Adapter
  -> Gateway Sender
```

共享关系应明确为：

```text
Web / Owner IM
      -> OwnerAgentLoop
            -> OwnerContextAssembler
            -> Shared ToolRegistry / ToolExecutor
            -> Shared ModelClient / AgentModelLoop
            -> Shared Memory / Attachment / Response components

Member IM
      -> MemberAgentLoop
            -> MemberContextAssembler
            -> MemberPermissionPolicy
            -> Shared ToolRegistry / ToolExecutor
            -> Shared ModelClient / Response components
```

Web 与 owner IM 共享完整的 owner 编排和能力组件，差异只保留在入口、session 路由和回复适配器。Member 不复制工具或模型执行逻辑，只使用更严格的上下文和权限策略。

### 3.2 OwnerLoop 与 MemberLoop 的边界

`OwnerAgentLoop` 是 Web 和 owner IM 的共同入口，负责：

- 加载 owner 的完整个人上下文。
- 使用完整工具权限和 destructive 确认门。
- 读取和写入 owner 的会话、记忆与附件。
- 调用共享的模型/工具执行循环。

`MemberAgentLoop` 只负责轻量编排，负责：

- 组装当前群的近期消息和当前发言人元数据。
- 根据 member/unknown 身份应用工具白名单。
- 调用同一套模型、工具执行、回复渲染和错误处理组件。
- 明确禁止加载 owner 的个人上下文，也禁止写入 owner 的长期记忆。

两者不是两套工具系统或两套模型 Loop，而是两种上下文、权限和会话编排策略。共享组件必须接收显式的 `ActorContext` 和 `ContextScope`，不能通过隐式的当前用户变量决定权限。

### 3.3 Owner 会话与 Web 上下文

owner 身份统一后，必须由 `OwnerSessionResolver` 解决“使用哪一个会话”，不能把所有 Web session 自动拼接到 IM。

默认规则：

- Web 请求继续使用页面传入的 `session_id`。
- owner 私聊 IM 使用绑定的 owner 私聊 session。
- owner 群聊使用对应群 session，但可以读取 owner 的完整个人上下文。
- owner IM 只有在明确建立 session 绑定后，才继续某个 Web session 的对话历史。
- 没有显式绑定时，不读取其他 Web session 的正文，只复用统一的 owner profile、memory、项目和工具权限。

这样可以保证 owner 的 Web 与 IM 体验一致，同时避免把不同网页标签页、不同任务或不同时间线无条件混到一起。`session_id` 是对话范围，`owner_user_id` 是权限和个人上下文范围，两者必须分开建模。

### 3.4 身份模型

```text
owner_account_id
  = 绑定 Bot 所属的咕咕账号

speaker_id
  = 当前平台发言人的 platform user id

speaker_name
  = 当前平台显示名，仅用于称呼

chat_id
  = 当前私聊或群聊会话，用于回复路由和消息窗口
```

禁止把 `owner_account_id` 直接当成 `speaker_id`。只有身份解析明确返回 `owner` 时，才允许进入 owner loop。

### 3.5 两种 IM Loop

```text
ImLoop.dispatch(message)
  -> identity = resolver.resolve(message)
  -> if identity.role == owner:
       OwnerAgentLoop.run(message, identity, session=OwnerSessionResolver.resolve(...))
     else:
       MemberAgentLoop.run(message, identity, session=ImSessionStore.resolve(...))
```

`OwnerAgentLoop` 由 Web 和 owner IM 共同调用；`MemberAgentLoop` 只负责 member/unknown 的轻量编排。二者共享 `AgentModelLoop`、工具注册表、工具执行器、附件处理、回复渲染和错误处理，但不得共享个人上下文加载器、owner 记忆写入策略或隐式 owner session。

## 4. 目标文件结构

```text
backend/agent/
├── adapters/
│   ├── base.py                 # 平台适配接口
│   ├── qq.py                   # QQ Gateway：连接、解析、发送
│   ├── feishu.py               # 飞书 Gateway：连接、解析、发送
│   ├── wechat.py               # 微信 Gateway：轮询、解析、发送
│   └── supervisor.py            # Gateway 进程生命周期
├── im/
│   ├── __init__.py
│   ├── models.py               # PlatformMessage / PlatformReply / identity DTO
│   ├── loop.py                 # IM 总入口和 owner/member 分流
│   ├── identity.py             # 平台身份解析、owner 绑定和角色判断
│   ├── permissions.py           # 工具白名单和 destructive 权限
│   ├── session.py              # 私聊/群聊 session 与消息窗口
│   ├── owner_session.py         # owner IM 与 Web session 的显式路由/绑定
│   ├── context_policy.py       # OwnerContext / MemberContext 规则
│   ├── context_builder.py      # 群消息与身份上下文组装
│   ├── owner_loop.py            # Web/owner IM 共用的完整编排门面
│   ├── member_loop.py           # member/unknown 轻量编排门面
│   └── response.py              # AgentResponse -> PlatformReply
├── runtime/
│   ├── model_loop.py           # 通用模型/工具执行循环
│   ├── persistence.py          # 消息、用量和会话持久化
│   └── attachments.py          # 通用附件处理
├── runner.py                   # Web 兼容入口；调用共享 OwnerAgentLoop
└── models.py                   # AgentRequest / AgentResponse 等共享 DTO

backend/worker.py               # 队列消费入口，最终只负责调用 ImLoop
```

迁移期间允许 `im/` 先以小模块形式存在，不要求一次性完成全部目录移动。优先抽出 `context_policy.py` 和 `identity.py`，再迁移 loop。

## 5. 关键实现流程

### 5.1 入站流程

```text
1. Gateway 收到平台事件
2. 解析 sender/chat/message/attachments/quoted/mentioned
3. 生成 PlatformMessage
4. 按 message_id 去重
5. 入 Redis Streams
6. Gateway 立即 ack 或发送平台要求的确认
7. ImLoop 消费消息
8. IdentityResolver 查询 owner 绑定与当前 speaker 角色
9. OwnerSessionResolver 或 SessionStore 选择会话范围
10. OwnerAgentLoop 或 MemberAgentLoop 选择对应编排
11. ContextPolicy/ContextBuilder 构造 OwnerContext 或 MemberContext
12. Shared AgentModelLoop 执行模型和工具
13. ResponseMapper 生成 PlatformReply
14. Gateway 按目标平台发送
15. Persistence 保存消息和必要的身份元数据
```

### 5.2 owner 回复流程

```text
PlatformMessage
  -> resolve owner
  -> OwnerSessionResolver
  -> OwnerAgentLoop
  -> owner personal context + optional group context
  -> full tools and memory reflection
  -> shared model/tool runtime
  -> PlatformReply
```

### 5.3 非 owner 回复流程

```text
PlatformMessage
  -> resolve member/unknown
  -> MemberAgentLoop
  -> member session or group context window
  -> identity metadata + group context only
  -> allowlisted tools only through shared ToolExecutor
  -> no owner memory read/write
  -> PlatformReply
```

### 5.4 普通群消息流程

普通群消息是否进入模型由 IM Loop 的群聊策略决定，而不是 Gateway 决定：

- `group_chat_enabled=false`：丢弃或只记录平台级诊断元数据。
- `group_read_enabled=true` 且未 @：写入群消息窗口，不调用模型。
- 被 @ 或明确触发：进入 owner/member loop。
- 权限失败：按 unknown 最小工具白名单执行，不能升级为 owner。

## 6. 数据与日志要求

### 6.1 持久化边界

继续保存以下元数据：

- `platform`
- `platform_user_id`
- `platform_user_name`
- `chat_type`
- `chat_id`
- `message_id`
- `owner_account_id`
- `im_role`

但必须区分：

- `owner_account_id`：账号归属和资源权限。
- `platform_user_id`：当前发言人身份。
- `platform_user_name`：展示字段，不是身份主键。

非 owner 消息可以落库为群聊上下文，但不能触发 owner 记忆反思或 profile 更新。

### 6.2 日志边界

- 不记录聊天正文、附件文件名、token 或上游响应体。
- 诊断日志只记录脱敏后的 `platform_user_id` 指纹、角色、chat 类型和 trace。
- Gateway 日志记录连接、ack、去重和发送结果。
- IM Loop 日志记录身份解析结果、上下文策略和工具权限结果。
- 不在 Gateway 日志中记录 owner 资料或记忆内容。

## 7. 实施计划

### Phase 1：统一协议与兼容门面

- 新增 `agent/im/models.py`。
- 将 QQ、飞书、微信现有 payload 映射为 `PlatformMessage`。
- 增加 `PlatformReply` 到现有发送方法的兼容转换。
- 保留旧 payload 字段，确保现有 worker 可回退。
- 验收通过后再进入身份层拆分。

### Phase 2：抽出身份与上下文策略

- 新增 `identity.py`、`permissions.py`、`context_policy.py`。
- 把 owner/member/unknown 判断移出 `worker.py`。
- 把 owner 个人上下文的加载和 member 空上下文策略集中管理。
- 增加防回归测试：member 不读 owner memory，不写 owner reflection。

### Phase 3：建立 ImLoop

- 新增 `im/loop.py`、`session.py`、`context_builder.py`。
- 抽出共享 `OwnerAgentLoop` 和轻量 `MemberAgentLoop` 门面；Web 与 owner IM 都调用前者。
- 新增 `OwnerSessionResolver`，区分 owner 上下文范围与具体对话 session，支持显式 Web session 绑定。
- 将群聊 50 条窗口、私聊 session、引用和附件编排迁入 IM Loop。
- `worker.py` 只保留队列消费、调用 loop 和异常边界。
- `runner.py` 保持 Web 入口和外部协议不变，内部改为调用共享 `OwnerAgentLoop`。

### Phase 4：收窄 Gateway

- QQ、飞书、微信改为只输出 `PlatformMessage`。
- 删除 Gateway 中的 owner 资料注入、工具选择和业务上下文拼接。
- 平台发送统一接收 `PlatformReply`。
- 逐个平台迁移，每个平台单独验证收发、引用、附件和重连。

### Phase 5：清理与群记忆预留

- 删除旧 payload 兼容分支和 worker 中重复 IM 判断。
- 将群消息窗口与个人记忆存储边界写入数据库约束和测试。
- 仅完成长期群聊记忆的接口预留，不在本 PRD 中实现压缩算法。

每个阶段单独提交。任一阶段出现 owner 权限、群回复路由或上下文差异时，不进入下一阶段。

## 8. 验收清单

### 自动验收

- [ ] `PlatformMessage` 可由 QQ、飞书、微信事件生成。
- [ ] `PlatformReply` 可转换为三平台文本、文件和 Keyboard 回复。
- [ ] 相同 `message_id` 只处理一次。
- [ ] owner/member/unknown 解析结果稳定。
- [ ] member 不加载 owner 的项目、文件、日程、profile、pattern、memory。
- [ ] member 不触发 owner 的 memory reflection。
- [ ] member 只能使用配置的工具白名单。
- [ ] 群消息按 `platform + bot_id + chat_id` 隔离。
- [ ] 不同群的消息不会进入同一上下文窗口。
- [ ] `owner_account_id` 不会被当成 `platform_user_id`。
- [ ] Gateway 不依赖 Agent prompt 或个人记忆模块。
- [ ] 可在不启动 Web runner 的情况下单测 IM Loop。
- [ ] Web 与 owner IM 调用同一个 `OwnerAgentLoop` 和共享能力组件，不存在两套工具/模型执行逻辑。
- [ ] member 使用 `MemberAgentLoop`，只能替换上下文、权限和会话编排，不能读取 owner 个人上下文。
- [ ] owner 私聊默认使用绑定的 owner session；未显式绑定时不会自动拼接任意 Web session 正文。
- [ ] 显式绑定 Web session 后，owner IM 可以继续该 session 的上下文，Web 侧也能看到同一 session 的 IM 消息。

### 手动验收

1. owner 私聊查询项目、文件、日程，结果与 Web 一致。
2. owner 私聊和 Web 调用结果一致，且都经过同一个 OwnerAgentLoop。
3. 显式绑定 Web session 后，owner 从 IM 继续对话，网页能看到同一 session 的消息和附件。
4. 未绑定 Web session 时，owner IM 不会误拼接其他标签页或其他任务的对话正文。
5. owner 在群里 @ 咕咕，能使用完整 owner 权限，但群消息仍按群 session 保存。
6. 非 owner 在群里 @ 咕咕，只能聊天和使用白名单工具。
7. 非 owner 询问“我是谁”时，不会被回答成 owner，也不会注入 owner 个人资料。
8. 非 owner 连续对话时，能使用群聊上下文，但看不到 owner 的个人记忆和资源概览。
9. 两个不同 QQ 账号使用不同用户名发言，身份和称呼均不串线。
10. 同一用户换群后，平台身份仍可识别，但不同群的消息窗口不混用。
11. 未 @ 的普通群消息开启只读模式时只记录、不调用模型、不回复。
12. owner 和 member 连续交替发言，双方 loop 不互相覆盖 session、权限和上下文。
13. QQ、飞书、微信断线重连后，消息仍能进入同一 IM Loop。
14. Gateway 发送文本、文件和 Keyboard 时，IM Loop 不感知平台 API 细节。
15. 重启 worker 后不会重复处理已经 ack 的消息。

## 9. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 当前群 session 仍可能包含 owner 之前说过的敏感正文 | member 看到不应看到的群内历史 | Phase 3 增加按消息可见范围和上下文裁剪策略；至少标注 speaker 和 scope。 |
| `owner_account_id` 仍用于现有资源查询 | 迁移期间可能误把 member 当 owner | Phase 2 增加显式 `ContextScope` 和工具层权限守卫。 |
| 三个平台出站能力不一致 | 文件、Keyboard 或引用回复行为不同 | `PlatformReply` 使用 capability 声明，不支持的 part 必须显式降级。 |
| Gateway 与 worker 同时保留旧/新 payload | 迁移期间字段含义可能冲突 | 每阶段保留兼容解析，但只允许一处做业务身份解析。 |
| member 长期记忆尚未定义 | 可能污染 owner 记忆或造成隐私越界 | Phase 6 单独设计存储、可见范围、删除和用户授权。 |

待确认：

- 🔲 群聊历史对 owner 与 member 是否完全一致，还是按消息 scope 做进一步过滤。
- 🔲 member 是否允许使用 Keyboard 触发需要身份确认的动作。
- 🔲 非 owner 的群消息是否建立独立会话，还是只使用群消息窗口加临时 response session。
- 🔲 飞书和微信是否也采用与 QQ 相同的 owner/member 绑定策略。
