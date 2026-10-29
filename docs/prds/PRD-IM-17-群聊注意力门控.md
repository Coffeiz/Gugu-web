# PRD-IM-17：群聊注意力门控

> 状态：设计提案；目标为完整门控直接上线，实施与生产验收尚未完成
> 创建：2026-10-29
> 最近更新：2026-10-29
> 关联模块：`frontend/src/components/common/profile/ProfileImPane.vue`、`backend/app/api/v1/user_bots.py`、`backend/app/models/__init__.py`、`backend/agent/im/auto_reply/`、`backend/agent/im/dispatch.py`、`backend/agent/im/inbound_batch.py`、`backend/agent/im/inbound_recovery.py`、`backend/worker.py`
> 背景参考：[`PRD-IM-16：群聊自动回复选择门`](./PRD-IM-16-群聊自动回复选择门.md)；用户提供的 PRD-IM-17 v1.2 实施基线

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 群聊 Run 内回复选择 | 🟡 部分完成 | PRD-IM-16 已定义并接入 `choose_no_reply`；其回归和真实平台验收仍需按该 PRD 状态跟踪。 |
| 入站合批、原消息及发言人信息 | 🟡 部分完成 | Worker 已合并相邻消息并保留部分逐条字段；PRD-IM-17 所需的可信事件 ID、时间、提及和引用关系契约尚未落实。 |
| 群聊注意力分类与评分 | 🔲 待评估 | 尚无 `DIRECT / CONTINUE / PROACTIVE / PASSIVE` 确定性准入门控。 |
| PASSIVE 批次完成、恢复与幂等 | 🔲 待评估 | 尚无专用于注意力门控的逐条完成事务及完成收据。 |
| 用户可选的群聊注意力模式 | 🔲 待评估 | “接入咕咕”尚未提供主动、自然、安静三档；新设置默认自然。 |
| 主动回复配额与出站账本 | 🔲 待评估 | 尚未建立统一出站账本或自主回复配额。 |

## 1. 背景与目标

群聊自动回复模式会把未明确 @ 咕咕的普通消息送入 Agent Run。即使 Run 内已有 `choose_no_reply`，启动 Run 仍会消耗模型与工具资源；模型也可能在群友互相交谈、讨论其他 Bot 或话题已经结束时插话。

本 PRD 在完整 Agent Run 前增加纯确定性的准入门控，只回答“当前消息段是否值得启动 Run”。门控不生成回复，不代替 Run 内的 `choose_no_reply`，不新增 LLM 请求，不新增固定等待。

目标：

- 减少群友互相交流、结束话题和无明确对象的闲聊引发的无关 Agent Run。
- 保留可信 @、明确文字呼叫和可验证的 Bot 对话续接路径。
- 完整实现后直接上线，不建设 Shadow 或 `hard_only` 中间执行模式。
- 在“接入咕咕”中按每个已连接 Bot 提供“主动 / 自然 / 安静”选择；设置仅影响该 Bot 的群聊自动回复。
- 即使不启动 Run，群消息仍按原消息粒度持久化，重投时不重复插入，不丢附件或历史。
- 自主回复配额只统计统一出站账本确认接受的主动发言机会。

非目标：

- 不替换现有 Agent Loop、回复提示词或 `choose_no_reply` 协议。
- 不新增 Decision LLM、Embedding、reranker 或文本话题相似度模型。
- 不改变私聊、Web、定时任务、微信等非目标渠道的行为。
- 不把文字提及用于 owner 权限、工具白名单或资源授权判断。
- V1 不对无文字裸图、文件、语音、贴纸、表情和转发占位主动回复；只有 §2 的可信媒体续接例外可以进入 Run。

## 2. 功能需求

### FR-IM-17-01：限制适用范围并提供用户可选模式

门控只处理 QQ、飞书、Telegram 群聊中已进入普通自动回复分支、尚未被既有交互或命令通道消费的消息段。完整门控作为上线行为，不提供 Shadow 或 `hard_only` 中间模式。

