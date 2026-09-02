# 群组与成员记忆 PRD

> 状态：🟡 群级记忆与成员批量反思已完成；成员主体归属的自动化回归已完成，真实多人群验收待补
> 创建：2026-08-04
> 最近更新：2026-08-29
> 关联：[`【已完成】PRD-IM-2-IM-LOOP与GATEWAY解耦.md`](./【已完成】PRD-IM-2-IM-LOOP与GATEWAY解耦.md)、[`07-MEMORY-AND-REFLECTION.md`](../agent/07-MEMORY-AND-REFLECTION.md)、[`08-CHANNELS.md`](../agent/08-CHANNELS.md)、[`09-MESSAGE-PROTOCOL.md`](../agent/09-MESSAGE-PROTOCOL.md)、[`【已完成】PRD-IM-11-群成员长期记忆.md`](./【已完成】PRD-IM-11-群成员长期记忆.md)

## 1. 背景与目标

当前群聊已经有数据库短期消息窗口，但长期记忆仍复用 owner 记忆的设计讨论，容易出现三类问题：

- 群成员的公开信息被写入 owner 的个人 profile、pattern 或 memory。
- 群内身份、关系和协作信息被错误写入可跨群共享的平台用户记忆。
- 群资料、近期群状态和长期群知识混在一份文件里，无法分别更新、过期和删除。

本 PRD 为 `MemberAgentLoop` 和未来的群聊反思建立独立记忆层。它复用现有 memory 的读写、提取、压缩和检索能力，但不复用 owner 的 namespace、提示词边界和写入策略。

### 1.1 目标

1. 为每个 `platform + bot_id + group_id` 建立独立群组记忆。
2. 为每个 `platform + bot_id + platform_user_id` 建立独立平台用户记忆；同一 Bot 下同一平台用户的个人记忆可以跨群共享。
3. owner、member、unknown 读取不同范围；member/unknown 永远不能读取或写入 owner 私人记忆。
4. 群聊每条历史消息保留 `sender_id`、`sender_name`、时间和消息 ID，模型能区分是谁说的。
5. 记忆提取、daily 压缩和摘要更新全部异步执行，不阻塞当前回复。
6. 为成员退出、群解散、记忆删除和可见范围审计预留明确接口。

### 1.2 非目标

- 本阶段不修改 Web owner 记忆的六层结构和行为。
- 不把群聊消息自动转成 owner 的 profile、pattern、summary 或 memory。
- platform-user 只描述用户长期身份、偏好和个人状态；群内称呼、角色、关系、分工和决定必须留在 group scope。
- 不为每个群复制一套模型、工具或 Agent Loop；只新增作用域和编排策略。
- 不在 Gateway 中实现记忆读取、提取或压缩。

## 2. 核心概念

### 2.1 记忆作用域

物理 key 必须包含 bot 所属的 Gugu 账号和平台上下文：

```text
owner_user_id + platform + bot_id + scope_type + scope_id
```

其中：

| 字段 | 含义 |
|---|---|
| `owner_user_id` | Bot 所属的 Gugu 账号，决定存储归属，不代表当前发言人 |
| `platform` | `qq`、`feishu`、`wechat` 等 |
| `bot_id` | 当前 Gugu Bot，防止同一账号多个 Bot 串会话 |
| `scope_type` | `group` 或 `platform_user` |
| `scope_id` | 群 ID 或平台用户 ID |

裸 `group_id`、裸 `platform_user_id` 和 owner 的 `user_id` 都不能直接作为记忆 key。

统一原则：

- `platform-user` 记忆描述这个用户长期是谁、偏好什么、近期处于什么个人状态，可以在同一 Bot 的不同群之间共享。
- `group` 记忆描述当前群里的称呼、角色、关系、分工、决定和协作事项，永远不能借助 platform-user scope 跨群传播。
- 不同 Bot、不同平台和不同 `owner_user_id` 始终隔离。

### 2.2 文件格式

现有 owner memory 的真实实现是结构化 JSON + Markdown，而不是全部使用 `.md`。IM 记忆沿用这个约定：

```text
.agent/im/{platform}/{bot_id}/
├── groups/{group_id}/
│   ├── profile.json
│   ├── summary.json
│   ├── daily.md
│   └── memory.md
└── platform-users/{group_id}:{platform_user_id}/
    ├── profile.json
    ├── pattern.json
    ├── summary.json
    └── memory.md（群压缩派生事件，见 PRD-IM-11）
```

