# PRD-LLM-29：统一 Canonical 消息区域与持久化增量

> 状态：✅ Phase 1–4 实现与本机全量验证完成；未做当前工作区 devserver 部署或真实 Provider 调用
> 创建：2026-09-25
> 最近更新：2026-10-01
> 关联模块：`backend/agent/context/assembly/`、`backend/agent/context/run_context.py`、`backend/agent/context/run_finalize.py`、`backend/agent/providers/`
> 背景参考：[[【已完成】PRD-LLM-11-Canonical Context与Provider Adapter分层重构]]、[[【已完成】PRD-LLM-14-Batch单一事实源与Canonical History一致性]]、`docs/agent/04-CONTEXT-ENGINEERING.md`

## 0. 实际状态

2026-10-03 审查补正：最终回复和用量也纳入 Run 级收尾凭据，不再只对工具 delta 幂等；私有推理状态与历史在同一收尾事务提交。Web 最终 Canonical 正文与累计展示正文分开；临时环境说明放入请求动态尾部；Chat reasoning 不再进入持久化 Canonical。详细修复与验证范围见 [上下文与推理续接审查修复](../devlog/2026-10-03-上下文与推理续接审查修复.md)。

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| Run 内 canonical history 与本轮消息有序归属 | ✅ Phase 1 已完成 | `MessageArea` 持有恢复 history 与本轮 canonical entries；固定 Snapshot/system 和 Provider-only dynamic tail 排除在 Area 外。 |
| Canonical batch 正文与元数据归属 | ✅ Phase 4 已复审 | `MessageBatch` 仅持有完整 canonical entries 一份；append 后 entries 归 Area，来源与持久化策略不再由另一份正文列表维护。 |
| turn 来源与持久化意图 | ✅ Phase 1 已完成 | user/RAG/stance/time/runtime/reference/attachment/tool/follow-up entries 携带 source/policy；scheduled 用户输入明确为 request-only。 |
| 收尾只从统一 Area delta 持久化 | ✅ Phase 4 已完成 | `finalize_run()` 强制接收 `MessageArea`，只把其 `persistence_delta()` 交给 repository；Provider wire 回推、独立 canonical batch 参数及无 Area finalize fallback 已移除。 |
| Provider 渲染、history restore 和压缩统一消费 Area | ✅ Phase 2/3 已完成 | Provider adapter 从不可变 Area snapshot 生成 `ProviderConversation`；DB window/hydration 后由 repository 恢复 Area；压缩替换要求 expected revision 并保留匹配 entry identity。 |

### 0.1 现有主链盘点（Phase 0 基线）

当前仍是迁移前实现；下表记录真实调用边界，供 Phase 1 对照，不代表目标设计已经落地。

| 顺序 | 消息来源 / 入口 | 当前运行时表示与追加点 | Provider 投影 | 持久化及下一次恢复 | 当前边界 / 风险 |
|---|---|---|---|---|---|
| 1 | `run/preparation.prepare_agent_run()` → `context/run_context.prepare_run()` | 先调用 `session_history.load_session_history()`，再由 `context/history.build_history_parts()` 转换；`assembly.assemble()` 建立 `PromptMessages`，`assemble_turn()` 生成当前轮 `NewMessageBatch` 并 `append_batch()` | Anthropic 与 OpenAI-compatible 在各自 driver / adapter 边界渲染；Anthropic 还会 sanitize 与转换消息 role | 当前 user row 通常在模型调用前单独落库；RAG、runtime-context 等由 finalize 路径补存 | 同一次组装分散在 history、turn batch、PromptMessages 与独立 Rag/stance 变量中 |
| 2 | 工具调用及工具结果 | `loop/machine.run_loop()` 调 driver 的 `build_tool_round()`，并分别生成 provider 消息和 `canonical_tool_round()`；之后写入同一个 `PromptMessages`，但正文快照另存于 `_canonical_batches` | `AnthropicDriver` 产生 assistant `tool_use` + user `tool_result`；OpenAI driver 产生 assistant `tool_calls` + tool-role 结果；Responses 有单独 item 格式 | `canonical_batches` 经 `persistable_canonical_batch_records()` 交给 finalize，再写 `ConversationBatch` 与 `ConversationMessage`；后续经 `load_session_history()` 恢复 | Provider 消息和 canonical 持久化消息是两条需人工保持一致的投影；JSONB 不保对象键序，必须显式保留会影响 wire 的工具参数顺序 |
| 3 | follow-up、守卫提示、重试与交互续接 | `run_loop()` 多处直接 `append_batch()`；pending 工具结果由 `PromptMessages.replace_tool_result()` 同步修改活消息和 canonical batch 快照 | 下一轮 driver 重新投影整段 history | 正常及取消收尾分别由 `finalize_run()` / `persist_interrupted_agent_run()` 持久化 | 追加点多；受控修订目前要同时更新两个可变状态面 |
| 4 | RAG、stance、runtime/time/reference/attachment | `run_context.prepare_run()` 与 `assemble_turn()` 组装；其中部分是 canonical block，部分通过单独参数或动态尾部承载 | `message_utils`、provider history helpers、sanitize 和 provider adapter 依协议过滤、渲染或添加缓存标记 | RAG、stance、runtime context 和 canonical batch 各有收尾/恢复规则；用户行可能已提前持久化 | 消息正文、来源、持久化策略及 provider-only 语义没有统一放在每条 entry 上 |
| 5 | 历史恢复与上下文压缩 | `session_history.load_session_history()` 根据 baseline/window 读 DB；`build_history_parts()` 做 role/block 恢复。`compact_context()` 在运行中裁剪；`compress_conv` 更新持久化摘要和 baseline | 恢复结果再进入 Anthropic/OpenAI history projection；cache helper 又有自己的 clone/state | `run_finalize.finalize_run()` 管理 canonical delta、summary 与数据库收尾；新 Run 必须重新从 DB 装载 | baseline 更新、当前 run 的列表替换、batch 持久化和 Provider 投影边界分别管理，需在后续阶段统一顺序证明 |

对应人工合成往返基线为 `backend/tests/test_run_finalize.py::test_synthetic_tool_round_survives_canonical_persistence_and_restore`：真实走 Driver 工具轮构造 → 现有 canonical batch → finalize 写入测试 DB → session history loader → Anthropic history restore，并断言恢复后的 wire 消息与 live wire 相同。它与 `test_anthropic_tool_input_keeps_wire_order_after_persistence` 共同覆盖参数键序回归；后者模拟 JSONB 重排。全程使用合成数据和 SQLite fixture，不访问真实用户配置、数据目录或模型。Phase 1 将同一映射从 batch 改为 MessageEntry，并保留等价行为断言。