“接入咕咕”中每个 QQ、飞书或 Telegram Bot 显示一个群聊参与度选项：

| 用户选项 | 内部值 | 行为 | 自主配额 |
|---|---|---|---|
| 安静 | `quiet` | 仅 DIRECT/可信 CONTINUE 进入 Run；其他未邀请消息按 PASSIVE 完成。 | 不预留。 |
| 自然（默认） | `natural` | 开放候选分数达到 70 且预算可用才进入 Run。 | 预留并按统一出站账本提交。 |
| 主动 | `active` | 开放候选分数达到 55 且预算可用才进入 Run。 | 预留并按统一出站账本提交。 |

选项放在“接入咕咕”各 Bot 的群聊回应方式设置中，仅当 Bot 支持群聊、群聊已启用且回应方式为“自动回复”时展示。设置按 Bot 保存，应用于该 Bot 接入的所有群；V1 不新增逐群覆盖。切换为“只响应 @”或“静默记录”时保留已选值但不生效，切回“自动回复”后恢复。新建和历史 Bot 均以 `natural` 为默认值，迁移不得覆盖用户已有的其他设置。

门控完整模式作为产品行为直接上线。仅保留运维级全局紧急开关用于严重故障时回退至原 `choose_no_reply` 路径；该开关不出现在普通用户设置中，也不作为常规灰度阶段。

真实原生 @ 当前 Bot 继续走既有路由和权限解析，不计自主额度。只读、仅 @、@ 其他 Bot、快捷交互、命令、取消、确认和绑定码等既有路径不得被门控重新解释。

### FR-IM-17-02：以逐条可信消息作为门控输入

每条平台入站消息必须独立映射为不可变的 `AttentionMessage`。不得从合并后的 `payload["text"]` 推断原始发言人、提及或引用关系。

```python
@dataclass(frozen=True)
class AttentionMessage:
    event_id: str                          # Redis Stream message ID
    platform: str                          # qq / feishu / telegram
    bot_id: str                            # 稳定 Bot 标识
    group_id: str                          # 当前平台群 ID
    platform_message_id: str | None        # 平台原生消息 ID
    sender_id: str | None                  # 平台结构化发言人 ID
    event_received_ms: int                 # 可信入队时间
    platform_sent_ms: int | None           # 经平台字段核验的发送时间
    raw_text: str
    media_only: bool
    media_kinds: tuple[str, ...]           # image/file/sticker/emoji/audio/video/forward/unknown
    processable_media: bool | None         # 媒体是否已入站且 Agent 可处理
    mentioned_current_bot: bool            # 结构化原生 mention
    mentioned_other_bot: bool | None       # UNKNOWN 不等于 False
    mentioned_other_member: bool | None
    reply_to_platform_message_id: str | None
    reply_target_sender_id: str | None     # 仅可信引用索引可解析
    reply_target_is_bot: bool | None
    quote_text: str | None                 # 仅作上下文，不能反推引用身份
    metadata_version: int = 1
```

字段事实来源与降级行为：

| 字段 | 权威来源 | 无法取得时 |
|---|---|---|
| `event_id` | Worker 收到的 Redis Stream `msg_id`，逐条传入批次消息。 | 不运行新门控，保持旧的可恢复入站路径并告警。 |
| `(platform, bot_id, group_id)` | 既有 Gateway 标识和 session route。 | 不共享跨群状态；按既有路由处理或显式失败。 |
| `sender_id` | 平台结构化发送者 ID。 | 不做同人续接、双人对话或跨人问答判断。 |
| `event_received_ms` | Gateway/Redis 入队时间。 | 不以处理时刻伪造到达时间。 |
| `platform_sent_ms` | 经验证的平台发送时间。 | 使用入队时间，并保留时间来源。 |
| 原生 mention 字段 | 平台事件中的结构化目标列表。 | `UNKNOWN`；正文 `@名字` 不证明目标身份。 |
| 引用字段 | 原生 reply ID 及同作用域已验证的 ID→消息/发送者索引。 | `UNKNOWN`；不得由 `quote_text` 猜引用身份。 |
| 媒体字段 | 原生组件类型、媒体入站/暂存结果和可用附件标识。 | 不触发媒体续接例外；纯媒体按 H01 处理。 |