真实存储 key 还要带 `owner_user_id`，上图是逻辑目录。

群组 `daily.md` 不复用 owner daily 的容量参数。群聊消息量更大，且群 daily 是群组反思的近期缓冲，不应因为 owner 的较小保留策略过早丢掉上下文。群组不按 15 条消息频繁触发模型调用，而是以活跃窗口和空闲收束为主要触发条件；文件容量只作为异常保护。当前群组参数为：达到 200 条触发整理，整理成功后保留最近 100 条，整理失败时最多保留 300 条；这只是文件保留策略，不代表每次 Agent 请求都注入全部 100 条。成员批量反思规则见 `PRD-IM-11`：被动群消息累计 50 条触发一次，使用完整群上下文维护本批群友，不复用群级反思输出。

### 2.3 Phase 2 冻结决策

进入记忆模型和异步反思实现前，以下决策冻结，后续实现不得在代码中自行改变语义。

#### 2.3.1 文件是长期记忆主数据

`profile.json`、`pattern.json`、`daily.md`、`memory.md` 和群组的 `summary.json` 继续作为长期记忆的主数据。数据库不替代这些文件，也不把文件当成数据库的渲染产物。

数据库只负责 `reflection_job`（任务状态、重试和死信）、`reflection_cursor`（scope 游标和版本）以及 `memory_source` / `memory_entry`（来源索引、派生条目关联和删除追踪）。这些表不作为文件内容的唯一真相。文件写入成功后才推进游标；数据库索引丢失时允许从文件和消息游标重建，不能用空索引覆盖已有记忆文件。向量是可重建的派生数据。

#### 2.3.2 异步反思复用现有 worker 基础设施

群组/member 反思复用现有 Redis Streams 和独立 worker，不另起一套进程或队列执行器：

| 项目 | Phase 2 首版决策 |
| --- | --- |
| 入站消息队列 | 继续使用现有 `im:inbound`，由 `agent-workers` 消费；反思任务只在消息已落库后投递 |
| 反思任务队列 | 新增 `memory:reflection` Stream，消费组 `memory-reflection-workers` |
| 同 scope 锁 | `memory:scope:lock:{owner_user_id}:{platform}:{bot_id}:{scope_type}:{scope_id}`；反思与删除共用，同一 scope 严格串行，不同 scope 可并行 |
| 最大重试 | 5 次；达到上限转为 `dead` |
| 退避 | 1 分钟、5 分钟、30 分钟、2 小时、6 小时；参数、权限等不可重试失败直接进入 `dead` |
| 死信状态 | 保留 `dead_at`、`attempts`、`last_error_code`；不记录原始聊天正文或上游响应体 |
| 补偿扫描 | 每小时扫描未完成任务、过期锁和游标滞后的 scope；只投递幂等任务，不直接执行反思 |

`reflection_jobs.py` 是任务、锁、游标、重试和幂等状态的唯一入口，不承载提取 Prompt。执行器必须先确认 scope 未被墓碑标记，再获取锁、读取消息快照、写文件、更新来源索引，最后推进游标。

#### 2.3.3 首版触发参数

首版固定为：

- 回复完成：只推进当前 scope 的消息游标和活跃窗口，不单独因为一次回复触发模型整理；
- 普通群消息：先正常写入数据库并纳入当前活跃窗口，不按固定消息条数频繁投递；
- 群聊活跃窗口：从第一条新消息开始计时，窗口最长 1 小时；窗口内每条消息都会顺延 15 分钟空闲截止时间，若连续活跃达到 1 小时，则整理当前未整理消息一次，之后继续等待窗口内的新消息；
- 群聊空闲收束：以当前 scope 的最后一条已落库消息为基准，连续 15 分钟没有新消息时整理本轮剩余消息一次；收束完成后不主动重复整理，直到下一条新消息开启新的窗口；
- 补偿扫描：每小时一次；
- 同一 scope：严格串行，已有 pending/running 任务时合并为同一幂等任务。

普通群消息和回复完成都不因单条或少量累计而单独触发模型调用；它们只推进当前 scope 的消息游标和窗口状态。活跃窗口达到 1 小时的整理和 15 分钟空闲收束都只处理尚未推进游标的消息范围。
空闲收束完成后，当前窗口标记为 `settled`，没有新消息时不得被补偿扫描重复投递；下一条新消息落库时清除 `settled`，重新开启活跃窗口并计算新的 15 分钟空闲截止时间。窗口以最后一条已落库消息时间为准，不以 worker 轮询时间、回复完成时间或任务创建时间为准。