### 0.2 Phase 0 契约冻结与既存改动审阅

- 所有权基线：`MessageArea` 只拥有本 Run 的有序 canonical entries、revision/digest 与显式受控修订；`MessageBatch` 仅是一次 append 的分组 DTO；Provider renderer 只读 snapshot 并拥有 wire projection；Repository 独占 DB restore/commit；CacheState、Snapshot、ContextBranch 和展示 timeline 都不归 MessageArea 所有。
- `MessageEntry` 字段沿用 §3.1，并要求 entry identity、sequence、source、persistence policy 不能从 list index、provider role 或 DB 自增 ID 临时猜测。`PersistenceDelta` 是 immutable snapshot，按 sequence 输出；数据库 receipt 只在事务成功后应用。
- 缓存保真约束：canonical semantic digest 与 provider wire digest 分开。对对象键序敏感的序列化，恢复后必须复现原投影的顺序；不得以 Python dict 相等、JSONB 语义相等或排序后的 digest 代替 wire-prefix 等价断言。Canonical 工具参数可保存有序 JSON 字符串或等价的显式顺序信息，Provider adapter 再渲染其格式。
- Phase 0 冻结 API 职责和可验证的不变量；`MessageArea` 行为型 API contract tests 随 Phase 1 `area.py` 首个实现一起落地，避免对尚不存在的实现写只检查字段名的伪测试。Phase 0 的旧链 source→wire→DB→restore 合成行为测试已落地并通过。
- 审阅了当前工作区涉及 history/reference/run_context/session_history/gateway 与相邻测试的差异：这组关键路径没有待处理覆盖性改动；工作区其余改动涉及 Agent/provider、部署、项目工具和前端样式等多个独立方向，均保留原状，不挪动、不重置，也不混入 Phase 0。

## 1. 背景与目标

### 1.1 背景

现有主链已实现 `History + NewMessageBatch → PromptMessages` 的运行时追加，但仍保留多个互相同步的状态面：

- `PromptMessages` 列表承载当前请求可见的消息，并维护 fixed prefix 与 provider-only dynamic tail 边界；
- 同一个 `PromptMessages` 另存 canonical batch 快照、digest 和 metadata，供 run 收尾持久化；
- `run_context.prepare_run()` 分别加载/恢复 history、生成本轮 batch、追加后清洗；
- `run_finalize.finalize_run()` 分别持久化姿态、RAG、canonical batch、用户/助手展示时间线及兼容路径；
- Provider 历史清洗、合并、cache 标记和 role/event 渲染会复制 `PromptMessages`，还需手动搬运其隐藏元数据；
- 下一次 run 仍要从数据库恢复 baseline 后的消息，这是新的请求/进程所必需的；现有 loader 已按 baseline 和条数窗口增量读取，并非每次重放所有历史。

本 PRD 的问题不是“batch 完全没有 append 到 history”。本轮及工具批次已经追加到同一运行时消息序列。要消除的是**消息序列、batch 快照、持久化增量分别维护和同步**所导致的遗漏、重复、顺序漂移与缓存前缀漂移风险。

### 1.2 目标

建立一个按序、append-first 的 `MessageArea` 作为单次 Run 内 Canonical 消息事实源：

```text
已恢复的 canonical 消息 ─┐
本轮新增消息 / 工具续轮 ─┼─ append → MessageArea
压缩事务提交的新 baseline ┘               ├─ 只读 Provider projection → LLM
                                           └─ 持久化增量 → 单一 finalize writer
```

具体目标：

1. history 恢复、当前轮输入、工具调用/结果和后续轮次都通过一个 append 接口进入同一有序区域；不再出现“追加到 wire list，却忘记登记 canonical batch”这类双写契约。
2. 一条 `MessageEntry` 同时承载 canonical 内容、序号/来源和持久化策略；批次只作为原子提交/幂等分组元数据，不再持有与消息列表平行的正文副本。
3. Provider 请求由只读 renderer 从 Message Area 产生；renderer 的过滤、缓存标记和 wire 转换不能修改或回写 canonical 区域。
4. Run 收尾从 Message Area 生成唯一有序 `PersistenceDelta`，以事务方式持久化；当前已预先持久化的 user row、只在当前请求有效的内容等必须显式标记，避免重复写入。
5. History loader 输出统一 Canonical entry；压缩只通过经验证的 baseline 替换操作更新历史区域。
6. 保持现有 provider 缓存策略、工具往返语义、附件/引用清洗、Web/IM/定时任务一致性和数据库兼容。

### 1.3 非目标

- 不取消每次新 Run 从数据库恢复会话历史；不引入跨请求内存态或进程级消息缓存作为正确性来源。
- 不把 system prompt、稳定 Snapshot 或 Provider cache state 混进会话消息区域；它们有独立生命周期。
- 不把 provider wire message 作为 canonical 持久化格式，也不从 wire history 反推持久化事实。
- 不改变 RAG、姿态、消息时间、附件、交互确认、压缩 baseline 的产品语义。
- 第一阶段不新增数据库表/列、不做全库历史迁移、不重写 UI 展示时间线。
- 不把 ContextBranch 的反思、知识反思和摘要 prompt 当作主会话消息追加；分支输出仍由各领域 writer 管理。

## 2. 功能需求

### FR-LLM29-01：统一有序消息账本

每个 Run 仅有一个 `MessageArea` 保存 Canonical message entries。已恢复 history 作为初始化 entries；新用户上下文、RAG/runtime/姿态事件、工具往返及 follow-up 以 append 操作加入其末尾。固定 Snapshot 与独立 Provider-only tail 不得被误纳入此区域。

每个 entry 至少明确：

- `entry_id`：Run 内稳定 ID；恢复的持久化消息携带已有数据库 ID；新条目在构造时生成 ID。
- `sequence`：区域内单调递增的顺序号，不依赖列表切片下标或数据库自增 ID 推断 Run 内顺序。
- `canonical_message`：Provider-neutral 的 canonical 消息或 canonical block 序列。
- `source`：`restored_history`、`current_turn`、`rag`、`runtime_context`、`tool_round`、`followup`、`compaction` 等受控来源枚举。
- `persistence_policy`：`already_persisted`、`commit_on_success`、`commit_on_interruption`、`request_only`、`reconstruct_on_restore` 之一。
- `batch_id` / `round_id`：可空的分组元数据；分组不得另持平行正文副本。
- 可选 `persisted_message_id` 与 `revision`，用于确认已落库来源和受控交互结果修订。