实施前逐平台核对 Gateway 事件、Worker 合批字段、数据库或缓存引用索引，并以 fixture 验证字段的 `AVAILABLE / PARTIAL / UNAVAILABLE` 状态。协议可能支持的字段不能算作当前已可靠透传。

入站顺序以 Redis Stream 到达顺序为准。平台时间只用于时间窗口，不用于重排消息。相同 `(scope, event_id)` 只能对应一条逻辑用户消息；引用查询严格限制在同一平台、Bot 和群作用域内。

### FR-IM-17-03：按确定顺序分类指向与续接

决策顺序不可交换：

1. 先执行现有群模式、交互/命令快捷通道、权限路由、owner @ 分段及 @ 其他 Bot 规则。
2. 识别 DIRECT：原生 @ 由旧路径处理；可信引用 Bot 消息且带新问题/明确请求/纠正；或配置昵称/别名在正文开头明确呼叫并提出具体请求。文字呼叫只影响是否进入普通 Run，不授予权限。
3. 检查可信媒体续接，再检查 H 类硬拒绝。
4. 判定可信 CONTINUE。不得仅凭“同一发言人 + Bot 120 秒内发过言 + 当前消息像问题”判为 CONTINUE。
5. 对剩余开放候选评分；预算通过才以 PROACTIVE 进入 Run。

可信 CONTINUE 必须有以下关系锚点之一：

- 当前消息原生引用同作用域中 Bot 最近 120 秒内成功发送的消息，且引用消息关联到当前发言人；消息含有新信息、追问、纠正或明确下一步。
- 当前消息以经配置验证的 Bot 开头呼叫提出具体请求，按 DIRECT 处理。
- 当前消息是 Bot 显式交互问询对应的、已验证的原生交互响应；优先由既有交互快速通道消费。

其他情况不得判为 CONTINUE。引用 Bot 后只说“谢谢”“好”“哈哈”等仍静默；同一用户短时间提出新话题按普通候选评分。

唯一纯媒体续接例外：真人消息无实质文字，但含已成功入站、Agent 可处理的图片或文件，且原生引用指向同作用域、最近 120 秒内 Bot 成功发送并关联到当前发言人的消息。引用映射、发送状态、回复对象、附件类型和可处理状态都必须可信；任何 UNKNOWN 都不满足。引用他人、裸图、贴纸/表情/转发、无回复对象记录的 Bot 群发消息不属于例外。V1 不用 OCR、文件名或图像内容猜测用户意图。

### FR-IM-17-04：执行高置信度硬拒绝

H 类条件只作用于未通过 DIRECT/CONTINUE 及可信媒体续接的候选：

| 编号 | 条件 | 结果 |
|---|---|---|
| H01 | 纯媒体且无文字问题：图片、文件、音频、视频、表情、贴纸或转发占位；可信媒体续接例外除外。 | PASSIVE |
| H02 | 仅礼貌结束或短反应（如“哈哈”“好”“收到”“谢谢”“嗯”“666”“？”、“草”），规范化长度不超过 8 字且无实质新问题。 | PASSIVE |
| H03 | 可信原生 @ 其他 Bot/成员，且未 @ 当前 Bot。 | PASSIVE |
| H04 | 可信原生引用指向他人，正文没有明确呼叫咕咕。 | PASSIVE |
| H05 | 高置信无目标命令（如“测试个功能”“帮我看看”），没有可确认的 Bot 指向。 | PASSIVE |
| H06 | 高置信泛泛评价、反问、打趣或无请求表达。 | PASSIVE |
| H07 | 已由既有交互/命令快速通道消费，或已完成的同批消息。 | 不重复进入门控或 Run。 |
| H08 | 提问者本人或可信引用关系中的当事人确认该具体问题已解决，且当前没有新问题。 | PASSIVE |