#### 2.3.4 owner 在群中的个人反思边界

owner 在群里仍可使用个人权限，但 owner 个人长期记忆的反思输入严格限定为 owner 自己在当前群发送的消息，以及本轮 owner 私人工具操作及其结果中明确属于 owner 的内容。群内其他成员的消息、对 owner 的评价、群体讨论和群资料只能进入当前 group scope，不能被提取到 owner 的 `profile.json`、`pattern.json`、`daily.md` 或 `memory.md`。群聊响应可以读取 group context，但响应上下文不等于 owner 个人记忆写入上下文。

#### 2.3.5 删除采用墓碑后异步清理

member、group 或 Bot scope 删除采用两阶段流程：

1. 事务内写入 scope tombstone（`deleted_at`、删除版本和 scope 身份），立即阻止新的上下文读取、任务投递和反思写入；
2. 取消或标记该 scope 的 pending/running 任务，按 `memory_source` 清理或标记派生条目；
3. 异步删除对应的记忆文件、向量和来源索引；
4. 完成文件、向量和索引校验后再物理删除 tombstone 和任务记录。

清理失败保留墓碑并由补偿扫描重试，不能因为进程中断或任务重跑把已删除 scope 重新写回来。owner 个人记忆、其他平台用户和其他群组不受影响。

## 3. 记忆内容分工

### 3.1 群组记忆

| 文件 | 内容 | 写入规则 |
|---|---|---|
| `profile.json` | 群名、群性质、明确群规、稳定协作约定、公开成员/角色概览 | 只记录群内公开且稳定的信息；不从昵称或一次对话推断身份 |
| `summary.json` | 当前群正在讨论的主题、近期状态、未完结的群内协作事项 | 作为短状态快照，允许被新消息覆盖，带更新时间和衰减 |
| `daily.md` | 近期群聊事件、决定、讨论过程和上下文流水 | 新内容追加在前；只收当前群可见内容 |
| `memory.md` | 从 daily 压缩出的稳定群知识和较长时间线 | 只保留可复用的群内事实，不复述整份 profile/pattern |

`summary.json` 必须保留。它和 `daily.md` 的区别是：summary 回答“现在群里处于什么状态”，daily 记录“最近发生了什么”，memory 记录“长期沉淀了什么”。

群组 `profile.json` 使用 `{type,text,ts}` 条目，`type` 只能是 `name`、`nature`、`rule`、`role`、`project`、`preference`、`note`。它只记录群的公开稳定事实；成员个人资料、内部 ID、推断性评价和一次性事件不得写入。群组反思通过 `profile_add/profile_remove` 增量维护，未发生变化时不创建空 profile 文件。

### 3.2 平台用户记忆

| 文件 | 内容 | 写入规则 |
|---|---|---|
| `profile.json` | 用户在当前 Bot 作用域下明确表达的稳定个人资料 | 只记录本人明确说过或可直接观察到的信息 |
| `pattern.json` | 表达习惯、协作偏好、可复用行为模式 | inferred 内容必须带置信度和时间，按现有衰减规则处理 |
| `summary.json` | 该用户近期在当前 IM 里的状态或话题 | 轻量快照，不等同于 owner 的完整 summary |

平台用户记忆不是 Gugu 用户 profile。即便它们映射到同一个 Gugu owner，也必须通过身份和角色策略明确决定是否可读。

平台用户 `profile.json` 的主数据格式为 `[ {"type": "name|address|pronoun|background|preference|note", "text": "..."} ]`，不含 `id`、`ts` 或置信度字段；它只服务于当前 Bot 作用域下对该平台用户的轻量识别和称呼。owner 的 profile 使用同样的六类 `type`，但保留 `ts` 作为审计字段。旧 profile 缺少 `type` 时统一按 `note` 兼容，并在后续写回时完成结构规范化。

`profile.json` 和 `pattern.json` 只保存稳定或可复用的个人信息；近期状态和个人话题优先进入 `summary.json` 或 daily/recent 层，必须带时间并允许衰减，不能多年后仍被当成稳定身份。

## 4. 上下文读取策略

### 4.1 owner

owner 在群聊中使用 Web/owner 的完整 Agent Loop：

```text
owner 个人完整记忆
+ 当前群 profile/summary
+ 当前群最近消息窗口（每条带 sender_id/name）
```