### FR-LLM29-02：原子 append 与受控修订

- 所有调用方使用 `MessageArea.append()` 或 `MessageArea.append_batch()` 添加 canonical 条目；一次 batch 中条目连续、顺序固定、不得交错。
- tool call 与对应 result、并行工具结果及交互状态按现有 canonical batch 原子性保存。
- 普通消息 append 后不可插入、重排或覆盖已发送前缀。
- 等待确认/交互的 pending result 只能通过 `resolve_pending_tool_result(entry_id, result)` 显式修订；修订必须更新 digest/revision 并使受影响的 cache state 失效，不能直接改写 list 或批次副本。
- `MessageBatch` 是一次 append 的分组 DTO；封存后其 entries 由 Message Area 持有，不得作为第二份持久化正文账本，也不保留旧批次类型别名。

### FR-LLM29-03：纯 Provider projection

`ProviderAdapter.render_history(area.snapshot(), render_options)` 返回独立、不可变的 `ProviderConversation`，至少包含 provider wire messages、area revision/digest、cache plan 和 projection diagnostics。转换不得变更 entry、canonical digest、顺序或持久化策略。

Provider renderer 允许过滤不适用的内部事件、转换 tool/event/image 等结构、添加 provider cache marker，但所有转换结果只属于该次请求投影。连续工具轮的历史 prefix 必须由同一 Message Area 版本派生。

### FR-LLM29-04：唯一持久化增量

`MessageArea.persistence_delta(outcome)` 按 sequence 输出需要提交的 canonical entries，并明确排除已持久化或请求结束即丢弃的条目。delta 使用不可变 snapshot，不能引用 mutable provider list。收尾 writer 必须将相关 batch envelope 和 canonical messages 放在同一数据库事务中幂等写入。

- 当前 user row 可在 LLM 调用前写入，以保留现有用户消息可见性和 RAG watermark；对应 area entry 标为 `already_persisted`，不得再次插入正文。
- RAG、姿态、工具 canonical events 和 runtime context 等需跨 Run 恢复的内容，经 delta writer 写入并保持其当前语义顺序。
- 当前消息时间等重建型数据明确采用 `reconstruct_on_restore`；临时动态 tail 与诊断标记采用 `request_only`。
- 成功、取消、中断、发送失败及 session 删除竞态沿用当前提交规则；尤其 `commit_on_interruption` 必须保持工具事务可恢复，不得留下孤儿 tool call。
- `ConversationBatch` 可保留为原子提交/幂等 envelope，`ConversationMessage.canonical_batch_id` 保留关联；它们不再作为独立于 Message Area 的第二事实源。

### FR-LLM29-05：统一历史恢复及边界操作

History restore 将数据库行转换为 `MessageEntry`，保留附件/引用恢复、旧 canonical event 兼容、工具配对与排序。实际发送前按 Provider 生成 projection，不在 loader 中预先生成 Provider-specific history。

压缩必须通过 `MessageArea.replace_baseline()` 或等价事务命令替换被摘要覆盖的历史范围；只在摘要、baseline watermark 和数据库写入事务成功后提交区域 revision。失败或发现并发 baseline 已推进时保持原区域不变。Snapshot、system prompt、动态 tail、ContextBranch 输入不属于被压缩的主会话区域。

### FR-LLM29-06：缓存和观测隔离

Cache state 继续独立于 Message Area 正文。cache anchor 只能引用区域 revision 与 canonical digest，不能将 Provider marker 写回区域。诊断仅记录 entry 数量、source/persistence mode 计数、digest、sequence 范围、投影差异位置和状态；不得记录聊天正文、附件名、工具参数、引用文本、凭据或用户身份。

## 3. 技术方案

### 3.1 新抽象与职责

```python
class PersistencePolicy(StrEnum):
    ALREADY_PERSISTED = "already_persisted"
    COMMIT_ON_SUCCESS = "commit_on_success"
    COMMIT_ON_INTERRUPTION = "commit_on_interruption"
    REQUEST_ONLY = "request_only"
    RECONSTRUCT_ON_RESTORE = "reconstruct_on_restore"

@dataclass(frozen=True)
class MessageEntry:
    entry_id: str
    sequence: int
    canonical_message: CanonicalMessage
    source: MessageSource
    persistence_policy: PersistencePolicy
    batch_id: str | None = None
    round_id: str | None = None
    persisted_message_id: int | None = None
    revision: int = 0

class MessageArea:
    @classmethod
    def from_restored(cls, entries, *, baseline, snapshot_revision): ...
    def append(self, entry) -> MessageEntry: ...
    def append_batch(self, batch, *, source, persistence_policy) -> tuple[MessageEntry, ...]: ...
    def resolve_pending_tool_result(self, entry_id, result) -> MessageEntry: ...
    def snapshot(self) -> CanonicalAreaSnapshot: ...
    def persistence_delta(self, *, outcome) -> PersistenceDelta: ...
    def commit_persistence(self, receipt) -> None: ...
    def replace_baseline(self, replacement, *, expected_revision) -> None: ...
    def digest(self) -> str: ...
```

上述名称为目标 API 契约，不要求逐字实现；若实施时需要改名，必须保持等价边界与验收行为，不另造并行抽象。

| 抽象 | 唯一职责 | 不负责 |
|---|---|---|
| `CanonicalMessage` | Provider-neutral 的 role/content/block 事实格式；可由现有 canonical dict 逐步承载 | provider wire 字段、cache marker、持久化策略 |
| `MessageEntry` | 一条 canonical message 的顺序、来源、durability 与持久化关联元数据 | 再存一份可独立变更的 batch 正文 |
| `MessageArea` | 本 Run 的有序 append ledger、受控修订、digest 和 revision | 数据库连接、Provider SDK 调用/投影、Snapshot 生命周期 |
| `MessageBatch` | 一组必须相邻提交的 entries 的输入 DTO/事务边界 | 与 Message Area 平行的长期正文列表 |
| `ProviderConversation` | Provider adapter 对某一 area revision 的不可变 wire projection | canonical 历史事实或数据库落库 |
| `PersistenceDelta` | Area 中按结果策略可提交的有序 canonical 记录及其 batch envelope | 从 provider wire 猜测、独立重新排序历史 |
| `MessageAreaRepository` | restore/delta 写入数据库并返回 commit receipt | 内容组装、LLM/provider 逻辑 |
| `ProviderAdapter.render_history()` | 将不可变 `CanonicalAreaSnapshot` 渲染为对应 Provider 的不可变 `ProviderConversation` | 修改 MessageArea、决定持久化或改写 cache state |

