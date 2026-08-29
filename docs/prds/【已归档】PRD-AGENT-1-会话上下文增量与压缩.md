# PRD-AGENT-1 会话上下文增量与压缩

> 💡 本文仅保留历史背景。当前实现细节以 [`PRD-AGENT-4：统一 ContextBudget 上下文压缩重构`](./PRD-AGENT-4-统一ContextBudget上下文压缩重构.md) 为准；checkpoint、20%目标和旧双阈值描述均已被 baseline 生命周期替代。
>
> 状态：Phase 0 待评估
> 创建：2026-08-08
> 最近更新：2026-08-08
> 关联模块：`backend/agent/context/`、`backend/agent/core.py`、`backend/agent/runner.py`、`backend/agent/loop_drivers.py`
> 背景参考：现有 `builder`、`compress_conv` 与 Agent Loop 上下文装配逻辑
>
> v0.2 核心修订：不再把 `Session Tape` 作为最高层概念，而是把 **Persistent Session Context（持久 Session 上下文）** 定义为一级实体；`Stable Context / Cached Context / Compacted State / Recent Tape / Context Budget` 都属于 Session。Agent Loop 只消费 Session Context，不拥有它。
>
> 本文只定义目标、边界、分阶段方案与验收标准；不要求一次性重写现有 `builder / runner / core / loop_drivers`，优先以可回退的增量方式迁移。

---

## 0. 一句话

**Context 属于 Session，不属于一次 Agent Loop。**

Session 创建时完成一次上下文 Bootstrap；之后用户消息、assistant 回复、tool call、tool result、状态变化持续追加到同一份 Session Context。运行中的 provider 请求达到硬预算时，只压缩当前 run 之前的历史，保护当前 run 的消息链继续工作；run 完成后达到 90% 软阈值时，再异步创建 checkpoint，下一条用户消息消费该 checkpoint。

项目 / 日历 / 文件等业务数据仍以数据库为 Source of Truth，但不再每轮无条件重载：Session 持有带 revision 的缓存，自身 tool mutation 直接 patch，外部变化通过 revision / invalidation 选择性刷新。

目标形态：

```text
Session 创建
   ↓
Context Bootstrap（一次）
   ↓
┌──────────────────────────────────────┐
│ Persistent Session Context           │
│                                      │
│ Stable Context                       │
│ Cached Business Context + revisions  │
│ Compacted Session State              │
│ Recent Session Tape                  │
│ Context Budget / Checkpoint          │
└──────────────────────────────────────┘
          ↑                   ↓
       append / patch      render
          ↑                   ↓
     每次用户事件          Agent Loop
          ↑                   ↓
          └──── commit events ┘

达到阈值 → compact old tape → 新 checkpoint → 继续 append
```

---

## 1. 为什么改

咕咕当前已经有三个不错的基础：

1. `agent/context/builder.py` 已将稳定 system prefix 与动态上下文拆开，利于 Prompt Cache。
2. `agent/core.py` 在单次 Agent Loop 内已复用同一个 messages 状态，tool round 是增量追加的。
3. `agent/context/compress_conv.py` 已有长会话滚动摘要机制。

所以问题不是“咕咕完全没有增量上下文”，而是 **增量只存在于一次 Agent Loop 内，Session 自身还不是长期活着的上下文实体**。

当前更接近：

```text
用户发消息
  ↓
重新 load_context_data()
  ↓
重新拼 dynamic context
  ↓
重新选 history
  ↓
Agent Loop 内 append
  ↓
结束
```

目标改成：

```text
Session Context 已存在
  ↓
append 当前用户事件
  ↓
检查必要 invalidation
  ↓
render 当前 Context
  ↓
Agent Loop
  ↓
append tool / assistant / state events
  ↓
必要时 compact
  ↓
Session Context 继续存在
```

### 1.1 当前方案的主要浪费

每个用户回合重新装配以下内容：

- 用户基础资料；
- locale / timezone；
- 风格偏好；
- IM 身份 / channel facts；
- 项目、日历、文件概览；
- memory 检索结果；
- 最近 conversation history。

其中一部分在一个 Session 生命周期里几乎不变，却会重复：