owner 的个人记忆可以继续读取和写入；群内公开内容只能写入当前群记忆，不能反向改变 owner 个人记忆。

owner 在群里主动调用个人项目、文件、日程、记忆或其他私人工具，视为授权将本次请求所需结果回复到当前群。不增加二次确认，也不主动扩展到 owner 未请求的其他私人内容。owner 仍使用完整 Agent Loop；member 和 unknown 永远不能借用 owner 权限。

当前群的公开记忆进入共享会话 snapshot 前缀，在 snapshot 首次建立、TTL 到期或 baseline 更新时重新读取；普通记忆版本变化只记录 pending revision，不会让每一轮缓存失效。snapshot 只保存 group scope，不保存任何 platform-user 内容。会话预算与 baseline 生命周期以 PRD-AGENT-4 为准。

### 4.2 member

member 使用轻量 Member Loop：

```text
当前群 profile/summary
+ 当前发言人的 platform-user profile/pattern/summary
+ 当前群最近消息窗口
+ 工具白名单
```

默认不读取当前群完整 `memory.md`，避免把较长历史和敏感群内背景直接暴露给成员；是否开放群长期记忆由群策略单独决定。member 永远不读取 owner 的 profile、pattern、summary、memory、项目、文件和日程。

当前发言人的 `platform-user` 记忆按请求动态读取，放在当前用户消息之前的独立 reminder 中，不写入群 session 的 snapshot 或历史消息。它与群公开记忆分别做权限判断和预算控制：每个 scope 最多注入 2000 字符，超出按 summary → profile → pattern 的顺序截断。

### 4.3 unknown

```text
当前群公开 profile/summary
+ 当前群最近消息窗口
+ 最小工具白名单
```

unknown 只是身份解析失败时的兜底角色，不代表群外陌生人。unknown 可以读取当前群 profile/summary 和最近消息，但不加载 platform-user 个人记忆、不触发 platform-user 写入，并使用最小工具白名单。

群公开记忆只在 snapshot 重建时更新；成员个人记忆不参与共享 snapshot，避免同一群 session 因不同成员发言而互相泄漏。

### 4.4 历史消息格式

内部模型上下文必须保留明确发言人边界：

```text
[2026-08-04 12:30] CoffeiZzz (platform_user_id=...): 消息内容
```

真实 ID 只进入内部上下文和权限判断，不进入普通用户可见的诊断日志。昵称只用于称呼，绝不用于身份合并。

### 4.5 ActorResolver 契约

`owner`、`member`、`unknown` 必须由确定性的 `ActorResolver` 产生，不能由模型、昵称、语气或群内评价判断：

```text
输入：owner_user_id、platform、bot_id、group_id、platform_user_id、平台成员信息、身份绑定信息

输出：
{
  "role": "owner | member | unknown",
  "platform_user_id": "...",
  "group_id": "...",
  "bot_id": "...",
  "resolved_at": "...",
  "policy_version": 1
}
```

- 只根据平台 ID 和绑定关系判断。
- 无法确认时降级为 `unknown`。
- 异步反思必须保存消息发生时的角色和 scope 快照，不能在执行时重新猜测。
- owner 不会因为群昵称变化而失去或获得身份。

## 5. 写入、反思与压缩

### 5.1 触发时机

| 场景 | 数据库短期消息 | 群组记忆 | 发言人/私聊对象记忆 |
|---|---:|---:|---:|
| 未 @、未进入 Agent 的普通群消息 | 立即写入 | 群 scope 维护群本身；累计 50 条另起 member-batch 维护本批群友 | 由 member-batch 批量维护 |
| @ 咕咕并进入 Agent | 立即写入 | 按群窗口异步反思 | 不触发群友单独反思 |
| 进入 Agent 且使用工具 | 立即写入 | 按群窗口异步反思 | 不触发群友单独反思 |
| owner 在群中发言 | 立即写入 | 异步反思 | owner 继续沿用现有 owner 反思路径 |
| 私聊 / Web | 私聊每个 Agent 回合立即调度 `private_reflection`；Web 继续 owner 反思 | 不适用 | 私聊对象仍写入隔离的 platform-user scope；群聊成员只由完整群上下文的 member-batch 维护 |
| 反思失败 | 不影响回复 | 保留数据库消息，下次重试 | 保留数据库消息，下次重试 |