H05/H06 只用高精度规则。无法确定指向时不得硬判指向他人；UNKNOWN 不作为否定证据给正分。

三种用户模式都执行 H 类硬拒绝。批次中的每条原始消息独立分类，不因同批其他消息改变其身份或内容；未命中 H 类的消息继续进入对应模式的 DIRECT、CONTINUE 或开放候选判断。

### FR-IM-17-05：仅对开放问题评分

成为 `open_candidate` 后才评分。候选必须至少有明确面向群体的求助/征询表达，或由疑问/求助结构与可验证具体对象/约束共同支持的实质问题。问号、命令短句、“这个怎么搞”等不足以单独成立。原生提及目标未知的 `@...` 不进入主动候选。

对每条候选单独计算，批次取最高分，不把不同成员的内容拼成更强的问题。只有同一 `sender_id` 在 8 秒内的连续补充可为特征提取合成逻辑候选，原始记录仍逐条保留。

分数为正负特征之和并截断到 0–100；未知特征贡献 0，同一证据不得重复计算。

| 编号 | 分值 | 条件 |
|---|---:|---|
| P01 `group_broadcast_request` | +35 | 同一消息明确面向群体求助/征询，且有具体对象。 |
| P02 `substantive_question` | +30 | 有可回答的问题结构和具体对象，或高置信“对象 + 报错/配置/推荐”等结构。 |
| P03 `concrete_context` | +15 | 有具体对象及限定信息，如错误码、配置、软件故障、型号与比较维度。 |
| P04 `unanswered_observed` | +10 | 现有处理窗口已自然超过 5 秒、快照完整可靠，问题之后无真人消息；不为此额外等待。 |
| P05 `quiet_conversation` | +10 | 最近 60 秒完整快照确认没有活跃人对人交流或问题回应；与 peer exchange 特征互斥。 |
| P06 `multiple_independent_askers` | +10 | 同批另一位不同成员以相同规范化问题或高置信同源引用提出同题。 |
| N01 `strong_peer_exchange` | −45 | 60 秒内固定两名成员形成至少 A→B→A 且存在可信相互引用，Bot 未参与；不与 N02 叠加。 |
| N02 `weak_peer_exchange` | −20 | 60 秒内 A/B 交替，二人占真人消息至少 70%，但无可信相互引用；不与 N01 叠加。 |
| N03 `human_answer_confirmed` | −45 | 提问者通过可信引用确认问题已解决，或有经验证的结构化已解决标记。 |
| N04 `recent_proactive_bot_reply` | −25 | Bot 最近 180 秒成功发出过 PROACTIVE 回复。 |
| N05 `busy_group` | −10 | 最近 60 秒有效真人消息不少于 8 条。 |
| N06 `vague_question` | −25 | 候选仍可评分但缺乏可回答边界/约束。 |
| N07 `bot_already_answered` | −40 | 300 秒内 Bot 已回答相同原始问题 ID 或高置信完全相同的归一化问题。 |

P01/P02 是不同证据，可同时计分；P03 需要独立具体上下文。H03/H04/H08 是硬拒绝，不能用其他加分抵消。

### FR-IM-17-06：限制主动回复频率并保证并发安全

自主预算仅适用于 PROACTIVE。以成功接受时间计算每群 600 秒滑动窗口；DIRECT/CONTINUE 不消耗自主额度。

| 模式 | 最低分数 | 每 600 秒上限 | 最短间隔 |
|---|---:|---:|---:|
| `quiet` | 禁止 PROACTIVE | 0 | — |
| `natural` | 70 | 2 | 180 秒 |
| `active` | 55 | 5 | 60 秒 |

通过评分后、启动 Run 前，对 `(platform, bot_id, group_id)` 原子预留槽位。多 Worker 并发时最多一个任务取得最后一个槽位。`choose_no_reply`、空正文、无群可见发言、确定失败或取消均释放预留。一个 Agent Run 的多段回复/多个群可见出站按一次主动发言机会计数，但每个发送尝试有独立 `delivery_id`。