```text
DB read → format → tokenize → prompt append
```

这不仅增加查询和拼装开销，也让“模型当前经历过什么”依赖每轮重建，而不是 Session 本身连续保存。

### 1.2 当前方案的语义问题

当前 Conversation History 更像聊天记录，而不是完整 Agent 工作轨迹：

- tool round 的持久化受 provider format 影响；
- compaction 主要消费 `content` 文本，工具状态变化容易丢失；
- 用户看到的 Conversation、Agent 经历的事件、实际送进模型的 Context 没有正式分层；
- Session 没有自己的长期 checkpoint / revision / budget。

---

## 2. 核心定义

### 2.1 Session 是上下文生命周期边界

一个 Session 创建后拥有自己的 `PersistentSessionContext`。

Agent Loop 只是 Session 生命周期中的一次执行：

```python
session = await session_manager.get(session_id)
context = await session.context.prepare(current_event)
result = await agent_loop.run(context.render_for_model())
await session.context.commit(result.events)
```

Agent Loop 不关心：

- 这是 Session 第 1 轮还是第 300 轮；
- Context 是刚 bootstrap 还是刚 compact；
- 哪些业务数据来自缓存、哪些刚刷新；
- 当前 checkpoint 已经滚动过几次。

### 2.2 三个容易混淆的对象必须拆开

```text
Conversation
= 用户真正看到的聊天记录

Session Tape
= Agent 实际经历过的语义事件流

Model Context
= 某次模型调用实际收到的上下文投影
```

因此：

```text
Conversation ≠ Session Tape ≠ Model Context
```

Conversation 可以只包含：

```text
user
assistant
user
assistant
```

Session Tape 可能是：

```text
user_message
turn_contract
tool_call
tool_result
state_change
assistant_message
user_message
turn_contract
...
```

Model Context 则可能是：

```text
Stable Context
Compacted Session State
必要的 Cached Context
最近一段 Session Tape
```

---

## 3. Persistent Session Context 数据模型

建议概念结构：

```text
PersistentSessionContext
│
├── metadata
│   ├── session_id
│   ├── user_id
│   ├── channel
│   ├── sender_scope
│   ├── locale
│   ├── created_at
│   └── last_active_at
│
├── stable_context
│   ├── persona / policy
│   ├── user profile projection
│   ├── stable preferences
│   ├── permissions / capability scope
│   └── session configuration
│
├── cached_context
│   ├── projects + revision
│   ├── calendar + revision
│   ├── files + revision
│   ├── preferences + revision
│   └── other business projections
│
├── compacted_state
│   ├── goals
│   ├── decisions
│   ├── constraints
│   ├── important_facts
│   ├── changed_state
│   ├── unresolved
│   └── important_refs
│
├── recent_tape
│   ├── user_message
│   ├── assistant_message
│   ├── turn_contract
│   ├── tool_call
│   ├── tool_result
│   ├── state_change
│   └── system_event
│
└── budget
    ├── estimated_tokens
    ├── compact_threshold
    ├── target_after_compact
    └── checkpoint_id
```

该模型是逻辑结构，不要求第一版一次性创建一张大表；可以先基于现有 ConversationMessage / session 数据增量演进。

---

## 4. Stable Context：Session 期间固定保留

以下内容默认只在 Session Bootstrap 时装入，后续不应每轮重复读取 / 拼装：

- persona；
- system policy；
- skills / execution policy 的稳定部分；
- 用户基础 profile 投影；
- locale；
- timezone（若用户设置没变化）；
- style preferences 的稳定部分；
- 当前 channel / sender scope；
- 权限与 capability scope；
- Session 创建时确定的运行配置。

Stable Context 的目标是尽量形成高命中的稳定 prompt prefix：

```text
[stable system / persona / policy / user projection]
[compacted state]
[recent incremental tail]
```

### 4.1 Stable 不等于永远不可变

如果用户主动修改：

- locale；
- timezone；
- profile；
- style preferences；
- 权限；

应通过 revision / explicit invalidation 更新 Session Context，而不是等 Session 重建。

---

## 5. Cached Business Context：缓存，不是真值

