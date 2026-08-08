# Session 上下文增量与压缩 · PRD

> 💡 **讨论稿阶段，未实现。** 本文描述咕咕对话上下文从“每个用户回合重新装配 + 最近历史窗口 + 文本摘要”演进到“Session Tape + 状态型 Compaction + 增量业务上下文刷新”的目标方案。
>
> **状态：PRD v0.1（2026-08-08），待实现。**
>
> 本文只定义目标、边界、分阶段方案与验收标准；不要求一次性完成全部阶段，也不要求为了“架构漂亮”重写现有 `builder / runner / core / loop_drivers`。优先在现有链路上做最小增量改造。

---

## 0. 一句话

把咕咕的 Conversation History 从“聊天记录窗口”升级成真正的 **Session Tape**：

- 单个 Agent Loop 内继续 append-only；
- 跨用户回合恢复同一份 Session 语义；
- 老历史不只压成“聊过什么”，而是压成“这个 Session 现在处于什么状态”；
- 项目 / 日历 / 文件等业务真值仍以数据库为 Source of Truth，只在 revision 变化时增量刷新。

目标不是让 Session 变成数据库缓存，而是让模型拥有一条稳定、连续、可压缩、跨 Provider 一致的工作轨迹。

---

## 1. 背景

咕咕当前上下文链路已经具备三块重要基础：

1. **System Prompt 已分稳定前缀与动态后缀。** `agent/context/builder.py` 用 `CACHE_BREAK` 将 persona / policy / skills / style 等稳定内容与 memory / time / projects / calendar / files 等动态内容分开，便于 Prompt Cache 命中。
2. **单次 Agent Loop 已是增量追加。** `agent/core.py` 在一次用户请求内部持续向同一个 `messages` 追加 tool call、tool result、verify prompt 和 follow-up，而不是每个 tool round 重建上下文。
3. **长会话已有滚动压缩。** `agent/context/compress_conv.py` 在历史超过阈值后，将旧 user/assistant 文本与上一版 summary 合并为新的滚动摘要。

因此本 PRD 不把问题定义成“咕咕没有增量上下文”。更准确的现状是：

```text
跨用户回合：重新装配
单次 Agent Loop：增量追加
长 Session：滚动文本压缩
```

当前真正的缺口主要在跨回合 Session 语义、工具轨迹持久化一致性，以及 Compaction 对状态变化的保真。

---

## 2. 当前链路

当前 owner Web / IM 的一轮大致为：

```text
User message
   ↓
load_context_data()
   ├─ timezone
   ├─ projects
   ├─ calendar
   ├─ files overview
   ├─ style prefs
   ├─ memory
   ├─ IM channels
   └─ IM scoped memory
   ↓
查询 ConversationMessage
   ↓
select_history()
   ↓
builder.build()
   ├─ stable system prefix
   └─ dynamic current-state snapshot
   ↓
LLMRunner
   ↓
tool → result → append
tool → result → append
verify → append
...
   ↓
最终回复
   ↓
持久化
   ↓
后台 summary / reflection / compaction
```

### 2.1 已经正确的部分

以下设计本 PRD 原则上不推翻：

- `builder.py` 的稳定前缀 / 动态后缀边界；
- `core.py` 单次 loop 内 append-only 的 messages；
- 工具执行结果立即回灌当前 loop；
- DB 继续作为项目 / 日历 / 文件等业务真值；
- 长会话在后台异步压缩，不阻塞当前回复；
- recent history 必须保留足够原文，不能只依赖摘要；
- memory 仍然允许按当前 query 做相关性召回，而不是永久固定在 Session 首轮。

---

## 3. 现状问题

### P0-1：Compaction 会丢掉工具造成的关键状态变化

`ConversationMessage.content_json` 中保存了 Anthropic 格式的 tool round，`msg_tokens()` 也会把它们计入 token；但当前 `compress_conv.py` 构建摘要输入时只读取 `m.content`：

```python
text = (m.content or "").strip()
if not text:
    continue
```

工具轮次通常 `content=""`、真实内容在 `content_json`，因此会发生：

```text
工具轨迹
  ↓
占历史 token ✅
触发 compaction ✅
进入摘要器 ❌
被压缩后消失
```

当前摘要 prompt 又明确要求丢弃工具调用中间步骤。这个原则本身正确，但“中间步骤”与“工具确认后的状态变化”没有区分。

例如：