### 3.2 生命周期

```text
Run preparation
  1. 读取最新 Snapshot 与 baseline 后的持久化 ConversationMessage 窗口
  2. Repository.restore_entries() → MessageArea.from_restored()
  3. 当前 user 已提前落库：append 引用其 ID 的 already_persisted entry
  4. RAG / runtime / stance 等依规则 append；临时时间块标记为 restore 重建
  5. ProviderAdapter 从 area 的不可变 snapshot 生成 ProviderConversation

Agent loop
  6. tool round/follow-up 先生成 canonical MessageBatch，再 append_batch()
  7. 每轮从同一个 area 生成纯 provider projection；不在旧区域回写 cache marker

Run finalize
  8. persistence_delta(outcome) 得到当前待提交条目
  9. Repository 在事务内按顺序写 ConversationBatch + ConversationMessage
 10. commit receipt 标记已持久化 entry；下一次 Run 从 DB restore 同一 canonical 顺序
```

“避免 history 再 import 一遍”的准确实现目标是：**一个 Run 内不再把已组装的历史先转成 Provider list、再从另一份 batch ledger 拼持久化历史；新 Run 仍须读取持久化历史，且只读取 baseline/window 规定的范围。**

### 3.3 模块与函数边界

| 模块 | 目标函数/契约 |
|---|---|
| `context/assembly/area.py`（新增） | `MessageEntry`、`MessageArea`、`MessageSource`、`PersistencePolicy`、`CanonicalAreaSnapshot`、`PersistenceDelta`；负责 entry 序列、append、受控修订、digest 与不可变快照/delta。 |
| `context/message_area_repository.py`（新增） | `MessageAreaRepository.restore_entries(db, session_id, baseline)` 将 DB rows 归一为 entries；`commit_delta(db, delta)` 事务性写入并返回 `PersistenceReceipt`。不做 Provider 渲染。 |
| `context/assembly/batch.py` | `MessageBatch` 输入 DTO；`seal()` 生成一次 canonical entries，不另行长期保存 provider messages 镜像；保留 canonical 类型校验和 batch digest。 |
| `context/assembly/messages.py` | Phase 4 已删除；不保留旧 list facade、旧批次类型别名或可变 list 消费入口。 |
| `context/assembly/__init__.py` | 暴露 `MessageArea` 构造 API；将 `assemble()` 收敛为 `assemble_message_area()`/restore composition，逐步停止返回 list 子类。 |
| `context/assembly/turn.py` | `assemble_turn()` 继续决定本轮语义与顺序，改为返回 `MessageBatch`，为 entries 指定 source/persistence intent；不生成另一份 provider-first 正文事实。 |
| `context/context_assembly.py` | `build_context()`/`build_messages()` 迁移为 `build_message_area()`；禁止同时维护 CanonicalContext 当前轮 tuple 与另一份 appended list 的事实副本。 |
| `context/run_context.py` | `prepare_run()` 接收 restore entries，构造并返回单个 MessageArea；`PreparedRun` 暴露 `message_area`、初始 revision 和独立 rag metadata，不再分 `anthr_messages` / `oa_messages` 两份主历史状态。 |
| `context/session_history.py` | `load_session_history()` 保持 baseline/window 查询语义；新增/委托 `restore_message_entries()`，引用/附件水合结果作为 canonical metadata/blocks 注入，不生成 Provider role 格式。 |
| `context/history.py` | DB row → canonical history 恢复与 canonical entry → Provider history rendering 分层；`build_history_parts()` 仅保留明确的历史读入边界，不承担双轨 runtime assembly。 |
| `context/provider_history.py` | 只对不可变 `ProviderConversation` 做无副作用 role/event 投影；不保留 PromptMessages clone 或旧 list facade。 |
| `providers/base.py` | 定义 `ProviderConversation` 与 `render_history(CanonicalAreaSnapshot, render_options) -> ProviderConversation` 只读契约；不反向依赖数据库或 MessageArea 可变实现。 |
| `providers/anthropic_history_adapter.py`、`providers/openai_history_adapter.py` | 分别实现 Anthropic/OpenAI history 投影；输入 canonical snapshot，输出 wire messages 与 projection metadata，不复制 Area 私有字段。 |
| `providers/anthropic.py`、`providers/deepseek.py`、`providers/glm.py`、`providers/local.py`、`providers/mimo.py`、`providers/minimax.py`、`providers/ollama.py`、`providers/openai.py`、`providers/openai_responses.py`、`providers/qwen.py`、`providers/context_adapter.py` | 按接口调用方/实现情况适配并验证历史 projection；只改实际承载 history conversion 的 Provider，不为不相关 Provider 文件制造改动。 |
| `providers/message_utils.py` | `render_openai_request_history()`、`_with_history_cache()`、`_with_single_history_cache()` 等 helper 输入/输出显式改为 ProviderConversation；cache 状态引用 area revision/digest，不改区域。 |
| `context/canonical_tool_history.py` | 已删除 `persistable_canonical_batch_records()`；工具事件的 canonical → Provider event rendering 保留纯投影职责。 |
| `context/prefix_history.py` | 缓存/前缀历史辅助函数从 PromptMessages 属性判断改为接收 `CanonicalAreaSnapshot` 或已渲染不可变 projection，确保分支与主链契约一致。 |
| `agent/loop/machine.py`、`agent/loop_drivers.py` | Loop append API 改为 `MessageArea.append_batch()`；driver 输出 canonical batch/event，不直接变更 Provider list；受控 pending result 使用 entry ID。 |
| `agent/run/preparation.py`、`agent/run/finalization.py` | 入口层在 Web/IM/定时执行间传递 PreparedRun.message_area；统一调用 Repository restore/finalize，不在渠道层拆分不同列表。 |
| `agent/gateway/web.py` | Web stream 的正常/中断收尾都传同一 MessageArea 与 outcome；删除 `anthr_messages if use_anthropic else oa_messages` 和手工筛 canonical batch 的重复路径。 |
| `agent/scheduled_execution.py` | 定时任务使用相同 MessageArea 构造与持久化 delta；保留它与普通用户消息不同的 persistence intent。 |
| `context/run_finalize.py` | `finalize_run()` 强制接收 `MessageArea` 并生成 `PersistenceDelta`；移除 wire fallback 与独立 batch list 输入。数据库写入与幂等仍在同一事务。 |
| `context/compaction.py`、`context/compress_conv.py` | 压缩入口从裸 list/fixed index 改用 area revision、entry IDs 和 baseline watermark；摘要成功后以 `replace_baseline(expected_revision=...)` 原子替换，保留原失败不推进规则。 |
| `context/reflection_snapshot.py`、`context/branch.py`、`context/branch_types.py` | 主会话 snapshot 输入从 MessageArea 提供只读 canonical slice；ContextBranch 仍为独立只读分支，不向主 Area 自动 append。 |
| `runtime/loopscope_trace/state.py`、`runtime/loopscope_trace/cache_probe.py` | 诊断记录 area revision/digest 与 entry source/policy 计数、wire digest/first diff；保持日志脱敏，不记录正文。 |