项目 / 日历 / 文件等不能像 persona 一样永久固定，因为它们可能被：

- 当前 Agent；
- Web UI；
- IM；
- 定时任务；
- 其他 Session；
- 其他 worker

修改。

因此它们在 Session 中属于 **Cached Context**：

```yaml
projects:
  revision: 152
  projection: ...

calendar:
  revision: 87
  projection: ...
```

Source of Truth 仍然是业务数据库。

### 5.1 自身 mutation：直接 patch

例如当前 Session 执行：

```text
update_project(id=123, deadline=...)
```

成功后：

```text
DB mutation success
      ↓
append tool_result
      ↓
append state_change
      ↓
patch session.cached_context.projects
      ↓
projects_revision 同步到最新
```

不要自己改完后马上重新整域读取。

### 5.2 外部 mutation：revision invalidation

例如 Web UI 改了项目：

```text
projects_rev: 152 → 153
```

Session 下一次 prepare 时：

```python
if session.projects_rev != source.projects_rev:
    refresh_projects_projection()
```

只有变化的 domain 刷新。

目标：

```text
无变化 → 不 reload
自身变化 → patch
外部变化 → selective refresh
```

而不是每轮 `load_context_data()` 全量重建。

---

## 6. Session Tape：连续事件流

Session Tape 是 Persistent Context 的增量部分，不再局限于 Agent Loop 内的 provider messages。

建议 Provider-neutral event type：

```text
user_message
assistant_message
turn_contract
tool_call
tool_result
state_change
system_event
compaction_checkpoint
```

### 6.1 Provider 只负责投影

Anthropic / OpenAI / 其他 provider driver 只负责：

```text
SessionEvent → provider wire format
provider output → SessionEvent
```

不能再由 provider format 决定“Session 记住哪些工具历史”。

### 6.2 不需要永久保存所有内部噪音

以下内容可标记 ephemeral / non-persistent：

- verify nudge；
- empty retry；
- provider-specific framing；
- 无语义价值的中间控制消息。

持久 Tape 只保留对后续 Session 有意义的事件。

---

## 7. Turn Contract：把执行意图结构化

为了减少通过自然语言正则反推“这一轮到底需不需要工具”，每轮 Agent Loop 应建立轻量 `TurnContract`。

概念 schema：

```ts
type TurnContract = {
  mode: 'answer' | 'read' | 'write' | 'clarify'
  target?: string
  expected_effect?: string
}
```

语义：

```text
answer
→ 允许零 tool

read
→ 必须发生必要的读取工具行为

write
→ 必须发生 mutation tool / state change

clarify
→ 允许零 tool，等待用户补充信息
```

Loop 结束 Guard 不再主要依赖：

```text
“我马上帮你改”
“I'll update it now”
```

这样的语言正则，而是对照：

```text
Turn Contract（这一轮声明要做到什么）
            vs
Execution Trace（这一轮实际发生了什么）
```

例如：

```python
if contract.mode == 'write' and not trace.has_mutation:
    continue_loop()
```

该设计同时为未来 i18n 去除中文 Regex Guard 依赖。

> Turn Contract 不要求额外增加一次 LLM 调用。优先与同一轮模型执行合并，或使用内部 `begin_turn` / structured control event 方式进入 Tape。

---

## 8. Model Context Render

Persistent Session Context 不是原样全部塞进模型。

每次调用前由 Context Manager 生成当前 Model Context：

```text
Stable Prefix
+
Compacted Session State
+
必要的 Cached Business Projection
+
Recent Session Tape
+
当前 Ephemeral Facts
```

Ephemeral Facts 包括：

- 当前时间；
- 当前 user event；
- 当前 sender / channel 临时信息；
- query-sensitive memory retrieval；
- 本轮刚 refresh 的业务状态。

### 8.1 Memory 仍可 query-sensitive

长期 memory 不一定适合 Session 创建时一次性全固定。

建议区分：

```text
Stable profile / preference projection
→ Session 保留

Query-sensitive memory retrieval
→ 随当前用户消息按需检索
```

检索结果可进入当前 Context / Tape，但不等于长期写死在 stable_context。

---