当前参数固定为：被动群消息由 group scope 累计 50 条触发一次 `member-batch`，主动进入 Agent 的消息不触发成员反思；群级反思继续由活跃窗口和 15 分钟空闲收束负责，每小时扫描空闲 scope。群级任务和成员批任务使用独立游标，任务失败按退避时间补偿重投。反思和周期整理都不能阻塞当前回复。

### 5.2 反思可靠性协议

反思任务和 scope 游标分开持久化：

```text
reflection_job
- job_id
- scope
- from_message_id
- to_message_id
- idempotency_key
- extractor_version
- status / retry_count

reflection_cursor
- scope
- last_reflected_message_id
- scope_version
- updated_at
```

- 同一 scope 的反思任务串行执行。
- 同一消息范围重复投递必须幂等；建议使用 `(scope, from_message_id, to_message_id, extractor_version)` 作为幂等键。
- 游标更新必须带版本控制，避免并发反思覆盖较新的结果。
- 任务写入 `memory:reflection` Stream，由 `memory-reflection-workers` 消费组执行；失败不影响主回复，最多重试 5 次并按 1m/5m/30m/2h/6h 退避，超过上限进入 `dead`，长期失败由每小时补偿扫描处理。
- 同一消息可以分别进入 group 和 platform-user 两个 scope，但两个 scope 的任务、游标和写入必须独立。

### 5.3 群组 daily 容量与压缩

群组 daily 使用独立于 owner memory 的容量策略：

| 参数 | 群组首版值 | 语义 |
|---|---:|---|
| 整理阈值 | 200 条 | 达到后把较早的群 daily 整理进群组长期摘要/记忆；正常情况下优先由 1 小时活跃窗口或 15 分钟空闲收束触发 |
| 整理后保留 | 100 条 | 整理成功后保留近期群记录，适应多人群的消息量 |
| 失败硬上限 | 300 条 | 整理失败时保留原始 daily，超过上限也不得静默删除；应进入失败告警/补偿流程 |

容量参数只控制群组记忆文件，不改变数据库短期消息保留的 500 条上限，也不等于上下文注入预算。群公开记忆与 platform-user 记忆各自最多注入 2000 字符；群公开记忆进入 snapshot 前缀，成员记忆按当前发言人动态注入，不能因为 daily 保留 500 条就把 500 条全文塞入每次 Agent 请求。

反思快照只取已落库且带平台用户身份的 `user` 消息；assistant/tool 消息不作为 group/member 长期记忆来源，避免把 owner 的私人工具结果或系统内部中间结果写入 IM 记忆。需要展示模型回复时，仍由当前会话历史负责，不由长期记忆反思复刻。

### 5.3 信息类型与目标 scope

| 信息类型 | 目标 scope | 规则 |
|---|---|---|
| 用户明确自述的职业、兴趣、长期身份 | platform-user | 可进入 profile；只记录本人明确表达的内容 |
| 表达习惯、回复偏好、稳定协作方式 | platform-user | 可进入 pattern；inferred 内容必须带置信度和时间 |
| 用户近期个人状态、个人话题 | platform-user summary/daily | 必须带时间并允许衰减，不直接当作永久 profile |
| 当前群里的昵称、称呼 | group profile | 只属于当前群，不能写入 platform-user |
| 当前群角色、负责人身份、项目分工 | group profile/summary | 只记录当前群语境下的明确事实 |
| 群内关系、决定、讨论和协作事项 | group daily/memory | 只处理当前群可见内容 |
| 从昵称推断真实身份 | 禁止持久化 | 不允许写入任何长期 scope |
| 从语气推断性格或敏感属性 | 禁止持久化 | 不允许写入任何长期 scope |
| 根据其他成员评价更新某人的个人 profile | 禁止持久化 | 除非本人明确自述并符合 platform-user 规则 |
| owner 私人工具结果 | 禁止写入 group/member | 可以按请求回复当前群，但不复制为群记忆 |
| 数据库已能查询的项目、文件、日程状态 | 禁止持久化 | 使用工具实时查询，不复制进长期记忆 |

### 5.4 提取边界

- 群组反思只处理当前群公开可见消息。
- 成员反思只处理当前 `platform_user_id` 的发言和明确自述。
- 不能从昵称、语气、群内他人评价推断真实身份、关系或敏感属性。
- 不能把工具返回的 owner 私人资料写入群组或 member 记忆。
- 结构化数据库已经能查到的项目、文件、日程状态不复制进长期记忆。

### 5.5 来源追踪