```text
用户：把项目 A 截止时间改到 10 月 1 日
assistant → update_project(...)
tool → success, deadline=2026-10-01
assistant：改好了
```

压缩后不能只留下“用户要求修改截止时间，咕咕已完成”，至少要保住：

```text
project:A deadline → 2026-10-01
```

否则 Session 长时间继续后，模型会丢失自己刚刚真实执行过的关键变化。

### P0-2：工具历史的持久化语义受 Provider 格式影响

当前主链路里，Anthropic format 会把真实 tool use / tool result 往返持久化为 `ConversationMessage.content_json`，而 OpenAI-compatible 路径没有完全同构的 provider-neutral 工具轨迹持久化语义。

结果是：

```text
同一个 Session
  Anthropic provider → 可恢复较完整工具轨迹
  OpenAI-compatible → 恢复语义可能更弱
```

Session 不应该因为切换 MiniMax / Mimo / DeepSeek / Anthropic / OpenAI-compatible 而改变“记住了什么”。

### P1-1：当前 rolling summary 更像“聊天摘要”，不是“Session 状态”

现有摘要适合回答“之前聊了什么”，但 Coding Agent / 长任务式 Agent 更需要回答：

- 当前目标是什么；
- 已经决定了什么；
- 已经真实修改了什么；
- 当前有哪些约束；
- 哪些事项仍未解决；
- 哪些业务对象是后续需要继续引用的。

也就是说，Compaction 的输出应逐渐从 Conversation Summary 转为 **Compacted Session State**。

### P2-1：每个新用户回合仍重新读取完整 owner 业务快照

`load_context_data()` 每一轮 owner Web / IM 都会重新加载 projects / events / files overview / style / memory / IM channels 等。

这保证了真值新鲜，但代价是：

- DB 查询重复；
- 文件夹路径等较重数据重复组装；
- prompt 动态块每轮整体变化；
- 无法明确知道“这一轮到底变化了什么”。

长期更适合变成“revision 驱动的局部刷新”，而不是纯内存 Session Cache。

---

## 4. 目标

### 4.1 产品目标

长对话、长任务、多轮工具操作中，咕咕应该稳定表现为“同一个正在持续工作的 Agent”，而不是每个用户回合都像从 DB + 最近聊天重新恢复一次。

用户不应该因为：

- Session 变长；
- 发生 compaction；
- Provider 切换；
- Web / IM 入口变化；

而明显感受到上下文断层。

### 4.2 技术目标

最终形成四层上下文：

```text
Session Context
│
├── 1. Stable Prefix
│      persona
│      policy
│      skills
│      style
│
├── 2. Compacted Session State
│      goals
│      decisions
│      constraints
│      changed_state
│      unresolved
│      refs
│
├── 3. Recent Tape
│      user
│      assistant
│      tool_call
│      tool_result
│      user
│      assistant
│      ...
│
└── 4. Ephemeral Context
       current time
       current sender / IM identity
       query-related memory
       necessary fresh business state
```

底层保持：

```text
Source of Truth
├─ Project DB
├─ Calendar DB
├─ Files DB
├─ Memory Store
└─ External services
```

### 4.3 核心原则

> **Session 保存“这一路发生过什么与当前进行到哪里”，DB 保存“世界现在到底是什么”。**

Session State 不能替代 DB 真值；模型需要精确确认业务对象当前状态时，仍应使用当前注入快照或查询工具。

---

## 5. 非目标

本 PRD 不做以下事情：

1. 不把项目 / 日历 / 文件完整数据长期复制进 Session；
2. 不引入一套与现有 DB 并行的业务状态数据库；
3. 不强制所有上下文都走向量检索；
4. 不删除现有 memory / reflection 体系；
5. 不为了统一而重写 `LLMRunner` 的工具循环；
6. 不把所有工具的原始 JSON 永久塞进 prompt；
7. 不要求第一阶段就完成 revision / dirty-domain 优化；
8. 不把 prompt cache 与 session tape 混成同一个概念。

---

## 6. 目标数据模型

### 6.1 Provider-neutral Session Event

优先把“持久化什么”从 provider 消息格式中抽出来。

概念模型：

```python
SessionEvent(
    session_id,
    seq,
    type,          # user | assistant | tool_call | tool_result | control
    payload,
    created_at,
    provider_meta=None,
)
```

其中真正进入 Recent Tape 的主要类型：

```text
user
assistant
tool_call
tool_result
```