### FR-IM-17-07：PASSIVE 逐条持久化并安全完成批次

PASSIVE 代表不启动 LLM，不代表丢弃消息。整段消息和完成收据必须可幂等重试；Worker 仅在数据库事务完成后 ACK。

完成事务必须：

- 使用 `(scope, event_id)` 唯一键逐条复用早落库行或补建原始消息；不写入合并文本行。
- 在早落库未发生时安全创建会话，并处理多 Worker 同时创建的竞态。
- 逐条保留发送者、到达顺序、引用、媒体归属和附件 claim；任一 claim 失败则事务回滚，不留下部分完成收据。
- 在同一事务内将早落库状态转为已消费并写入唯一 PASSIVE 完成收据，例如 `im-attention-passive-v1`。只有收据提交后才能 ACK。
- `recover_started()` 优先识别完成收据；有收据则幂等 ACK，无收据则可安全重试，不得把无助手消息的 PASSIVE 批次记成中断 Run。
- 反思按逐条用户行 ID 或稳定事件 ID 去重；后续副作用失败不得撤销已提交的消息，也不得在重试时重复登记。

数据库保证每个 `(scope, event_id)` 只有一条逻辑用户消息。SSE 使用 `message_id/event_id` 做客户端幂等；不承诺网络层物理恰好一次。新补建消息在 DB commit 后发布；已早落库且已发布的消息不再次作为新消息推送。断线补偿使用会话快照/增量重载；如需强可靠事件重放，使用事务 outbox。

运维紧急关闭门控时，入站消息回到现有 `choose_no_reply` 路径，PASSIVE 收据不适用；早落库清理、恢复及 ACK 继续遵守现有 Worker 生命周期。门控正常运行时，只有 PASSIVE 完成事务提交后才 ACK。

### FR-IM-17-08：统一群可见出站账本

配额提交以平台 API 明确接受群可见主动发言为准，不等同于所有成员客户端已显示。所有群可见出站（最终回复、流式分段、工具消息、附件确认、回退发送等）必须标明是否属于当前 `run_key`，不能留未记账的绕过路径。

发送状态至少包括 `RESERVED`、`SUBMITTED`、`ACCEPTED`、`UNKNOWN`、`RELEASED`。同一个 `run_key` 的一次主动发言机会只扣一次配额；每次尝试通过稳定 `delivery_id` 幂等。平台 API 已接受但本地回执丢失时进入 `UNKNOWN`，保留槽位并按有界对账策略恢复；在状态确认前不得立即退款或重发探测。任何群可见发送路径未纳入统一账本前，对应 Bot 不得开放 `natural` 和 `active` 模式；`quiet` 不产生自主配额。

### FR-IM-17-09：记录可解释诊断并保护消息隐私

结构化诊断记录算法版本、作用域摘要、执行范围、模式、决定、分数/门槛、原因码、快照完整性、候选数量、预算状态、实际是否启动 Run/是否出站及延迟。普通日志不得记录聊天正文、附件名或凭据；使用安全 fingerprint 与既有脱敏诊断机制。

配置按 Bot 保存并作用于该 Bot 接入的全部群，不提供逐群覆盖。配置变更不追溯取消正在执行的 Run。仅运维级全局紧急开关可关闭门控；诊断需记录用户选择的模式及紧急开关状态。

## 3. 技术方案

### 3.1 处理流程与状态边界

```mermaid
flowchart TD
    A[Gateway 原生事件] --> B[逐条保留可信消息与媒体元数据]
    B --> C[现有入队、防抖、早落库、@ 分段]
    C --> D[既有命令/交互/群模式短路]
    D --> E[读取该 Bot 的安静/自然/主动设置]
    E --> F{逐条识别 DIRECT、可信 CONTINUE 与 H 类}
    F -->|DIRECT/CONTINUE| G[现有 Agent Run 与 choose_no_reply]
    F -->|H 类| H[PASSIVE 完成事务与收据]
    F -->|开放候选| I{安静模式?}
    I -->|是| H
    I -->|否：自然/主动| Q{评分达标且配额可用?}
    Q -->|是| G
    Q -->|否| H
    G --> K[群可见出站账本]
    H --> L[事务提交后复用/补建消息并发布增量]
    L --> M[Worker 按原时序 ACK]
```