## 9. 滚动 Compaction

Context 达到预算水位后，不简单 truncate，也不只生成 300 字“聊过什么”的摘要。

应该把较老 Tape 折叠成 **结构化 Session 状态 checkpoint**。

例如：

```yaml
goals:
  - 完成咕咕 1.0 发布准备

decisions:
  - 桌面端采用 Electron
  - 1.0 首发思维面板

constraints:
  - Agent Loop 最大 6 round

important_facts:
  - 用户希望交互效果遵循 Runtime demo

changed_state:
  - project:123.deadline = 2026-10-01
  - calendar:51 created

unresolved:
  - 桌面端打包方案尚未确定

important_refs:
  - project:123
  - file:456
```

### 9.1 滚动方式

```text
Stable Context
Compacted State v3
Recent Tape 70k
        ↓ 达阈值

Compacted State v3
+ Tape 较老 40k
        ↓ compact

Compacted State v4
+ Recent Tape 剩余 30k
```

继续 append；下一次再次合并旧 checkpoint + 新 old tape。

### 9.2 Tool 不能在 Compaction 中消失

当前旧逻辑若只读取 `message.content`，`content_json` 中的 tool history 会在压缩时丢失。

新 Compactor 必须理解语义事件：

```text
tool_call
+ tool_result
+ state_change
```

并提炼为：

- 读取到了什么重要事实；
- 修改了什么真实状态；
- 成功 / 失败；
- 资源引用；
- 未解决错误。

可以丢过程，不可以丢结果状态。

### 9.3 运行中压缩与完成后 checkpoint

压缩分为两个时机，不能共用一个模糊的“达到阈值”定义：

1. **运行中硬预算**：每次 tool result 追加后、准备进入下一轮 provider 请求前重新估算。若达到模型实际可用上限，只压缩当前 run 之前的历史；当前 run 的用户消息、tool call、tool result 和最终输出作为受保护后缀继续保留。
2. **run 完成后软预算**：本轮已经向用户输出完成后，若 session 上下文达到 90% 软阈值，后台创建压缩 checkpoint；低于 90% 不重复压缩。

当前 run 的消息必须正常写入历史。若当前 run 自身包含超过模型上限的单条 tool result，则对该结果做字段级截断或摘要化，不能只压缩更早的历史。

后台 checkpoint 不阻塞已经完成的回复。下一条用户消息到达时，若 checkpoint 正在运行则等待同一个任务；压缩任务必须携带消息水位并使用 session 级锁，禁止旧 checkpoint 覆盖新消息产生的 baseline。

---

## 10. Context Budget

不能再简单把“模型最大 context_tokens”全部当 history budget。

Model Context 至少包含：

```text
stable/system
tool schemas
compacted state
cached context
recent tape
attachments/current input
output reserve
```

建议引入统一 `ContextBudgetManager`：

```text
model_window
- output_reserve
- system/tool reserve
- current input reserve
= available session context budget
```

运行中达到模型硬上限时先保护当前 run 并压缩旧历史；run 完成后达到 `compact_threshold=90%` 才异步创建 checkpoint，checkpoint 完成后滚动压缩到 `target_after_compact`。

因此 90% 是后台维护阈值，不是允许 provider 请求首次撞上限的边界；provider 请求前仍必须使用扣除 schema、输出空间和安全余量后的硬预算。

第一版阈值可配置，不要求一次得到最优值；必须先增加可观测指标。

---

## 11. Context Manager 代码边界

目标边界：

```text
SessionManager
    │
    └── SessionContextManager
           ├── bootstrap()
           ├── prepare(event)
           ├── append(event)
           ├── patch(domain, change)
           ├── invalidate(domain)
           ├── refresh(domain)
           ├── compact()
           └── render_for_model()
                       │
                       ▼
                   AgentLoop
```

长期不希望：

```text
AgentRunner
  └── 每轮自己 load_context_data + build everything
```

而希望：

```text
AgentRunner
  └── 获取 Session Context 的当前投影
```

`builder.py` 第一阶段可以保留并逐渐退化为 render / projection 工具，不要求立即删除。

---

## 12. Session 持久化与进程边界