`control` 只用于必要的调试 / 遥测，不默认恢复进 LLM 历史；例如 verify nudge、guard follow-up 等控制信令仍应像现在一样避免污染长期对话。

### 6.2 Tool Event 最小语义

不要求所有工具统一业务 schema，但至少应有：

```json
{
  "tool": "update_project",
  "call_id": "...",
  "args": {...},
  "status": "success",
  "result": {...},
  "resource_refs": ["project:123"]
}
```

如果原始 result 很大，持久层可保留完整结果，进入 LLM Recent Tape 时允许做 deterministic trim。

关键要求是 **Provider-neutral**：Anthropic block / OpenAI tool_calls 只是发送适配层，不是 Session 的事实模型。

### 6.3 CompactedSessionState

第一版建议结构化为 JSON-compatible dict，而不是只存 300 字自然语言：

```json
{
  "version": 1,
  "goals": [
    "完成咕咕 1.0 发布准备"
  ],
  "decisions": [
    "桌面端采用 Electron",
    "1.0 首发思维面板"
  ],
  "constraints": [
    "当前改动不得破坏 Web / IM 上下文隔离"
  ],
  "changed_state": [
    {
      "ref": "project:123",
      "change": "deadline -> 2026-10-01",
      "source": "tool:update_project"
    }
  ],
  "unresolved": [
    "桌面端打包方案尚未确定"
  ],
  "refs": [
    "project:123",
    "file:456"
  ],
  "narrative": "用户正在准备咕咕 1.0，最近重点讨论桌面端与发布范围。"
}
```

`narrative` 用于自然语言连续性，其余字段用于保真。

不要求模型在后续回复直接引用这些字段名；builder 最终可以将其渲染成紧凑 system block。

---

## 7. Compaction 设计

### 7.1 从“文本摘要”改成“状态压缩”

当前：

```text
previous summary
+
old user/assistant text
      ↓
300 字 summary
```

目标：

```text
previous CompactedSessionState
+
old user/assistant text
+
distilled tool events
      ↓
new CompactedSessionState
```

### 7.2 工具事件先 deterministic distill，再交给 LLM

不建议直接把所有原始 `content_json` 喂给摘要模型。

先由代码提取：

```text
tool name
success / error
关键参数
关键返回值
resource refs
```

例如：

```text
[tool success] update_project
ref=project:123
args.deadline=2026-10-01
result.deadline=2026-10-01
```

然后交给 compactor 判断什么值得进入 `changed_state / decisions / unresolved`。

### 7.3 压缩边界

继续保留当前“Recent 原文窗口 + 更早历史压缩”的基本策略，但必须保证：

- 已进入 CompactedState 的历史不再重复进入 Recent Tape；
- Recent Tape 与 CompactedState 在语义上允许少量重叠，但不能因为窗口边界错误导致整段重复烧 token；
- tool_call 与对应 tool_result 尽量成对处理，不允许切出孤儿；
- 单条超大工具结果允许 deterministic trim，但不能把 success/error 和关键资源引用裁掉。

### 7.4 Compaction 原子性

新状态生成失败时：

- 保留旧 CompactedState；
- 不推进 compacted-through 游标；
- Recent Tape 仍可继续正常运行。

写入成功时至少需要：

```text
state_version
compacted_through_seq
updated_at
```

避免“摘要已更新但不知道覆盖到哪条 event”。

---

## 8. Recent Tape

### 8.1 语义

Recent Tape 是尚未被压缩掉的近期 Session Event 序列，不等同于网页展示消息。

展示历史可以继续使用 `ConversationMessage`；实现阶段可选择：

- 在现表上扩展 provider-neutral event 字段；或
- 新建 `ConversationSessionEvent`；或
- 先做兼容层，将现有 `ConversationMessage` 转换为统一 event。

本 PRD 不强制表结构，但要求最终恢复出的 Session Tape 对不同 provider 一致。

### 8.2 Append-only

正常一轮中：

```text
user
assistant tool_call
tool_result
assistant tool_call
tool_result
assistant final
```

只追加，不在执行中“改写过去”。

Compaction 是少数允许改变可见上下文结构的操作，但逻辑上是：

```text
[old tape] → compacted state
[new tape] → 保留
```

而不是修改事件本身。

### 8.3 控制信令不长期污染

以下内容原则上不进入持久 Recent Tape：

- `_VERIFY_PROMPT`
- `_VERIFY_FORCE_PROMPT`
- narration nudge
- intent nudge
- decision nudge
- empty retry prompt