### 3.2 文件范围与职责

```text
frontend/
├── src/components/common/profile/ProfileImPane.vue 【修改】“接入咕咕”中增加群聊参与度选项，仅自动回复 Bot 显示
├── src/i18n/sections/common.ts                  【修改】三档选项、说明和条件提示
└── src/types/api.ts                             【生成】通过既有 API 类型生成流程更新，禁止手工编辑
backend/
├── app/api/v1/user_bots.py                      【修改】读取、校验和保存 UserBot 的模式字段
├── app/models/__init__.py                       【修改】UserBot 增加模式字段，默认 natural
├── alembic/versions/                            【条件】新增 UserBot 默认值及必要幂等约束迁移，不覆盖其他配置
├── agent/im/auto_reply/
│   ├── attention.py                         【新增】决策顺序与类别
│   ├── attention_features.py                【新增】高精度词法/关系特征
│   ├── attention_snapshot.py                【新增】限窗、作用域隔离与水位快照
│   ├── attention_budget.py                  【新增】原子预留、提交、释放、UNKNOWN 对账
│   ├── attention_persistence.py             【新增】PASSIVE 批次事务与完成收据
│   └── decision.py                          【不改】保留 choose_no_reply 协议
├── agent/gateway/{qq,feishu,telegram}/       【条件】只透传可核验的原生字段
├── agent/im/
│   ├── inbound_batch.py                     【修改】批次消息字段及 PASSIVE 完成接入
│   ├── inbound_recovery.py                  【修改】识别 PASSIVE 完成收据
│   ├── early_persist.py                     【修改】复用/补建状态边界
│   ├── dispatch.py                          【修改】既有短路之后、Run 前调用门控
│   ├── conversation.py                      【条件】复用现有会话/消息辅助，不把单消息 API 当批次 API
│   ├── dispatch_finalization.py              【修改】发送完成结果交给统一出站账本
│   └── replies.py                            【条件】统一各群可见出站状态
├── worker.py                                【修改】逐条传递 Redis event_id，维持 ACK/恢复顺序
└── tests/im/auto_reply/
    ├── test_attention_features.py           【新增】规则与边界
    ├── test_attention_decision.py           【新增】决策与批次语义
    ├── test_attention_persistence.py        【新增】幂等、事务、恢复、附件与 ACK
    ├── test_attention_budget.py             【新增】并发配额与出站账本
    └── test_attention_integration.py        【新增】平台路由与旧行为回归
```

职责边界：Gateway 只解析并透传平台原生结构化事实；Worker 负责 Redis 到达序、合批及 ACK 生命周期；注意力模块负责确定性分类；持久层负责逐条消息和完成收据；权限、Agent 工具范围及 `choose_no_reply` 仍由现有模块管理。只有在平台实际提供字段且 fixture 证明解析正确时，才修改对应 Gateway。不得在 Gateway 维护长期社交状态，不得新增独立 Agent Loop。

数据库若不能唯一约束 `(scope, event_id)` 或稳定出站 `delivery_id`，须先设计必要的表/索引及迁移；不得假设 `run_id` 或 `ConversationBatch` 已自动提供这些唯一性。附件 claim 继续遵守消息与附件同事务的不变量。

### 3.3 快照和并发

按 `(platform, bot_id, group_id)` 严格隔离。快照最多读取最近 12 条真人消息且不超过 120 秒；人对人交流窗口 60 秒；Bot 成功出站关系 120 秒；自主预算窗口 600 秒。当前批次消息不重复作为 prior history 输入；所有计算使用同一稳定水位。

快照/配额异常时真实 @、DIRECT 走原路径；UNKNOWN 不得加正分。自然/主动模式下无法可靠评分的普通候选只有在 PASSIVE 完成事务可靠时才静默完成，否则不 ACK 并保留可重领消息。预算使用 Redis 原子操作或数据库事务，不使用进程内字典作为跨 Worker 保证。