长期记忆条目必须能追溯来源，至少保留：

```json
{
  "source_message_ids": [],
  "source_actor_ids": [],
  "source_scope": "...",
  "extractor_version": "...",
  "created_at": "...",
  "updated_at": "..."
}
```

实现阶段优先使用 `memory_entry` + `memory_source` 关联模型，避免来源数组无限增长。来源追踪用于防止重复提取、定位记忆来源、删除派生内容，以及在提取器升级后重建记忆。

### 5.6 压缩

复用 `agent/memory/daily_compaction.py` 的固定批次 daily→memory 编排，但 prompt、scope 和输入字段仍保持独立。群组长期记忆同样保留重要历史和时间脉络，压缩输出上限为 15000 tokens；普通闲聊可以合并，不要求逐条保留。群组保留窗口仍为最近 500 条，每次只处理最多 100 条，尚未处理的旧记录继续保留，避免一次性把全部积压内容交给模型：

```text
group daily.md → group memory.md
```

不允许把群 daily 送进 owner 压缩器，也不允许压缩器写入 owner namespace。失败时保留原 daily，不覆盖已有 memory。

## 6. 文件与代码职责

### 6.1 复用原则：复用引擎，不复用记忆策略

群组/member 记忆不复制一套完整的 memory 系统，也不能直接调用 owner 的默认反思和压缩行为。采用“共享底层原语 + 独立 scope 策略”的结构：

**可以共享：**

- 文件/对象存储读写、原子写入和 JSON/Markdown 序列化。
- daily 读取、追加、按日期分组和成功后裁剪。
- memory 写入、向量缓存同步、模型 tag 失配和重建。
- LLM 结构化调用、超时、失败保护和结果解析。
- 反思任务的幂等、游标、重试和并发控制。

**必须独立：**

- owner、group、member 各自的 `MemoryScope` 和安全 key。
- 反思/压缩 Prompt、输入字段和允许写入的文件白名单。
- 信息类型到目标 scope 的过滤规则。
- owner/member/unknown 的可读范围和隐私策略。
- group/member 的来源追踪和删除边界。

因此不允许让 `im_reflection.py` 直接复用 owner 的完整 `reflection.py` 流程，也不允许让 group daily 直接调用 owner 的默认 `compress.md`。通用压缩引擎接收显式 scope 和策略：

```python
compact_scope(
    scope=group_scope,
    source=daily,
    target=memory,
    prompt=group_compress_prompt,
    policy=group_memory_policy,
)
```

owner 压缩重点是个人经历、长期背景和个人行为；group 压缩重点是群性质、公开角色、协作决定、分工和群内时间线；member 压缩重点是该平台用户明确表达的个人资料、偏好和协作习惯。群组/member 压缩不得从昵称、群友评价或语气推断真实身份和敏感属性，也不得把 owner 私人工具结果写入群或成员记忆。

```text
backend/agent/
├── memory/
│   ├── store.py              # 通用底层读写、渲染、向量缓存；保持 owner 行为兼容
│   ├── scopes.py             # MemoryScope 构造、校验和安全 key
│   ├── scoped_store.py       # 按 MemoryScope 读写 profile/summary/daily/memory
│   ├── scope_lifecycle.py    # tombstone、异步删除、scope 管理摘要
│   ├── reflection.py         # owner 反思，保持现有六层记忆行为
│   ├── im_reflection.py      # group/member 反思、边界过滤和异步任务入口
│   ├── reflection_jobs.py    # 反思任务、scope 游标、幂等和重试状态
│   ├── compress.py           # 通用 daily→memory 原语；不持有 owner 或 IM 业务判断
│   ├── compression_policy.py # 各 scope 的字段白名单、保留规则和 Prompt 选择
│   └── _llm.py               # 记忆专用结构化模型调用
├── im/
│   ├── context_policy.py     # owner/member/unknown 的可读范围
│   ├── context_loader.py     # 只读装配当前 scope 的上下文
│   ├── actor.py              # ActorContext 与 ActorResolver：根据平台 ID、Bot 绑定和群信息解析角色
│   ├── session.py            # DB 短期消息和 recent window；不写长期记忆
│   ├── loop.py               # 选择 Loop、触发异步反思，不实现提取算法
│   └── models.py             # PlatformMessage、ActorContext 和消息元数据
└── prompts/
    ├── reflection.md         # owner 反思 prompt
    ├── memory_compress.md    # owner 记忆沉淀 prompt
    └── im/                   # group/member 专用 prompt（实现阶段新增）
        ├── group_reflection.md
        ├── group_compress.md
        └── member_reflection.md
```