### 3.4 目标文件树及修改范围

```text
docs/prds/PRD-LLM-29-统一Canonical消息区域与持久化增量.md 【新增】
backend/agent/context/
  message_area_repository.py        【新增】
  assembly/
    area.py                         【新增】
    __init__.py                     【修改】
    batch.py                        【修改】
    messages.py                     【已删除】
    turn.py                         【修改】
  context_assembly.py               【修改】
  run_context.py                    【修改】
  session_history.py                【修改】
  history.py                        【修改】
  provider_history.py               【修改】
  prefix_history.py                 【修改】
  canonical_tool_history.py         【修改/适配器完成后清理】
  run_finalize.py                   【修改】
  compaction.py                     【修改】
  compress_conv.py                  【修改】
  reflection_snapshot.py            【条件】
  branch.py                         【条件】
  branch_types.py                   【条件】
backend/agent/providers/
  base.py                           【修改】
  message_utils.py                  【修改】
  anthropic_history_adapter.py      【修改】
  openai_history_adapter.py         【修改】
  anthropic.py                      【条件】
  deepseek.py                       【条件】
  glm.py                            【条件】
  local.py                          【条件】
  mimo.py                           【条件】
  minimax.py                        【条件】
  ollama.py                         【条件】
  openai.py                         【条件】
  openai_responses.py               【条件】
  qwen.py                           【条件】
  context_adapter.py                【条件】
backend/agent/loop/
  machine.py                        【修改】
backend/agent/
  loop_drivers.py                   【修改】
  scheduled_execution.py            【修改】
  run/preparation.py                【修改】
  run/finalization.py               【修改】
  gateway/web.py                    【修改】
  runtime/loopscope_trace/state.py  【修改】
  runtime/loopscope_trace/cache_probe.py 【修改】
backend/tests/
  test_message_area.py              【新增】
  test_message_area_persistence.py  【新增】
  test_message_area_provider_projection.py 【新增】
  test_message_area_compaction.py   【新增】
  test_context_assembly.py          【修改】
  test_canonical_context.py         【修改】
  test_canonical_tool_history.py    【修改】
  test_canonical_context.py         【修改】
  test_canonical_tool_history.py    【修改】
  test_run_context_boundaries.py    【修改】
  test_run_preparation_parity.py    【修改】
  test_run_finalize.py              【修改】
  test_session_history.py           【修改】
  test_context_history.py           【修改】
  test_context_cache_boundaries.py  【修改】
  test_cross_run_cache_prefix.py    【修改】
  test_tool_history_request_boundary.py 【修改】
  test_provider_runner_cache.py     【修改】
  test_tool_history_request_boundary.py 【修改】
  test_provider_runner_cache.py     【修改】
  test_message_compaction_boundary.py 【修改】
  test_compaction.py                【修改】
  test_provider_history.py          【修改】
  test_provider_history_adapters.py 【修改】
  test_anthropic_roundtrip.py       【修改】
  test_core_loop_characterization.py 【修改】
  test_run_lifecycle.py             【修改】
  test_history_attachment_refs.py   【修改】
  test_history_persist_filter.py    【修改】
  test_scheduled_task_execution.py  【修改】
  test_rag_batch_protocol.py        【修改】
  test_stance_history.py            【修改】
  test_rag_batch_protocol.py        【修改】
  test_stance_history.py            【修改】
  test_reflection_snapshot.py       【条件】
docs/agent/04-CONTEXT-ENGINEERING.md 【修改】
docs/devlog/YYYY-MM-DD-LLM-29-message-area.md 【生成：按 devlog 流程新增，不手工维护第二份计划】
backend/app/models/__init__.py     【不改：优先复用 ConversationMessage/ConversationBatch】
backend/alembic/versions/          【不改：除非验收证明现有字段无法表达顺序/幂等】
backend/.env、backend/config.override.json 【不改：运行配置用户数据】
```

`assembly/area.py` 是唯一新领域状态抽象；`message_area_repository.py` 是持久化 adapter，不维护第二份内存历史。禁止新增 `history_store.py`、`batch_ledger.py` 等平行消息容器。`session_history.py` 负责现有查询窗口，MessageArea 负责运行期顺序与状态，Provider adapter 负责纯渲染，repository 负责事务写入。数据库 schema 默认不变；若必须新增字段，需在 TODO 对应验收中先证明 created_at、batch id 与现有主键无法恢复稳定顺序，再另行评审迁移及回滚方案。

文件树中“条件”文件只有当调用签名或生命周期边界确实变化才修改；实现前逐项检查当前未提交 diff，特别是 history/reference/context 相关用户改动，必须原样保留并通过适配测试，不得覆盖或顺手清理。

### 3.5 兼容与迁移策略

- 本次已完成直接切换；不保留旧运行时 API 的 facade、list consumer、双写/shadow renderer 或 feature 开关。旧的内存对象契约不属于兼容范围。
- 持久化数据库历史仍由唯一 restore 路径读取并归一为 canonical entries，包括缺少 `canonical_batch_id` 的历史及既有引用/附件格式；这是既存数据读取，不是旧 runtime adapter 兼容。新写入一律 canonical。
- 保留现有 `(session_id, digest)` 幂等约束、`ConversationBatch` 事务 envelope 和 `ConversationMessage.canonical_batch_id`，第一阶段不改 migration。
- 历史窗口仍由 baseline watermark 与 `HISTORY_MAX_MSGS` 限制。MessageArea 不持有 baseline 之前已被 summary 覆盖的正文。
- `MessageArea` revision 变化只有在真实 canonical content/顺序变化时递增。Provider cache state 使用现有独立状态机制，以 `(area_revision, canonical_digest, provider/model/API/cache policy)` 校验复用；cache metadata 不进入 Entry。
- Web、IM、scheduled、分支和诊断入口均已迁到同一 Area/不可变 projection 契约。失败回滚采用部署制品整体回退，不提供进程内切换到旧 assembly/finalize 实现的开关；数据库 schema 未改变。