这些是 loop 控制信令，不是用户与咕咕实际共同经历的事实。

当前 `sanitize.tool_rounds_only()` 已体现这一原则，未来统一 Session Event 时继续保持。

---

## 9. 跨回合业务上下文增量刷新

此部分是 P2，不应阻塞 Session Tape / Compaction P0-P1。

### 9.1 为什么不做纯内存 Session Cache

咕咕同时存在：

- Web；
- QQ / 飞书 / 微信；
- 定时任务；
- 用户在 UI 里直接修改项目 / 日历 / 文件；
- 多 worker / 进程；
- 服务重启。

仅在某个 Python 进程里缓存“上轮 projects”会非常容易失效。

### 9.2 Revision / Dirty Domain

长期建议维护用户级或 domain 级 revision：

```text
projects_rev
calendar_rev
files_rev
prefs_rev
memory_rev
im_channels_rev
```

Session Context 记录上次已见：

```json
{
  "projects_rev": 51,
  "calendar_rev": 27,
  "files_rev": 103
}
```

下一轮：

```text
projects 51 == 51 → reuse snapshot
calendar 27 != 28 → refresh calendar only
files 103 == 103 → reuse snapshot
```

### 9.3 哪些必须每轮刷新

即便做 revision，也建议始终刷新：

- 当前时间 / 日期；
- 当前 sender / IM identity / role；
- 当前用户消息；
- 与当前 query 相关的 memory recall；
- 明确要求实时真值的场景。

### 9.4 哪些适合 revision

优先：

- projects overview；
- calendar overview；
- files overview；
- reply style prefs；
- IM channel binding status。

memory 是否 revision-cache 需要谨慎，因为当前 `load_memory(user_id, query)` 本身带 query 相关性。

---

## 10. Builder 最终职责

`builder.py` 不需要变成状态机。

最终建议职责保持简单：

```text
输入：
  stable policy/persona
  compacted session state
  recent tape
  ephemeral context
  fresh/reused business snapshot

输出：
  provider-ready system / context blocks
```

Builder 不负责：

- 决定哪些 event 被 compact；
- 维护 revision；
- 执行业务工具；
- 判断 DB 真值；
- 保存 provider-specific tool blocks。

---

## 11. Provider Adapter 边界

目标边界：

```text
Provider-neutral Session Tape
           ↓
loop_drivers / provider adapter
           ↓
Anthropic messages / OpenAI messages
```

而不是：

```text
Anthropic message history
     ↓
顺便充当 Session 数据模型
```

需要支持：

- neutral `tool_call` → Anthropic `tool_use`；
- neutral `tool_result` → Anthropic `tool_result`；
- neutral `tool_call` → OpenAI `assistant.tool_calls`；
- neutral `tool_result` → OpenAI `tool` role；
- 对不支持某些原始字段的兼容 provider 做降级渲染。

Provider-specific id / raw payload 可作为 metadata 保存，但不应成为跨回合恢复所必需的唯一信息。

---

## 12. 分阶段实施

## Phase 0：工具历史统一与 Compaction 保真

**目标：先修正确性，不优化性能。**

### P0-1 Provider-neutral tool history

- [ ] 定义内部 Session Tool Event 结构；
- [ ] Anthropic / OpenAI-compatible 均能从一次 loop 产出同构工具事件；
- [ ] 持久化后下一用户回合均可恢复；
- [ ] Provider 切换后仍能恢复上一个 provider 产生的关键工具轨迹；
- [ ] control nudge 不进入长期历史。

### P0-2 Compaction 纳入工具状态变化

- [ ] compactor 输入包含已成功工具事件的 distilled representation；
- [ ] error tool result 不伪装成已完成状态；
- [ ] 关键 resource ref 不丢；
- [ ] 关键变更值不依赖最终 assistant 口头总结；
- [ ] 工具中间噪声不直接进入最终 compacted context。

### Phase 0 验收

构造：

```text
1. 创建项目 A，deadline=10/1
2. 修改阶段
3. 创建日历事件
4. 产生足够聊天把上述轮次推出 recent window
5. 触发 compaction
6. 再问“刚才 A 截止时间是什么 / 我们改了哪些东西？”
```

要求：

- 能从 CompactedState 恢复正确关键事实；
- 不要求重新依赖旧原文；
- Anthropic / OpenAI-compatible 结果等价。

---

## Phase 1：CompactedSessionState

**目标：从 300 字 narrative summary 升级为“状态 + narrative”。**