职责红线：

- Gateway 只解析平台事件、附件、即时 ack 和出站协议，不碰记忆。
- `session.py` 只负责短期 DB 历史，不承担 daily/memory 写入。
- `context_policy.py` 只决定能读什么，不直接拼 prompt。
- `context_loader.py` 只读，不触发反思和压缩。
- `im_reflection.py` 是唯一的 group/member 长期记忆写入口。
- `actor.py::ActorResolver` 是唯一的 owner/member/unknown 身份解析入口；模型、昵称和语气不能参与角色判断。
- `reflection_jobs.py` 是唯一的反思任务与 scope 游标管理入口。
- `scoped_store.py` 是唯一将逻辑 scope 转成存储 key 的入口。
- `compress.py` 只实现通用压缩生命周期、写入保护和向量同步，不决定内容取舍。
- `compression_policy.py` 负责选择 scope 对应的 Prompt、输入字段、可保留信息和禁止写入的信息。
- owner 继续由 `reflection.py + prompts/reflection.md + prompts/memory_compress.md` 驱动；group/member 由 `im_reflection.py + prompts/im/*` 驱动，共享底层引擎但不共享业务策略。
- `loop.py` 只负责编排和投递异步任务，不能复制 owner reflection。

## 7. 数据生命周期与隐私

1. 数据库短期群消息继续按 `platform + bot_id + chat_id` 隔离，当前保留上限由 [`09-MESSAGE-PROTOCOL.md`](../agent/09-MESSAGE-PROTOCOL.md) 维护。
2. 记忆文件按相同 scope 保存，不能因清理 Redis session 而误删长期记忆。
3. 成员记忆必须支持按 `platform_user_id` 删除；群解散或 Bot 解绑时必须支持按整个 group scope 删除。
4. 群记忆删除不影响 owner 个人记忆；owner 记忆维护也不应扫描 IM namespace。
5. 删除 member、group 或 Bot scope 时，同时按来源追踪清理或标记派生记忆。
6. 日志只记录 scope、角色、数量、版本和脱敏 ID 指纹，不记录正文、文件名或记忆内容。
7. 管理员面板已区分 owner memory 与 IM memory；IM 记忆只提供不含用户、群组或成员标识的整体汇总预览，并通过确认后批量投递未反思消息，禁止用 owner 的“记忆维护”按钮误操作群记忆。
8. 删除先写 tombstone，再异步清理文件、向量、来源索引和待执行任务；清理完成并校验后才物理删除 tombstone。

## 8. 实施阶段

### Phase 0：契约与边界

- [x] 确认 scope、文件格式、owner/member/unknown 读取边界。
- [x] 确认群组 summary 保留，group 不拆 short-term/long-term 文件。
- [x] 确认 platform-user 在同一 Bot 下跨群共享个人记忆，group 信息不跨群传播。
- [x] 增加信息类型 → 目标 scope 矩阵、owner 群内调用规则和 unknown 定义。
- [x] 定义 ActorResolver、反思任务/游标和来源追踪契约。

### Phase 1：身份、作用域与只读上下文

- [x] 新增 `ActorResolver`，只根据平台 ID、Bot 绑定和群信息返回 owner/member/unknown。
- [x] 新增 `MemoryScope` 和安全 key 构造。
- [x] 为 owner 旧 key 保留既有显式兼容路径，不改变 owner 数据。
- [x] `context_loader` 按角色加载 group profile/summary、member 轻量记忆和消息窗口。
- [x] 默认关闭 member 的 group memory 全量读取。
- [x] 验证 owner/member/unknown 不会互相注入。

### Phase 2：记忆模型与异步反思

- [x] 新增记忆条目来源追踪模型。
- [x] 新增反思任务、scope 游标、幂等键和版本控制。
- [x] 复用现有 Redis Streams/worker，接入 `memory:reflection` 队列、scope 锁、5 次重试、退避和 dead 状态。
- [x] 新增 scoped store 的读写单测和跨 Bot/跨群隔离测试。
- [x] 新增 group/member 专用提取 prompt 和 `im_reflection.py`。
- [x] 按冻结参数接入 1 小时活跃窗口整理、15 分钟群聊空闲收束且每轮只触发一次，以及每小时补偿触发；普通消息不按固定条数频繁触发。
- [x] 阻止 owner 群聊整轮响应进入个人反思，避免其他成员内容污染 owner memory；owner 私人工具结果的独立采集仍留在 Phase 4。
- [x] 接入 group daily→memory 压缩：200 条容量阈值、成功后保留 100 条、失败硬上限 300 条；失败不影响主流程。