### 3.6 状态转换与 API 契约

```text
RESTORED ──append──> ACTIVE ──finalize success──> COMMITTED
                         ├──finalize interruption──> PARTIALLY_COMMITTED
                         ├──request-only tail───────> DISCARDED
                         └──compaction transaction──> BASELINE_REPLACED
```

- `PersistenceDelta` 必须携带 `session_id`、`run_id`、expected area revision、entries（按 sequence）、batch grouping/digests 和 outcome class。
- Repository 成功返回 `PersistenceReceipt`（已提交 entry IDs、batch IDs、最终数据库排序水位）；事务失败则不修改内存条目的 committed 状态。
- 重试使用稳定 batch digest 和 entry IDs 幂等；相同 session/run/delta 不得创建重复 ConversationMessage。
- 恢复后计算的 canonical area digest 与前次 commit receipt 对应的 durable digest 应一致；历史兼容归一化必须显式计入 restore version，不得静默改变语义。

## 4. 验证与上线

### 4.1 行为验收

1. 连续对话、Web/IM/定时入口及重启恢复后，MessageArea sequence 与数据库恢复顺序一致；每条新事实恰好 append 一次。
2. 工具单轮、多并行工具、多轮、确认/拒绝/取消/错误/中断恢复中，call/result 配对、batch 原子性和用户可见 timeline 不变。
3. 每种 PersistencePolicy 在 success/interruption/failure 下均产生唯一预期写入；already-persisted user 不重复，request-only 内容不进入 DB，恢复型时间只重建一次。
4. 所有 Provider 的 wire request 与重构前语义一致；projection 前后 area digest/revision 不变，canonical messages 无 Provider-specific 字段。
5. 首轮、工具续轮、下一轮及 Responses `previous_response_id` 增量链路保持 prefix；缓存锚点不回写，dynamic tail 不进入持久历史。
6. 压缩并发、压缩失败、baseline 已推进竞态不丢消息、不重复 summary、不提前推进 baseline；历史旧数据可读。
7. 附件图片/媒体、显式引用、RAG、姿态、schema/discovery、runtime context、thinking strip、引用水合在 Web/IM 与 Anthropic/OpenAI-compatible 渲染中保持既有边界。
8. 诊断不泄露正文、引用文本、工具参数、附件名、token、凭据或真实用户身份。