- [ ] 定义 `CompactedSessionState v1`；
- [ ] 存储 `compacted_through` 游标；
- [ ] previous state + delta events 滚动合并；
- [ ] builder 将 state 渲染成紧凑上下文；
- [ ] 保留兼容旧 `role="summary"` 的迁移 / fallback；
- [ ] compactor 失败不破坏上一版 state。

### Phase 1 验收

至少覆盖：

- 决策保留；
- 用户明确偏好 / 限制保留；
- tool-confirmed changed_state 保留；
- unresolved 保留；
- 已解决事项不会永久停留在 unresolved；
- 后续出现相反决定时，新状态覆盖 / 退休旧决定，而不是两条互相冲突长期并存。

---

## Phase 2：Session Tape 恢复统一

**目标：Web / IM / provider 都从同一 Session Tape 恢复语义。**

- [ ] 抽统一 `load_session_context(session_id, budget, ...)`；
- [ ] Web `_generate` 与 IM `run_collect / run_stream` 不再各自拼不同含义的历史；
- [ ] recent tape 的 token 预算统一；
- [ ] tool pair 边界安全；
- [ ] quoted context / IM identity 仍保持入口隔离；
- [ ] proactive lead / greeting 等特殊前导继续可正确恢复。

---

## Phase 3：Revision 增量业务上下文

**目标：减少每 turn 全量装配，而不牺牲真值。**

- [ ] 为 projects/calendar/files/prefs 等建立 revision；
- [ ] Session 保存最近 snapshot revision；
- [ ] `load_context_data()` 支持 domain reuse / refresh；
- [ ] UI / tool / scheduled task 修改都能推进对应 revision；
- [ ] 多进程安全，不依赖单进程内存；
- [ ] 提供强制 refresh fallback。

---

## Phase 4：可观测性

后续可直接接入 LoopScope：

每轮至少可看：

```text
Stable Prefix tokens
Compacted State tokens
Recent Tape tokens
Ephemeral Context tokens
Business Snapshot tokens
Tool definitions tokens
Total input tokens
Cache read tokens
```

并展示：

```text
本轮新增 Session Events
本轮 dirty domains
本轮刷新了哪些 snapshot
是否触发 compaction
compaction 前后 token
compacted_through seq
state diff
```

这比只看“总 prompt”更能定位上下文膨胀与断层。

---

## 13. Token Budget 建议

不在 PRD 中锁死具体数字，但建议从“总历史一个 budget”演进为分区预算：

```text
Stable Prefix        provider cache 优先，不与 history 抢同一预算
Compacted State      小而稳定
Recent Tape          主要历史预算
Ephemeral Context    必须保留
Business Snapshot    有上限，可按 domain 裁剪
Tool Schemas         由 provider / router 控制
```

当接近 context 上限时裁剪优先级建议：

```text
1. 大型旧 tool raw result
2. 非关键 recent assistant verbose text
3. 较旧 recent tape → compaction
4. 非相关业务 overview
5. 永远最后才动 current user / identity / critical state
```

不得通过简单“砍最老 N 条”造成 tool_call / tool_result 配对破坏。

---

## 14. 兼容与迁移

### 14.1 旧 Session

必须允许旧 `ConversationMessage` 在没有 neutral tool events / compacted state 时继续运行：

```text
有新 state → 新路径
只有旧 summary → 旧 summary fallback
都没有 → recent messages
```

### 14.2 灰度

建议配置开关：

```text
session_tape_enabled
structured_compaction_enabled
context_revision_enabled
```

每一阶段可独立灰度与回滚。

### 14.3 不要求一次迁移全部历史

旧历史可懒迁移：首次读取时转换，或只让新产生的事件进入新结构。

---

## 15. 测试计划

至少新增以下回归组。

### 15.1 Tool history parity

同一脚本分别跑 Anthropic / OpenAI-compatible：

```text
user → create/update tool → query tool → final
```

断言恢复出的 neutral events 语义相同。

### 15.2 Compaction tool-state retention

生成大量聊天把工具轮推出窗口，触发 compaction，断言：

- changed_state 仍存在；
- success/error 不混淆；
- ref/id 保留；
- 后续问答能据此接续。

### 15.3 Rolling compaction

连续触发至少 3 次 compaction：

```text
state0 + delta1 → state1
state1 + delta2 → state2
state2 + delta3 → state3
```

断言早期关键决定不因为多次压缩逐轮消失。

### 15.4 Conflict update