Phase 2 实现备注：消息落库后只推进 scope 游标，实际反思由 `memory:reflection` worker 异步执行；同一 scope 使用 Redis 锁串行，任务失败按 1m/5m/30m/2h/6h 重试，重试补偿和 15 分钟空闲 scope 均每 30 秒扫描。

### Phase 3：生命周期与管理

- [x] 以 tombstone 先行实现成员记忆删除、群解散清理、Bot 解绑清理，并在异步级联清理完成后硬删除。
- [x] 管理员面板提供 IM 记忆整体汇总预览，并支持确认后批量投递未反思消息；不向前端返回 scope 标识或正文。
- [x] 删除任务失败保留 tombstone，并由 worker 补偿重投；管理接口只记录 scope 和状态，不返回正文到日志。
- [x] 新增删除屏障、对象存储前缀清理、任务/游标/来源索引清理的回归验证。

### Phase 4：上下文、权限与端到端验收

- [x] owner/member/unknown 使用同一 IM Loop 编排，但通过 `ActorResolver`、`context_policy` 和 `allowed_tool_names` 隔离读取范围与工具白名单。
- [x] 群组上下文只读取当前 Bot + 当前群的 group scope；member 只读取当前平台用户的轻量 scope。
- [x] owner 群聊个人反思只接收 owner 当前发言和明确的私人工具结果，不接收群内其他成员或助手整轮回复。
- [x] 删除中的 scope 不进入上下文、不创建反思任务、不写入记忆文件。
- [x] 在 devserver 完成真实 QQ/飞书/微信多平台消息、空闲窗口、压缩、删除和重新建 scope 的人工验收。

## 9. 验收清单

### 自动验收

- [x] 同一群、不同 Bot 的记忆 key 不相同。
- [x] 同一 Bot、不同群的 group profile/summary/daily/memory 不互相读取。
- [x] 同一 Bot、同一 `platform_user_id` 在不同群可以读取个人 platform-user 记忆。
- [x] platform-user 记忆中的群特定称呼、角色、关系和分工不会跨群传播。
- [x] 不同 Bot、不同平台和不同 `owner_user_id` 的 platform-user 记忆互相隔离。
- [x] owner 在群中主动调用个人工具时，只回复本次请求所需结果，不扩展读取无关私人内容。
- [x] member/unknown 不读取或写入 owner memory。
- [x] group/member 反思失败不影响当前回复，原始 DB 消息仍保留。
- [x] daily 压缩失败不覆盖原 daily 或已有 memory。
- [x] 每条群历史上下文带 sender ID、sender name、message ID 和时间。
- [x] 删除 member、group、Bot scope 后对应记忆可完整清理，其他 scope 不受影响。

### 手动验收

1. owner 在群里查询自己的项目，行为与 Web 一致；群消息只作为额外上下文。
2. member 询问 owner 的资料、文件和项目时，不能读到 owner 私人内容。
3. 私聊对象的 platform-user scope 使用根据 owner 规则优化的 `private_reflection`；群聊成员只由完整群上下文的 member-batch 维护。
4. 两个群讨论同名项目时，互相不会召回对方的群 memory。
5. 同一用户在两个群使用不同称呼时，各群称呼保留在各自 group scope；个人信息仍可从 platform-user scope 共享。
6. 普通未 @ 消息只落库；后续 @ 时能读到带发言人的最近窗口。
7. 反思和压缩在后台运行时，当前回复没有额外等待。
8. 删除群记忆后重新发言，不会读到已删除的旧群资料。

## 10. 风险与决策

| 风险 | 决策 |
|---|---|
| group memory 可能包含成员敏感信息 | 默认只写群内公开、明确表达、可复用内容；后续提供删除和可见范围管理 |
| 记忆文件数量增长 | 先使用现有对象存储 key；向量缓存可重建，不把向量当主数据 |
| member 上下文过长 | 默认只读 group profile/summary + recent window，长期 memory 由群策略开启 |
| 群内容与 owner 内容边界模糊 | 通过 role + scope 双重门禁，禁止仅凭 `owner_user_id` 放行 |