### 4.2 自动化测试与静态检查

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q tests/test_message_area.py tests/test_message_area_persistence.py tests/test_message_area_provider_projection.py tests/test_message_area_compaction.py
PYTHONPATH=. .venv/bin/pytest -q tests/test_context_assembly.py tests/test_run_context_boundaries.py tests/test_run_preparation_parity.py tests/test_run_finalize.py tests/test_session_history.py tests/test_context_history.py tests/test_context_cache_boundaries.py tests/test_cross_run_cache_prefix.py tests/test_message_compaction_boundary.py tests/test_compaction.py tests/test_provider_history.py tests/test_provider_history_adapters.py tests/test_anthropic_roundtrip.py tests/test_core_loop_characterization.py tests/test_run_lifecycle.py tests/test_history_attachment_refs.py tests/test_history_persist_filter.py tests/test_scheduled_task_execution.py
python -m compileall -q app agent
```

完整依赖环境回归按 backend skill 在 devserver 执行 `PYTHONPATH=. .venv/bin/pytest -q`。另运行 `git diff --check`、`python scripts/checks/check_ownership.py`、`python scripts/checks/check_confirm_gate.py`。测试不得连接真实 `.env`、override config、用户数据目录或真实 LLM；真实模型/真实 run 对比若需要，另开显式授权的探针任务并使用用户许可的上下文。

### 4.3 观测与灰度

使用隔离测试 shadow compare canonical sequence digest、entry count、persistence delta digest 和 provider wire digest（只记录摘要及结构统计，不记录正文）；shadow renderer 仅存在于测试，不进入生产运行时。连续 20 轮合成工具续轮覆盖首轮/工具轮/下一轮的 Area 顺序、增量提交、恢复和 wire first-diff。该测试不调用真实 Provider，不宣称观测到真实 cache usage/命中率。

验收通过后，生产代码不保留 facade 或 shadow path。若发布后发现回归，通过部署管理器整体回滚应用制品；数据库 schema 和既存消息格式未改变，无需数据逆迁移。

### 4.4 上线与回滚

不新增用户可见或内部 runtime feature 开关，不在同一进程保留新旧 assembly/finalize 双路径。回滚指部署层恢复上一个完整应用制品；当前实现没有改变 DB schema，既存消息继续通过 canonical restore 路径读取。任何未来 DB schema 变更都必须另行评审迁移与备份/恢复步骤。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| MessageArea 同时承载正文、生命周期策略和 cache revision，抽象过宽 | 形成新的 God object，循环依赖 assembly/provider/finalizer | Area 只管内存 ledger 与纯数据；数据库 repository、Provider renderer、cache state 均在外部模块，以显式 input/output 协作。 |
| 把 provider-specific 的图片/音频结构误当 canonical message | 无法跨 provider 重建等价请求 | 首阶段盘点 `build_user_content()` 与历史媒体结构；canonical entry 保存可复用的 media/reference 描述，adapter 决定 wire。无法等价时使用显式 projection hint，不将 wire 反向持久化。 |
| 原子 batch 聚合导致顺序或 timestamp 变化 | cache prefix、UI 工具顺序或 reload 回归 | 以 sequence 和既有 DB ordering 双重对比；保留 ConversationBatch grouping；如现有存储不能稳定表示 sequence，再评审 schema 迁移。 |
| 中断/取消发生在 DB commit 与内存 receipt 之间 | 重试重复落库或遗漏工具结果 | 稳定 entry/batch digest，幂等 upsert，receipt 仅在事务 commit 后应用；覆盖 commit 失败与重复收尾测试。 |
| 用户当前未提交的 history/reference 修改被重构覆盖 | 丢失用户工作或引用上下文回归 | 实施前审阅工作区 diff，相关行为加入 regression；不得 checkout/reset/覆盖用户变更。 |
| 把“统一消息区域”误做成取消跨 Run DB restore | 重启、并发请求、worker 换进程后丢上下文 | 以持久化数据库为跨 Run 真源；只消除一次 Run 内多份并行状态和重复转换。 |

待确认事项：若既有数据库排序在 batch 内无法稳定复原，是否允许引入显式 `sequence` 数据列及 Alembic migration？默认答案为“先不增加”，须由验收证据触发决策。

## 6. 唯一实施 TODO

### Phase 0：契约与基线

- [x] `LLM29-001` 盘点所有主链消息来源、append 点、持久化策略、Provider 投影与压缩替换路径；建立人工合成 fixture 的旧链基线；验收：产出 source→canonical batch→wire→DB→restore 映射测试，不触碰真实配置/数据；Phase 1 将它迁移到 entry。
- [x] `LLM29-002` 定义 `MessageEntry`、`MessageArea`、`PersistencePolicy`、`PersistenceDelta`、`PersistenceReceipt` 与 `ProviderConversation` 的具体类型和所有权；验收：冻结类型字段、所有权和 wire 序列化保真契约；Area 行为 contract tests 与其首版实现同阶段落地，避免实现前的空壳/源码断言。
- [x] `LLM29-003` 审阅实施时工作区所有既存 diff，尤其 `history.py`、`references.py`、`run_context.py`、`session_history.py`、`gateway/web.py` 与相关测试；验收：未提交改动被保留，引用/附件行为测试列入 Phase 1/2 回归范围。

### Phase 1：Message Area 与统一入口

- [x] `LLM29-004` 新增 `context/assembly/area.py` 并实现 `MessageEntry`/`MessageArea` 核心 append、append_batch、digest、revision、受控 pending-result resolve 与 baseline replace；验收：单元测试证明单调顺序、batch 连续、正常 append 不改旧 entry、显式修订推进 revision。
- [x] `LLM29-005` 让 `assembly.assemble()`、`context_assembly.build_messages()` 与 `assemble_turn()` 以 MessageArea/MessageBatch 为契约；验收：固定 Snapshot、恢复 history、本轮新增消息只有一个 Area 顺序来源，原有内容顺序测试全过。
- [x] `LLM29-006` 将 `run_context.prepare_run()` 与 `PreparedRun` 收敛为一个 MessageArea，并显式标注 user/RAG/stance/time/runtime/reference/attachment 的来源与 persistence policy；验收：Web/IM 当前消息不重复，RAG watermark、媒体与当前用户时序一致。
- [x] `LLM29-007` 将 `machine.run_loop()`、`loop_drivers` 和 `scheduled_execution` 的工具 round/follow-up append 迁移到 Area API；验收：普通工具、并行调用、schema event、交互确认/取消/失败、中断恢复的 canonical 顺序与配对不变。
- [x] `LLM29-008` 把 `PromptMessages` 改为短期兼容 facade，并让所有主要调用者停止直接写 list/隐藏 batch fields；验收：静态搜索确认生产主链不再直接依赖 `_canonical_batches`/`canonical_batch_records` 或对 Area 原位 list mutate。

Phase 1 验证记录：新增 Area 行为合同测试；本地与 devserver 对消息 Area、scheduled execution、run context、cache prefix、provider roundtrip、compaction boundary、tool loop 和 finalize 共 235 项测试均通过。静态搜索确认生产代码不再读写 `_canonical_batches` 或直接读取 `PromptMessages.canonical_batch_records`；收尾 adapter 改为读取 Area 的 batch groups。`git diff --check` 通过。压缩 baseline 与数据库事务尚未接 Area，按计划留待 Phase 3。

### Phase 2：纯 Provider 投影与缓存边界 ✅

- [x] `LLM29-009` 将 Provider adapter/history helpers 改为从 MessageArea 纯渲染 `ProviderConversation`；验收：Anthropic、多类 OpenAI-compatible adapter 投影不改 area digest/revision，工具、图片、媒体和 canonical event 输出保持语义。
- [x] `LLM29-010` 将 `message_utils` 的 sanitize/merge/cache marker 操作迁移到 projection 对象，并把 CacheState 引用 area revision/digest；验收：首轮、工具续轮、续轮后的 wire prefix 对照测试通过，cache marker/dynamic tail 永不写回 area。
- [x] `LLM29-011` 将 `canonical_tool_history.py`、`provider_history.py`、`prefix_history.py` 中的 PromptMessages hidden-metadata clone 迁为显式纯 projection 或兼容 adapter；验收：不再复制 batch 正文隐藏账本；provider role projection 保留共享 Area 身份，分支前缀仍独立且不回写主 Area。

Phase 2 验证记录：Anthropic 与 OpenAI-compatible projection、工具事件/结果、图片与多媒体块、cache prefix 边界和 Area 不可变性均有行为测试；provider sanitize/role 转换不改 Area digest/revision，branch projection 不共享可变正文。

### Phase 3：唯一持久化增量与恢复 ✅

- [x] `LLM29-012` 新增 `context/message_area_repository.py`，实现 `restore_entries()`、`commit_delta()` 与 MessageArea `persistence_delta(outcome)`/commit receipt；验收：policy 矩阵覆盖成功、错误、取消、中断、重复 finalize，增量按 sequence 唯一且幂等。
- [x] `LLM29-013` 将 `run_finalize.finalize_run()`、`run.finalization.finalize_agent_run()` 和 Web 中断收尾改为消费 delta；验收：RAG/stance/tool/runtime/user 已持久化路径在一事务或明确前置提交规则内写入，无 provider-wire 反推，无重复用户消息。
- [x] `LLM29-014` 将 `session_history.load_session_history()` 与 `history.build_history_parts()` 分层为受 baseline/window 限制的 canonical restore，再按 adapter 投影；验收：旧消息、summary watermark、引用 hydration、附件清洗和 baseline 窗口回放 digest 正确。
- [x] `LLM29-015` 将压缩/baseline 更新迁移为基于 entry IDs 和 expected revision 的原子 Area replacement；验收：成功压缩回放一致；摘要失败、并发推进和事务失败保留旧 baseline/entries。

Phase 3 验证记录：新增 repository restore identity/timestamp 与 delta commit 顺序、幂等测试；success/interruption policy、当前 user anchor、已持久化 user 不重复落库均受测试覆盖。历史读取仍先执行现有 baseline/window 与引用 hydration，再转换成 Area；压缩 Area replacement 使用 entry ID 匹配和 expected revision，竞争 revision 时拒绝覆盖。错误出口不 commit；取消/中断只提交声明允许保留的 entry。

### Phase 4：入口接入、测试与旧实现清理

- [x] `LLM29-016` 将 Web、IM/worker、scheduled 和 ContextBranch read-only 消费者接入兼容后的 Area/sequence 接口；验收：入口准备结果、主链路与收尾契约一致，分支结果不会自动写进主 Area。ContextBranch 使用不可变有序 history sequence，并在 Provider 边界深拷贝后调用；行为测试模拟 Provider 原位改写嵌套消息，确认不会污染 sibling 源历史。
- [x] `LLM29-017` 完成 PRD 文件树中列出的 MessageArea、持久化、projection、compaction 与受影响现有回归测试；验收：策略矩阵、cache prefix、tool round、Responses continuation、跨 Run reload、动态尾部、引用/附件/图片均有确定测试。
- [x] `LLM29-018` 运行后端全量测试、compileall、ownership/confirm gate、`git diff --check` 并核对工作区外测试数据；验收：检查全通过，未生成真实用户目录/凭据变更，工作区原有用户改动仍在。
- [x] `LLM29-019` 进行隔离 shadow compare 与至少 20 个连续工具 run 的 cache/restore 持久化观测；验收：Area canonical 顺序、delta commit、下一轮 restore 一致，无重复/缺失条目，first diff 无非预期前移，并形成脱敏报告。此次为合成 shadow compare，不调用真实 Provider，因此不报告真实 cache usage/命中率。
- [x] `LLM29-020` 完成 `PromptMessages` list facade 到 Area/不可变 Provider projection 的消费者迁移；验收：所有主链入口的消息变更通过 Area entry API，Provider 请求仅消费 projection，DB restore 保持旧数据字节/顺序兼容，并在可控环境完成灰度等价验证。
  - [x] 删除 `persistable_canonical_batch_records()`、`canonical_batches`/digest/records 隐藏属性、独立 `canonical_batches` finalize 参数与旧 wire fallback；finalize 缺少 Area 时明确失败，不静默丢失或从 Provider wire 重建历史。
  - [x] Context Engineering 文档更新为 Area 是 canonical/persistence 唯一事实源、finalize 只接受 Area delta。
  - [x] LoopScope 改为记录 Area revision/digest/source/persistence 统计与 Provider projection wire 身份；cache、Anthropic 结构和上下文布局诊断统一读取 projection，删除 canonical batch 旁路探针及其旧用例。
  - [x] loop 主入口与 driver 契约使用 `MessageArea`；sanitize、compaction、cache、Responses、分支历史及 LoopScope 诊断只消费 `MessageArea` 或不可变 `ProviderConversation`，删除 list facade 的消费者兼容；受影响测试夹具全部迁到新契约。

Phase 2/3 复审记录（2026-10-01）：`backend` 全量 pytest 为 3707 passed、9 failed；9 项均为 RAG TypeScript worker 启动测试，当前本机 Node 22 环境缺少 `postgres` npm 包导致 worker 退出，非本次 Canonical Area 改动。LLM-29 主链专项回归 126 passed；全量其余 Agent、Provider、loop、history、compaction、finalize 测试通过。全量测试、compileall、ownership/confirm gate 与 20-run shadow compare 仍列在 Phase 4，不将环境受阻的 RAG 用例记作通过。

Phase 4 进度复审（2026-10-01）：此前 devserver 后端全量测试为 `3719 passed, 104 warnings`；ownership/confirm gate、远端 `compileall`、本地 `git diff --check` 均通过。中断收尾的 mock 起初缺少 Area，按真实 `PreparedExecution` 契约补齐后重跑通过。`LLM29-016` 已关闭：主路径共享 Area，ContextBranch 使用只读有序 history sequence，并在 Provider 边界深拷贝；行为测试验证 Provider 嵌套字段改写不会污染 sibling 源历史。`LLM29-019` 已通过隔离结构 shadow compare：连续 20 轮逐轮重载数据库历史，对照旧 history renderer 与 Area projection wire，断言 `first_diff_index is None`，提交工具增量后最终恢复无遗漏；该测试不调用真实 Provider，不代表真实缓存命中率。

Phase 4 完成复审（2026-10-01）：`LLM29-020` 已完成，生产 Agent 代码中已无 `PromptMessages`、`_canonical_batches`、独立 canonical batch finalize 参数及 list facade 消费入口。loop/driver 输入类型为 `MessageArea`；provider sanitizer、cache、Responses、compaction、分支和 LoopScope 诊断以 Area 或不可变 `ProviderConversation` 为边界，LoopScope 从 Area 显式生成投影，不接受任意可变消息列表。连续 20-run 隔离持久化/restore shadow compare 与旧数据顺序验证保留并通过。当前本机后端全量测试为 `3712 passed, 9 failed`；9 项均因本机 Node 22 环境缺少 `postgres` npm 包、TypeScript RAG worker 无法启动，单项已确认与 Canonical Area 无关。迁移专项与 20-run/Area/compaction 回归 `143 passed`；ownership/confirm gate、318 个 Python 文件 AST 解析及 `git diff --check` 通过。未对当前工作区执行 devserver 同步或真实 Provider 调用，因此本记录不声称当前最新代码已在 devserver 做过灰度或真实缓存命中验证。

Phase 4 最终复审（2026-10-01）：清除批次内 canonical 持久化子集与完整 Area entries 的重复正文存储；`MessageBatch` 现在只存完整 canonical entries，持久化范围只由 entry policy 决定，`MessageArea.append_batch()` 不再保留第二条 canonical-list append 路径。进一步移除旧 `NewMessageBatch` 运行时类型及其兼容别名，生产代码和测试统一使用 PRD 定义的 `MessageBatch`。移除所有调用点都不生效的 `assemble(system_text, include_system)` 参数，保留由调用方实际构造的固定前缀、Area 和 render options；定点质量增量的 `assemble` 门禁从 1 降为 0，7 个调用方契约检查无不兼容点。跨 Run 前缀测试直接检查 entry policy 与 `PersistenceDelta`，确保已提前持久化用户消息不重复写入、消息时间恢复时重建、工具轮仍按 round 原子恢复。移除/更新仅针对旧 PromptMessages 语义命名的测试，并将 PRD 与 Context Engineering 文档的兼容策略改为无运行时 facade、无旧类型别名、无 feature rollback；既存 DB 行仍由单一 restore 路径读取，故障回退是部署制品整体回滚。最终本机后端 pytest：`3723 passed, 102 warnings`（临时目录分配偶发错误单测及全量重跑均通过）；本机安装了已在 `backend/ts/packages/data-runtime/package.json` 声明的 `postgres@3.4.9` workspace 依赖用于测试，未改 manifest/lockfile。`compileall`、ownership 守卫、confirm-gate 守卫与 `git diff --check` 通过。Ripwire 总 test-gate 针对整个工作区报告静态调用图未覆盖符号；本次定点质量检查 `gating=0`，整个工作区其它 Phase 差异仍有 scoped-out 静态门禁项，未将全工作区表述为零告警。没有同步/部署 devserver，也没有调用真实 Provider。