Persistent Session Context **不能只存在 Python 进程内存**。

咕咕存在：

- 多 worker；
- Web / IM；
- 定时任务；
- 重启 / 部署；
- 后续桌面 / 移动端；

因此“持久 Session”必须支持跨进程恢复。

第一版可：

```text
DB = durable session state / tape
Redis / process memory = hot cache
```

进程缓存只是加速层，不是真值。

恢复 Session 时：

```text
load latest checkpoint
+ recent tape after checkpoint
+ revisions
→ 恢复 PersistentSessionContext
```

不应要求重新从完整 Conversation 从头构建。

---

## 13. 与 Source of Truth 的关系

核心原则：

> **Session 保存“我一路经历了什么”；数据库保存“世界现在到底是什么”。**

因此：

```text
Session Context ≠ Database Mirror
```

Session 可以记：

```text
“刚把 project:123 deadline 改到 10 月 1 日”
```

但当模型需要确认真实截止时间、且 revision 已失效时，应重新读取业务真值。

不要为了“上下文连续”牺牲业务数据正确性。

---

## 14. 分阶段实施

### P0 · Provider-neutral Tool / Session Event

目标：先保证 Session Tape 本身可靠。

- [ ] 定义最小 `SessionEvent` 内部模型；
- [ ] Anthropic / OpenAI tool round 都转成统一事件；
- [ ] tool call / result 持久化不再依赖 provider wire format；
- [ ] compaction 可以读取 tool semantic effect；
- [ ] 建立 `state_change` / mutation effect 表达；
- [ ] 补跨 provider 回归测试。

**验收：**

同一条 Session 在不同 provider 下切换，下一轮可恢复一致的用户消息、assistant 消息和关键工具语义。

### P1 · Persistent Session Context 一级实体

- [ ] 新增 `SessionContextManager`；
- [ ] Session Bootstrap 只做一次 stable context 装配；
- [ ] Recent Tape 跨用户回合持续 append；
- [ ] Agent Loop 改成消费 Context render，不拥有 Context 生命周期；
- [ ] 支持进程重启恢复 latest checkpoint + recent tape；
- [ ] 保持现有路径 feature flag / fallback。

**验收：**

连续多轮对话中，用户 profile / stable preferences 不再每轮无条件重新 load；Context 生命周期明显长于一次 Agent Loop。

### P2 · Structured CompactedSessionState

- [ ] summary 从纯聊天摘要升级为状态 checkpoint；
- [ ] 至少保存 goals / decisions / constraints / changed_state / unresolved / refs；
- [ ] 合并 previous checkpoint + old tape；
- [ ] 保留近期 raw tape；
- [ ] Tool 产生的重要 state effect 必须进入 checkpoint；
- [ ] 增加 compaction 前后保真测试。

**验收：**

长 Session 多次滚动压缩后，关键决策、约束、工具产生的状态变化仍可正确回答 / 继续执行。

### P3 · Cached Business Context + Revisions

- [ ] 为 projects / calendar / files / preferences 建 revision 或 dirty-domain 机制；
- [ ] Session Bootstrap 记录所用 revision；
- [ ] 无变化 domain 直接复用 projection；
- [ ] 自身 tool mutation patch 当前 Session cache；
- [ ] 外部 mutation 触发 invalidation；
- [ ] 下一轮只 refresh 变化 domain；
- [ ] memory 保持 query-sensitive retrieval。

**验收：**

项目未变化时连续对话不重复拉全量 projects；另一端修改项目后，下个相关回合能自动刷新且不读到旧值。

### P4 · Turn Contract / Guard 去语言化

- [ ] 定义 `answer / read / write / clarify` 最小 contract；
- [ ] contract 与同一次 Loop 执行整合，不增加固定前置 LLM 调用；
- [ ] Execution Trace 记录 read / mutation / success；
- [ ] Guard 优先比较 Contract 与 Trace；
- [ ] 逐步下线可被结构信号替代的中文 narration / intent / dodge regex；
- [ ] 保留确实需要自然语言判断的极少数守卫。

**验收：**

中文 / 英文表达下，“声明需要 write 但未发生 mutation”都能由同一 Guard 捕获，不依赖对应语言正则。