## 4. 验证与上线

### 4.1 行为验收

- 真实原生 @ 当前 Bot 继续走原分段、身份权限及群上下文；普通文字呼叫不能提权。
- 同一用户短时间换新话题、引用其他成员、仅问号/闲聊不免费进入 CONTINUE。
- 可信 Bot 引用媒体续接仅在规定的作用域、对象、时限、出站状态和可处理附件条件全部满足时放行；裸图/语音/贴纸及 UNKNOWN 均按 H01 静默记录。
- 同批每条消息独立评分；A 的问题与 B 的短反应不跨人拼接；H 类硬拒绝只影响命中规则的对应消息，不吞掉同批其他消息。
- H 类边界、open_candidate、P/N 特征、分数截断、阈值 69/70/71 与 54/55/56 均以固定用例覆盖。
- 覆盖安静、自然、主动三种用户设置的读写、默认值、可见条件、模式切换和 API 校验；验证安静模式不运行开放候选，自然/主动按各自阈值及配额准入。

### 4.2 持久化、恢复与出站验收

- `(scope,event_id)` 幂等；首次建会话、部分早落库、事务失败、重复投递和多 Worker 并发均无重复/缺失逻辑行。
- 多发言人消息保留各自身份、引用、顺序和附件归属；任一附件 claim 失败时不提交部分完成收据。
- PASSIVE 收据提交前不 ACK；提交后重投能识别完成且不重复写消息、发 SSE 或登记反思；ACK 后重复消息不产生新副作用。
- 运维紧急关闭后旧路径恢复；正常 PASSIVE 只有在完成收据提交后才 ACK，崩溃重投不重复完成。
- 最后一个配额槽位的并发竞争最多一个成功；`choose_no_reply`、空正文、失败、取消释放预留；API 接受、回执丢失、UNKNOWN、部分发送及多段输出均遵循账本状态机。
- 真实 @ 与工具授权不退化；群权限、命令、交互、取消、媒体、群记忆、反思和 Redis 重投回归通过。

### 4.3 直接上线与运行观测

不建设 Shadow、`hard_only` 或按群灰度阶段。完整门控在功能验收、迁移验证、平台回归和故障恢复验收通过后随版本直接上线；新旧 Bot 均默认 `natural`，用户可在“接入咕咕”按 Bot 选择安静、自然或主动。运维紧急开关仅用于线上故障回退到现有 `choose_no_reply` 路径，不作为发布阶段或用户模式。

上线后观察脱敏聚合指标：三档模式 Bot 数、各模式消息数及 Run 启动率、PASSIVE 完成和 ACK 一致性、主动额度预留/提交/UNKNOWN 数、用户明确反馈的误插话或漏接求助、门控额外耗时 P95。观察结果描述真实线上行为，不将上线前的离线用例或上线后的相关性指标宣称为随机对照因果结论。日志不保留正文、附件名或真实身份标识。

验证命令建议：

```bash
cd backend
python -m pytest tests/im/auto_reply tests/im/test_im_early_persistence.py tests/im/test_im_message_batch.py
```

后续涉及数据库迁移时，按项目迁移和测试流程验证；不以源码字符串断言代替上述消息行为、持久化和故障恢复测试。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 各平台未提供同等的引用/mention/时间元数据 | 部分特征不可用，错误把缺失信息当作“不存在”会造成误插话。 | 三值逻辑；按平台 fixture 核验；UNKNOWN 不加分、不触发 CONTINUE 或媒体例外。 |
| PASSIVE 事务或完成收据与 Worker ACK 顺序不一致 | 重投导致重复消息，或提前 ACK 导致消息丢失。 | DB 唯一键、同事务收据、故障注入验收；提交前不 ACK。 |
| 媒体入站失败或附件归属错误 | 用户提交的媒体丢失、错挂到其他发言人。 | 逐条归属和 claim；claim 失败回滚，不创建完成收据。 |
| 出站 API 成功但本地状态 UNKNOWN | 重发导致重复消息或配额被超发。 | 保留槽位、稳定 delivery ID、有界对账；不以重发探测成功。 |
| 词法规则和初始权重没有训练 | 可能漏掉有价值求助或放行无关内容。 | 默认使用自然模式；上线前完成跨平台定向边界验收，上线后观察脱敏指标并依据真实误判反馈调整。 |
| 纯媒体裸消息默认静默 | 用户无文字补发截图时咕咕不会继续处理。 | 这是 V1 明确产品取舍；只支持可信原生引用的图片/文件续接，不做内容猜测。 |