先决定 A，后明确改成 B：

```text
旧：桌面端用 Tauri
新：桌面端最终改 Electron
```

最终 state 不应把两者当成两个同时有效决定。

### 15.5 Tool pair boundary

让 token 边界恰好落在 tool_call / tool_result 中间，断言最终 provider messages 仍合法。

### 15.6 Revision refresh

Phase 3 后覆盖：

- Agent tool 修改项目；
- UI 直接修改项目；
- 定时任务修改日历；
- 另一 worker 修改文件；

下一 turn 都必须看到新 revision 对应真值。

---

## 16. 监控指标

建议至少记录：

```text
context.total_tokens
context.stable_tokens
context.compacted_tokens
context.recent_tape_tokens
context.business_tokens
context.ephemeral_tokens
context.cache_read_tokens

session.compaction.count
session.compaction.input_tokens
session.compaction.output_tokens
session.compaction.latency_ms
session.compaction.failures

context.refresh.projects
context.refresh.calendar
context.refresh.files
context.reuse.projects
context.reuse.calendar
context.reuse.files
```

长期可关注：

- 长 Session 用户“你忘了吗 / 刚才不是说过”类失败率；
- provider 切换后的上下文异常率；
- 平均每 turn DB context-load 查询量；
- compaction 后首轮纠错率；
- cache-read 比例。

---

## 17. 风险

### 17.1 Structured state 被模型错误改写

Compactor 本身仍是 LLM，可能产生错误合并。

缓解：

- tool-confirmed changed_state 尽量 deterministic 提取；
- state 字段与 narrative 分开；
- resource ref 来自工具事件，不让模型凭空生成；
- 必要时 changed_state 可保存 source event seq 方便追溯。

### 17.2 Session State 与 DB 真值冲突

例如 Session 记得 deadline=10/1，但用户后来在 UI 改成 10/3。

原则：

> DB 真值优先，Session State 只代表“曾发生/曾决定”。

当新鲜业务 snapshot 明确冲突时，builder 应让模型以当前 snapshot 为准；Phase 3 revision 也会及时刷新。

### 17.3 上下文分层后总 token 反而膨胀

如果 summary + structured state + recent tape + snapshot 全都无约束叠加，会更贵。

因此必须有 token telemetry，并明确 compacted state 与 recent tape 的边界。

### 17.4 过早做 revision 增加复杂度

P2 性能优化不应抢在 P0 正确性之前。

如果 Phase 0 / 1 已经显著改善上下文连续性，revision 可以后推。

---

## 18. 实施顺序结论

推荐严格按以下顺序：

```text
P0 统一工具历史
   ↓
P0 Compaction 看见工具状态变化
   ↓
P1 Structured CompactedSessionState
   ↓
P2 Web / IM / Provider 统一 Session Tape 恢复
   ↓
P3 Revision 增量业务上下文
   ↓
P4 LoopScope 可观测性
```

不要先从 `builder.build()` 大改开始。

Builder 现在已经有稳定 / 动态边界，单轮 loop 也已经是增量的。最先值得修的是 **Session History 的语义与 Compaction 保真**。

---

## 19. 完成定义（DoD）

本 PRD 的核心目标可以认为完成，当满足：

1. **同一 Session 的工具轨迹不再依赖 Provider 格式保存。**
2. **长会话压缩后，已确认的重要状态变化不会因 tool round 被跳过而消失。**
3. **Compaction 输出能表达 goal / decision / constraint / changed state / unresolved / refs，而不只是聊天摘要。**
4. **Recent Tape 在 Web / IM 与不同 Provider 间恢复语义一致。**
5. **DB 仍是业务 Source of Truth，Session State 不承担真值数据库职责。**
6. **后续可以在不改 Session Tape 语义的前提下，为 projects/calendar/files 加 revision 增量刷新。**
7. **能够通过 telemetry 看清一次请求的 Context 各层 token 与 compaction 行为。**

最终形态：

```text
现状
Turn 重建 + Loop 增量 + 文本摘要

        ↓

阶段一
Turn 重建 + Loop 增量 + 状态型 Compaction

        ↓

阶段二
Provider-neutral Session Tape
+ Structured Compacted State
+ Recent Events

        ↓

最终
Revision 增量刷新
+ Session Tape
+ 状态 Compaction
+ DB Source of Truth
+ Context 可观测性
```

这条路线允许每一阶段独立获得收益，不要求一次性重构整个 Agent 上下文系统。