### P5 · Budget + 可观测性

- [ ] 统一 ContextBudgetManager；
- [ ] 记录 stable / cached / compacted / recent tape / tools / attachment token 分布；
- [ ] 记录 checkpoint 边界；
- [ ] 记录 domain refresh / cache hit；
- [ ] 记录 compaction input / output；
- [ ] 为 LoopScope 暴露调试事件。

---

## 15. 可观测性要求

每次 Model Call 至少能够回答：

```text
这个 Session 当前 checkpoint 是哪个？
Stable Context 多少 token？
Compacted State 多少 token？
Recent Tape 多少 token？
哪些 business domain 使用 cache？
哪些 domain 本轮 refresh？为什么？
本轮追加了哪些 SessionEvent？
是否触发 Compaction？压掉了哪一段？
Turn Contract 是什么？
Execution Trace 是否满足 Contract？
```

推荐 LoopScope 展示：

```text
Session Bootstrap
   ↓
Stable Context
   ↓
Checkpoint #3
   ↓
Recent Tape Events
   ↓
Current User Event
   ↓
Turn Contract
   ↓
Agent Loop / Tool Events
   ↓
Context Commit
   ↓
Compaction Boundary（若触发）
```

---

## 16. 非目标

本 PRD 第一阶段不追求：

- 把完整数据库镜像进 Session；
- 永远不再读数据库；
- 将所有 Memory 固定进 Session；
- 为了复用 Context 引入进程内权威状态；
- 一次性重写整个 Agent Core；
- 永久保存每条 provider 内部控制消息；
- 用复杂事件溯源替代业务数据库；
- 一开始就做到最优 token 阈值。

---

## 17. 关键设计原则

### 原则 A：Context belongs to Session

```text
Session 生命周期 > Agent Loop 生命周期
```

一次 Loop 结束不能等于 Context 结束。

### 原则 B：Append first, Compact at a safe boundary

能增量追加就追加。运行中只在进入下一轮 provider 请求前、确实达到硬预算时压缩旧历史；run 完成后达到 90% 才后台创建 checkpoint，不在每轮重新总结。

### 原则 C：Cache is not Truth

业务状态可以缓存，但数据库 / 外部服务仍是 Source of Truth。

### 原则 D：Self mutation patch, external mutation invalidate

当前 Session 自己造成的变化直接 patch；其他来源变化用 revision 失效后按域刷新。

### 原则 E：Provider-neutral memory

Session 记什么不能由 Anthropic / OpenAI 消息格式决定。

### 原则 F：State over prose

Compaction 优先保存目标、决策、约束、状态变化、未完成事项，而不是只保存“聊过什么”。

### 原则 G：Guard checks behavior, not wording

能用 Turn Contract + Execution Trace 判断的行为，不再依赖自然语言正则。

---

## 18. 最终目标架构

```text
                         ┌──────────────────────┐
                         │   Source of Truth    │
                         │ DB / Files / APIs    │
                         └──────────┬───────────┘
                                    │ revisions / reads
                                    ▼
┌──────────────────────────────────────────────────────────┐
│                Persistent Session Context                │
│                                                          │
│ Stable Context                                           │
│ Cached Business Context + revisions                      │
│ Compacted Session State                                  │
│ Recent Provider-neutral Session Tape                     │
│ Context Budget / Checkpoint                              │
└───────────────┬───────────────────────────────┬──────────┘
                │ render                        ▲ commit
                ▼                               │
          ┌──────────────┐                      │
          │  Agent Loop  │──────────────────────┘
          │              │
          │ Turn Contract│
          │ Tool Calls   │
          │ Guard / Trace│
          └──────────────┘
```

最终希望咕咕从：

```text
每条消息重新构造一个“看起来像有上下文”的请求
```

演进成：

```text
一个真正持续存在的 Session 工作区，
模型每轮只是在这个工作区上继续思考、读取、修改和追加事件。
```

这也是本 PRD 的核心产品体验目标：**同一个 Session 应该像同一个持续工作的 Agent，而不是一连串每次重新拼装记忆的独立请求。**