待确认事项：用户模式、默认值、设置入口和直接上线目标已确定。出站 UNKNOWN 对账时限、平台字段能力矩阵和数据库唯一键设计属于实施时需依据实际代码与平台能力验证的技术参数。

## 6. 唯一实施 TODO

### Phase 0：数据契约与确定性决策

- [ ] `IM17-001`（责任：IM Gateway/Worker）逐平台核验并透传 AttentionMessage 所需字段；验收：QQ、飞书、Telegram 的 `AVAILABLE / PARTIAL / UNAVAILABLE` 矩阵有对应 fixture，逐条 `event_id`、scope、时间、发送者、mention、reply 和媒体来源明确，UNKNOWN 不会被当成 False。
- [ ] `IM17-002`（责任：IM Auto Reply）实现 DIRECT、可信 CONTINUE、硬拒绝和 open_candidate 的确定性规则；验收：实现顺序符合 FR-IM-17-03 至 FR-IM-17-05，含媒体续接边界、同人新话题、逐条隔离及全部 P/N 特征测试。

### Phase 1：PASSIVE 幂等完成与恢复

- [ ] `IM17-003`（责任：IM 持久化/Worker）实现逐事件消息唯一性、早落库复用/补建、附件归属和 PASSIVE 完成收据；验收：事务提交前不 ACK，首次建会话、部分早落库、重复事件、多 Worker、附件失败及提交前/后崩溃均无逻辑重复或已确认消息缺失。
- [ ] `IM17-004`（责任：IM 恢复/SSE/记忆）接入 PASSIVE 收据恢复、客户端消息 ID 去重和逐条反思幂等；验收：提交后 ACK 前重投只补可恢复副作用，不重复创建消息、SSE 气泡或反思记录；故障回退时保留现有 ACK 生命周期。

### Phase 2：用户设置与门控集成

- [ ] `IM17-005`（责任：IM 配置/API/前端）为 UserBot 增加 `quiet/natural/active` 设置，并接入“接入咕咕”页面；验收：QQ、飞书、Telegram 且启用群聊和自动回复时显示三档选项；只响应 @、静默记录时隐藏但保留已选值；新旧 Bot 默认 `natural`；API 校验、迁移和其他设置保真。
- [ ] `IM17-006`（责任：IM Auto Reply/发布）在既有快捷通道后直接接入完整注意力门控，按 Bot 设置执行三档行为；验收：H 类逐条硬拒绝；安静仅放行 DIRECT/可信 CONTINUE；自然/主动按各自分数和预算准入；任何一条消息被静默时仍逐条持久化；不引入 Shadow 或中间执行模式。

### Phase 3：出站账本与直接上线验收

- [ ] `IM17-007`（责任：IM 出站/预算）统一群可见出站的 `run_key`、`delivery_id`、状态、原子配额预留及 UNKNOWN 对账；验收：工具/流式/最终/附件确认/回退发送均可归属；多 Worker 不超额；API 接受只计一次；确定未出站释放；UNKNOWN 不立即退款或重发。
- [ ] `IM17-008`（责任：IM Auto Reply/发布）完成直接上线所需跨平台行为、数据迁移、恢复和回归验收并随版本开放完整门控；验收：新旧 Bot 默认自然，用户设置即时生效且不取消运行中的 Run；紧急关闭可回退到旧路径；发布后监控模式分布、持久化/账本完整性及门控延迟。
