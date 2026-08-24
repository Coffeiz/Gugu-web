# PRD-AGENT-4：统一 ContextBudget 上下文压缩重构

## 状态

规划中（2026-08-24）。本文是实现依据，完成后再标记为「已完成」。

## 本任务目标

稳定单一的 session 上下文生命周期：

```text
baseline
  → 基于 baseline 增量组装上下文
  → 抵达 ContextBudget 阈值
  → 只压缩旧 history
  → 原子更新唯一 baseline
  → 继续基于新 baseline 增量运行
  → 循环
```

最终不再存在互相冲突的预算、历史注入、运行中压缩和后台压缩行为。所有入口都遵循同一套生命周期。未来预算实现只保留 `backend/agent/context/budget.py` 一份语义；`context_budget.py` 不作为新模块创建，`ContextBudget` 只是其中的计划/数据结构名称。

本文统一替代并收口以下文档中的会话上下文预算与压缩语义：

- `docs/product/PRD/【已归档】PRD-AGENT-1-会话上下文增量与压缩.md`
- `docs/product/PRD/PRD-AGENT-3-统一会话历史窗口与持久化基线.md`
- `docs/agent/context/context-budget-baseline-design.md`
- `docs/product/PRD/【已完成】PRD-LLM-8-Prompt-Caching优化.md` 中的上下文压缩部分
- `docs/product/PRD/【已完成】PRD-IM-6-IM会话复用与消息窗口裁剪.md` 中的窗口裁剪部分

长期记忆（daily、profile、pattern、群成员记忆）的内容压缩仍由对应 Memory/RAG PRD 负责；本 PRD 只处理「单个会话发给模型的对话上下文」和其持久化 baseline，不把两种压缩混成一个任务。

---

## 1. 背景与问题

当前 Web、私聊、群聊、定时任务虽然都使用 `baseline_message_id`、session snapshot 和持久化 summary，但预算与压缩逻辑分散在多层：

1. `budget.py` 使用 `SAFE_BUDGET_RATIO`、`POST_RUN_CHECKPOINT_RATIO`、`HARD_TARGET_RATIO`，`compaction.py` 又维护一套 `COMPACTION_*` 常量，`compress_conv.py` 再定义 `FORCE_COMPRESS_TARGET`。
2. `session_history.history_budget_for_context()` 使用固定 reserve heuristic；入口在组装历史前先算一次，core 又按另一套总量再算一次，导致 Web、私聊和群聊的首轮输入不一致。
3. 旧压缩目标是上下文的 20%，这个数字同时被运行中压缩、后台 baseline 更新和确定性截断复用，既不表达语义，也会产生过度压缩、重复压缩和 cache 前缀抖动。
4. 某些路径会先加载超过模型预算的完整历史，再等待压缩；群聊被动消息量大时更容易在相邻 run 中重复 inline compaction。
5. inline compaction 只改变当前 run 内存中的消息，不一定推进持久化 baseline；下一轮仍从旧水位加载，造成压缩重复、输入 token 突然变大和 Round 1 cache 降低。
6. Redis gate 目前承担了执行互斥、baseline 更新等待和“是否有待处理消息”多种语义；session 没有可靠的 pending 状态，多个 worker 可能重复生成。
7. Web 与 IM 的入口包装层不同，部分 baseline 等待、历史读取、错误重试和动态尾部保护代码重复，修复容易只覆盖一个渠道。
8. snapshot、summary、baseline 的生命周期虽然已有基础字段，但没有清晰的“唯一活跃 baseline 版本”契约，旧任务存在覆盖新版本的风险。

### 1.1 用户可见后果

- 同一群连续消息有时每轮都压缩，有时上一轮只有 20k 下一轮却重新压缩。
- 超过上下文限制时直接返回“当前模型无法处理”，没有先按硬预算裁剪并重试。
- 压缩期间同一 session 并行生成，回答顺序不稳定，或出现重复回答。
- 运行中的消息、工具结果和后台 baseline 更新互相覆盖，破坏 provider prompt cache。

---

## 2. 目标与非目标

### 2.1 目标

1. Web、私聊、群聊、微信、飞书和定时任务使用同一个 `ContextBudget` 预算模型。
2. `ContextBudget` 是唯一的上下文预算语义：固定前缀、snapshot、工具 schema、动态尾部、history、当前消息、工具轮和输出/推理预留全部纳入总预算。
3. 未超过硬上限时不提前压缩；达到 90% 软阈值后让当前 run 完成，再异步推进 baseline。
4. 超过硬上限时，禁止加载或发送超过预算的完整 history；先做本地确定性裁剪/字段降级，必要时对旧 history 做 LLM 压缩并重试当前 round。
5. 压缩结果的总上下文不超过模型上限的 50%；50% 是上限而不是必须达到的目标，不设置下限，尽可能保留历史语义。
6. 压缩只处理 history，不删除当前 run 的用户消息、assistant/tool call、tool result 和最终输出。
7. snapshot/summary 统一归属于一个活跃 baseline 版本，摘要、业务 snapshot 和覆盖水位原子提交。
8. 一个 session 同时只允许一个生成任务；运行中或 baseline 更新中收到的新消息进入该 session 的 pending 状态，生成结束后按顺序继续。
9. baseline 更新完成后必须重试被暂停的当前 round；不得返回半完成的“压缩成功”状态。
10. 被动群消息可以落库、推进计数和参与下一次历史窗口，但不触发回复生成。
11. 通过脱敏日志可解释每次预算决策、压缩原因、baseline 变化和 pending 排队情况。
12. 重构完成后的运行时代码量尽量维持现状：新增抽象必须替代旧实现，不能在旧逻辑旁边再叠加一套“统一封装”。

### 2.2 非目标

- 不删除数据库中的原始会话消息。
- 不把 daily/profile/pattern 的长期记忆维护合并到 session baseline。
- 不重新设计各 provider 的 API payload、tool schema 或图片附件格式；provider 专属 payload 清洗继续由 provider adapter 负责。
- 不要求压缩到固定比例或固定消息条数。
- 不用 Redis key 代替持久化 session 状态；Redis 只负责跨 worker 的执行所有权和短暂恢复。
- 不以增加代码层级为目标；除非能删除等量或更多重复代码，否则不新增模块、wrapper、状态机或兼容层。

---

## 3. 已确认的设计决策

以下决策为本 PRD 的硬约束，后续实现不得恢复旧的同义常量或隐式规则：

| 决策 | 规则 |
| --- | --- |
| 唯一预算名 | 只使用 `ContextBudget`。`safe_budget`、`history_budget`、`compaction_budget`、`hard_target` 等重复语义必须迁移后删除或改为 ContextBudget 的字段。 |
| 总量口径 | budget 覆盖所有 context：system、snapshot、工具定义、动态尾部、history、当前消息、工具轮、输出/推理预留和 provider overhead。 |
| 软阈值 | 达到模型 ContextBudget 的 90% 后，本轮先完成回复；完成后再推进 baseline。 |
| 硬上限 | 第一次 provider 请求前和每个 tool round 前都检查硬上限；超过时不加载/发送超预算的完整 history。 |
| 压缩目标 | 压缩后的总上下文必须 `<= 50% * model_context_tokens`；无下限，尽量低但优先保持历史语义。 |
| 压缩范围 | 只压缩 baseline 之后的旧 history；当前 run 的消息链受到保护。 |
| 重试 | baseline 或 inline 压缩完成并提交后，当前 round 必须重新组装并重试；最多按统一 retry policy 防止无限循环。 |
| pending | pending 是 session 自身的持久状态，不依赖 Redis lock 推断。新消息可先落库，执行器只处理一个 active task。 |
| Redis | Redis gate 只负责跨 worker 的执行所有权、短时租约和故障恢复；不能作为业务消息是否 pending 的唯一事实来源。 |
| baseline | session 只有一个 active baseline 版本；旧压缩任务不能覆盖新 baseline。 |
| 被动群消息 | 被动群消息继续存储，但不触发生成；后续被提及或主动响应时从当前 baseline 增量读取。 |

---

## 4. 核心定义

### 4.1 ContextBudget

`ContextBudget` 是一次 provider 请求的完整预算计划，不是一个只给 history 留空间的整数。

```text
ContextBudget {
  model_context_tokens        # 模型硬上限
  output_reserve_tokens       # 输出/推理预留
  provider_overhead_tokens    # provider/tool 格式开销
  fixed_prefix_tokens         # system + 稳定 snapshot + 固定提示
  tool_schema_tokens          # 当前可用工具定义
  dynamic_tail_tokens         # 当前时间、RAG、提醒、渠道动态提示
  current_turn_tokens         # 当前 user + 当前 run 的 tool 链
  history_tokens              # baseline 之后可注入的 history
  total_tokens                # 上述各项总和
  soft_limit_tokens           # 0.90 * model_context_tokens
  compression_cap_tokens      # 0.50 * model_context_tokens
  hard_limit_tokens           # provider 允许的最大总量
}
```

计算规则：

```text
total = fixed_prefix + tool_schema + dynamic_tail
      + current_turn + history + output_reserve + provider_overhead

soft_limit = floor(model_context_tokens * 0.90)
compression_cap = floor(model_context_tokens * 0.50)
available_history = hard_limit - (total - history)
```

`available_history <= 0` 时，先缩减可压缩 history；不得把动态尾部、当前 user 或当前工具轮误算为可删除历史。若当前单条消息本身超过硬上限，返回明确的单条输入过大错误，不进行无限重试。

### 4.2 Baseline 与 Snapshot

- `baseline_message_id/hash` 表示当前 baseline 已覆盖到的历史水位。
- `snapshot_revision/epoch` 表示该 baseline 的稳定版本。
- snapshot 内容仍可包含稳定 system/context、业务概览和 RAG 去重上下文；对话 summary 作为同一 baseline 版本的一部分维护，不再存在多个互相竞争的 snapshot 水位。
- 一次 baseline 更新事务必须同时提交：summary、snapshot 内容/哈希、baseline id/hash、revision、覆盖范围和状态。
- 读取时只加载 `baseline` 之后的增量；不因为普通消息变化就重建稳定 snapshot。

### 4.3 Session 状态

建议在 `ConversationSession` 持久化以下语义（字段名可按迁移时的模型约定落地）：

```text
execution_state: idle | running | baseline_updating | draining
pending: boolean
pending_from_message_id: 最早尚未派发的主动消息
active_run_id: 当前执行任务标识（可恢复）
baseline_revision: 正在/最后完成的 baseline 版本
```

状态字段是“是否有任务、是否需要排队”的事实来源；Redis 租约失效后，worker 可以依据 session 状态恢复或重新排队。

---

## 5. 新的压缩架构

### 5.1 总体架构图

```mermaid
flowchart TD
  A[渠道入站 Web / 私聊 / 群聊 / 定时任务] --> B[SessionAppender]
  B --> C{被动群消息?}
  C -- 是 --> D[落库 + 计数\n不触发生成]
  C -- 否 --> E[事务写入 user message\n读取 session 状态]
  E --> F{session 是否 running/baseline_updating?}
  F -- 是 --> G[session.pending = true\n记录 pending_from_message_id\n返回排队状态]
  F -- 否 --> H[领取 active task\nRedis 仅做跨 worker 所有权]
  H --> I[读取 baseline 之后增量 history]
  I --> J[ContextBudget 统一预检]
  J --> K{超过硬上限?}
  K -- 否 --> L[Provider Round]
  K -- 是 --> M[保护当前 turn\n只压缩旧 history]
  M --> N{LLM 压缩后 <= 50%?}
  N -- 是 --> O[原子推进 baseline]
  N -- 否/失败 --> P[确定性消息组/字段裁剪]
  P --> Q{仍超硬上限?}
  Q -- 是 --> R[明确错误\n不发送超预算请求]
  Q -- 否 --> O
  O --> L
  L --> S{还有 tool round?}
  S -- 是 --> J
  S -- 否 --> T[持久化本轮输出]
  T --> U{total >= 90%?}
  U -- 否 --> V[释放 active task]
  U -- 是 --> W[创建 baseline 更新任务]
  W --> X[压缩旧 history\n总量 <= 50%]
  X --> Y[原子提交 summary + snapshot + baseline]
  Y --> V
  V --> Z{session.pending?}
  Z -- 是 --> H
  Z -- 否 --> AA[session idle]
```

### 5.2 单次请求的预算流程

```mermaid
sequenceDiagram
  participant S as Session
  participant B as ContextBudget
  participant C as Core
  participant P as Provider
  participant K as BaselineUpdater

  S->>B: build(total context, baseline + incremental history)
  B-->>C: plan + diagnostics
  alt total > hard_limit
    C->>B: compact old history, protect current turn
  B-->>C: new messages + baseline candidate
    C->>C: commit baseline/snapshot, retry same round
  end
  C->>P: provider request within hard_limit
  P-->>C: assistant/tool result
  C->>B: recompute before next tool round
  C-->>S: persist output
  alt total >= soft_limit
    C->>K: schedule baseline update (session pending-safe)
    K->>K: compress history only, cap <= 50%
    K->>S: atomic baseline/snapshot commit
  end
```

### 5.3 状态机

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> running: 主动消息领取任务
  idle --> baseline_updating: 90% baseline update
  running --> running: tool round / 同一 run 重试
  running --> pending: 新主动消息到达
  baseline_updating --> pending: 新主动消息到达
  pending --> draining: 当前任务完成或 baseline 提交
  draining --> running: 按 message_id 顺序领取下一条
  draining --> idle: 没有待处理主动消息
  running --> idle: 输出持久化
  baseline_updating --> idle: baseline 更新完成
```

---

## 6. 运行时行为

### 6.1 读取历史

所有入口调用同一个 `load_incremental_history(budget, baseline)`：

1. 先读取稳定 snapshot/summary 和 baseline 元数据。
2. 按 `available_history` 反向选取最新的完整消息单元，再恢复正序。
3. tool call 与 tool result、assistant tool_use 与对应结果视为不可拆分单元。
4. 不先把超过硬预算的完整 history 读入内存；SQL 查询必须带 token/条数上限和 baseline 条件。
5. 旧 session 没有 baseline 时仍按 ContextBudget 计算窗口，不能以 `baseline=0` 读取全量数据库历史。
6. 动态 RAG、提醒、当前时间和渠道提示属于 dynamic tail，预检时计入但不被 history 裁剪误删。

### 6.2 硬预算与当前 round 重试

- 第一次 provider 请求前执行 preflight。
- 每次工具结果追加后、进入下一 round 前再次执行 preflight。
- 超过硬上限时，保护当前 turn，先压缩 baseline 之前/当前 turn 之前的 history。
- LLM 压缩成功、确定性裁剪成功或 baseline 提交后，必须重新组装并重试当前 round。
- 每个 round 使用统一 retry counter；压缩无进展时停止重复压缩并执行下一阶段的确定性裁剪。
- provider 返回 413 只能作为异常兜底，允许一次本地更激进裁剪重试；不能把 provider 错误作为正常预算流程。

### 6.3 软阈值 baseline 更新

- `total < soft_limit`：当前 run 正常结束，保持 baseline。
- `total >= soft_limit`：当前 run 仍完整完成并持久化；随后异步推进 baseline。
- baseline 更新只处理 baseline 之后的旧 history，不能删当前 run。
- baseline 更新结果的完整上下文必须不超过 `compression_cap_tokens`，即模型上下文上限的 50%。
- baseline 更新完成后，pending session 必须重新领取排队消息；不发送重复回答。

### 6.4 Pending 与并发

- 新主动消息先落库，再在同一事务中将 `pending=true` 并设置最早 pending message id。
- 已有 running/baseline_updating 时，不再启动第二个 agent loop。
- 被动群消息只落库，不把 session 标成需要生成的 pending。
- 当前任务结束后按 message id 顺序 drain pending；若多条消息可安全合并，合并规则必须明确记录且不能跨用户/群权限边界。
- worker 崩溃时，租约过期后由新 worker 根据持久化状态恢复；不可仅根据 Redis key 是否存在判断“没有 pending”。

### 6.5 Snapshot/baseline 原子性

baseline 更新事务必须：

1. 对 session 行加锁或使用 revision CAS。
2. 确认任务覆盖的 baseline 仍是当前 baseline。
3. 写入新 summary、snapshot_context/hash、baseline id/hash、revision 和 baseline 更新时间。
4. 成功提交后再发布 invalidation/event。
5. 旧任务发现 baseline/revision 已变化时放弃写入并重新排队，不覆盖新内容。

---

## 7. 当前实现审查与修改盘点

| 文件/目录 | 当前职责与问题 | 本 PRD 计划修改 | 完成后清理 |
| --- | --- | --- | --- |
| `backend/agent/context/budget.py` | 有效预算、90% safe、20% target、最近 20 条 fallback 混在一起 | 原地收口为唯一 `ContextBudget` 计划/计量/决策 API；字段化记录 fixed/dynamic/history/current/overhead | 删除 `SAFE_BUDGET_RATIO`、`POST_RUN_CHECKPOINT_RATIO`、`HARD_TARGET_RATIO` 等同义常量及隐式 20%目标；不并行创建第二个预算模块 |
| `backend/agent/context/compaction.py` | 当前 run LLM 压缩；使用 `COMPACTION_THRESHOLD_RATIO`、`COMPACTION_TARGET_RATIO=20%` | 接入 ContextBudget；目标改为“结果总量 <=50%，无下限”；压缩只接收受限 history | 删除 `COMPACTION_*` 常量和与 baseline 更新重复的预算计算 |
| `backend/agent/context/compress_conv.py` | 后台 baseline 更新、Redis 压缩锁、local task、baseline CAS；仍有 `token_budget`/force 20% | 原地收口为统一 baseline 更新入口；只有在文件职责无法承载时才拆出 coordinator，并删除原入口 | 删除 `FORCE_COMPRESS_TARGET`、独立 `token_budget` 语义、无法跨进程恢复的本地 task 作为事实来源 |
| `backend/agent/context/session_history.py` | `history_budget_for_context` 固定 reserve 35%，入口各自计算 | 只保留 baseline 增量读取，预算由 ContextBudget 传入；统一工具消息组选择 | 删除 `history_budget_for_context`、固定 reserve heuristic |
| `backend/agent/context/tokens.py` | `HISTORY_TOKEN_BUDGET=120000`、`HISTORY_MAX_MSGS=500` 作为独立上限 | 将条数/单页保护变成 ContextBudget 的查询安全上限 | 删除与模型预算冲突的固定 history token 常量；保留必要的查询保护常量并改名说明 |
| `backend/agent/context/session_snapshot.py` | snapshot TTL、hash、baseline 辅助函数并存，存在旧兼容路径 | 明确一个 active baseline revision；统一 snapshot、summary 与 baseline 的提交/读取契约 | 清理旧 snapshot/summary 双水位、无效 invalidate 顺序和临时 legacy 注入分支 |
| `backend/agent/context/message_assembly.py` | fixed prefix、dynamic tail、conversation replacement 边界 | 由 ContextBudget 输出组装计划，保证动态尾部不被误裁剪 | 删除入口自定义拼接分支和重复的固定前缀计数 |
| `backend/agent/context/history.py` | tool history 规范化、时间提示和原子消息组 | 保留原子化能力，接入统一 history unit/token 计量 | 不删除 provider/tool 合法性清理；删除重复的窗口裁剪实现 |
| `backend/agent/context/provider_history.py` | provider tool_use/tool_result 规范化 | 保持 provider payload 合法性，预算只由 ContextBudget 决定 | 删除与会话压缩重复的历史裁剪；保留 provider 特有格式清理 |
| `backend/agent/core.py` | 每轮 preflight、inline compaction、413 retry，仍使用多套预算 | 统一 preflight/round retry/baseline 事件；压缩完成强制重试当前 round | 删除重复 safe/hard 预算分支、重复计数器和无进展 retry |
| `backend/agent/runner.py` | IM/定时入口、历史读取、生成、baseline wrapper 多处重复 | 抽取可复用的最小执行函数，优先复用现有 runner；不再叠加新的入口 wrapper | 删除两套 `_run_*_unlocked` 中重复历史预算/等待 baseline 代码 |
| `backend/agent/gateway/web.py` | Web 独立加载历史、生成 wrapper、baseline 更新 | 复用 runner/context 的最小执行函数；保留 Web stream/event 输出 | 删除 Web 专属 `history_budget`、重复 gate/wait 和旧后台生成分支 |
| `backend/agent/im/loop.py` | 被动群落库 shortcut 与主动生成 | 以 session pending 状态区分主动/被动；统一 drain 与单任务执行 | 删除仅依靠入口局部判断的并发/重复回复防护 |
| `backend/app/models/__init__.py` | 有 baseline/snapshot 字段，无完整执行/pending 事实状态 | 只增加无法由现有字段表达的 execution/pending/baseline revision 字段 | 删除仅供旧 Redis 推断使用的冗余字段（迁移确认后） |
| 数据库迁移目录 | 尚未承载统一 pending/revision schema | 新增可回滚迁移、旧 session 默认 idle、旧 baseline 可安全兼容 | 清理临时迁移和未使用索引 |
| `backend/agent/loop_drivers.py` | provider 工具 JSON/单结果字段级截断 | 保持 provider payload 安全，调用统一 ContextBudget 的 retry 信号 | 不删除 provider 专属字段截断；删除重复 context history 裁剪 |
| `backend/agent/rag/**` | RAG 动态尾部/快照去重 | 明确 dynamic tail 计入总预算，超限时不误删当前 RAG 结果；必要时按 RAG 结果数降级 | 删除把 RAG 当作独立历史预算的旧分支 |
| `backend/tests/test_compaction.py` | 20%目标、inline compaction、gate 测试 | 改为 50% cap、无下限、当前 round 重试、无进展保护 | 删除旧 20%断言和重复 gate 断言 |
| `backend/tests/test_session_history.py` | 固定 35% reserve/history budget 测试 | 改测 ContextBudget 全量分项、baseline 增量和硬 cap 读取 | 删除 `history_budget_for_context` 专属测试 |
| `backend/tests/test_im_protocol.py` | 被动群消息不触发生成测试 | 增加 pending、顺序 drain、单任务和跨 worker 场景 | 清理仅模拟 Redis key 的旧并发测试 |
| 新增 `backend/tests/test_budget.py` | 无统一预算契约测试 | 覆盖总量、90%、50%、动态尾部、工具轮、单条超限 | — |
| 新增 `backend/tests/test_session_execution.py` | 无 session 状态机测试 | 覆盖 running/baseline_updating/pending/draining/崩溃恢复 | — |
| 新增 `backend/tests/test_baseline_atomicity.py` | 无 baseline/snapshot 原子提交回归 | 覆盖 CAS、revision、旧任务放弃写入、提交后 drain | — |
| `docs/product/PRD/**` | 多份文档拥有旧 20%/固定窗口语义 | 更新交叉引用；本文件作为唯一 ContextBudget 权威 | 标记旧段落已替代，移除矛盾的执行 TODO |

### 7.1 不应误删的代码

以下不是本 PRD 要删除的“重复压缩逻辑”：

- provider 的消息格式清洗、tool_use/tool_result 配对和 API payload 合法性修复；
- 单个文件、图片、视频、工具结果的字段级大小限制；
- Memory/RAG 的长期记忆维护、embedding/BM25/ILIKE 搜索和索引更新；
- 渠道消息发送、键盘/降级文本、权限和 destructive confirm；
- 当前 run 的 tool round 原子保护和异常脱敏日志。

---

## 8. 新建与修改文件清单

### 8.1 建议新建

- `backend/tests/test_budget.py`。
- `backend/tests/test_session_executor.py`（只有现有 runner 无法承载统一执行测试时才新增）。
- `backend/tests/test_baseline_atomicity.py`。
- 数据库迁移文件：ConversationSession 执行状态、pending、水位 revision（实际目录按项目迁移约定落地）。

实现代码原则上不新增预算/执行模块：`budget.py`、`compress_conv.py`、`runner.py` 和 `web.py` 原地收口。只有确认某个新模块能删除对应旧职责时，才允许新增 `session_executor.py` 或 `baseline_coordinator.py`；新增后必须在同一阶段删除被替代的函数和 wrapper。

### 8.2 必须修改

- `backend/app/models/__init__.py`
- `backend/agent/context/budget.py`（保留为唯一预算模块，清理其中旧的重复语义）
- `backend/agent/context/compaction.py`
- `backend/agent/context/compress_conv.py`
- `backend/agent/context/session_history.py`
- `backend/agent/context/session_snapshot.py`
- `backend/agent/context/message_assembly.py`
- `backend/agent/context/tokens.py`
- `backend/agent/core.py`
- `backend/agent/runner.py`
- `backend/agent/gateway/web.py`
- `backend/agent/im/loop.py`
- 相关 provider history/loop driver 调用点
- 所有受影响的单元测试、集成测试和上下文文档

---

## 9. 完整实施 TODO

### Phase 0：审计、基线与可观测性

- [ ] 固化当前 Web/私聊/群聊/定时任务的 history、snapshot、baseline 调用链图。
- [ ] 建立重构前代码量基线：运行时代码总行数、预算/压缩相关函数数、入口 wrapper 数和重复分支数。
- [ ] 列出所有预算常量、history loader、compaction caller 和 retry caller，建立删除清单。
- [ ] 为 `ContextBudget` 定义 Python 类型、字段命名和日志 schema。
- [ ] 增加脱敏 `context-budget` 事件：总量、各分项、baseline、round、action、retry 次数；禁止记录正文。
- [ ] 为长群会话、短私聊、Web 多工具、单条超大结果建立固定 fixture。
- [ ] 明确旧 session/旧 snapshot/无 baseline 的迁移兼容策略。

### Phase 1：唯一 ContextBudget 与统一历史读取

- [ ] 在唯一 `budget.py` 中实现总量计算、soft 90%、compression cap 50% 和 history capacity。
- [ ] 将 `session_history` 改为只接收 ContextBudget 计划，不再自行计算 35% reserve。
- [ ] 将 Web、IM、定时任务入口改为同一 history loader。
- [ ] 查询层按 baseline、token 上限和条数安全上限加载，禁止全量超预算读取。
- [ ] 保证动态尾部、工具 schema、当前消息和当前工具轮计入总量且不被历史裁剪误删。
- [ ] 保留 tool call/tool result 原子消息组。
- [ ] 补齐 ContextBudget 单元测试和入口一致性测试。

### Phase 2：硬预算、压缩 cap 与当前 round 重试

- [ ] 将 core 的 preflight 改为 ContextBudget plan，并在每个 tool round 前调用。
- [ ] inline compaction 只处理保护边界前的 history。
- [ ] 将所有 20%目标改为“压缩后总量 <=50%，无下限”。
- [ ] 压缩完成后重新组装当前 round 并强制重试。
- [ ] 增加无进展检测、统一 retry counter 和单条输入过大错误。
- [ ] provider 413 仅保留一次确定性兜底，不启动无限 LLM 压缩。
- [ ] 验证超预算历史从数据库读取阶段即被限制。

### Phase 3：Snapshot 单一 baseline

- [ ] 把 inline compaction、后台 baseline 更新、手动 `/compact` 的提交契约统一到 baseline coordinator。
- [ ] 设计并执行 ConversationSession revision/pending/baseline schema 迁移。
- [ ] 在一项事务中提交 summary、snapshot、baseline、hash、revision 和覆盖范围。
- [ ] 使用 row lock/CAS 防止旧压缩任务覆盖新 baseline。
- [ ] 保证普通 run 不重建稳定 snapshot；只有 TTL/90% baseline 更新/明确维护点刷新。
- [ ] baseline 更新成功后发布 invalidation/event，失败保留可恢复状态。
- [ ] 更新 snapshot/hash/cache 相关测试。

### Phase 4：单 session 执行与 pending

- [ ] 实现 SessionExecutor，统一 Web/IM/定时任务入口。
- [ ] 主动消息写入 session pending；running/baseline_updating 时不启动第二个 loop。
- [ ] 当前任务完成后按 message id 顺序 drain pending，并保证不重复发送。
- [ ] 被动群消息只落库，不标记主动 pending，不触发生成。
- [ ] Redis gate 降级为跨 worker ownership/lease；pending 事实只读 session 状态。
- [ ] 增加 worker 崩溃、租约过期、重复投递和跨进程 drain 测试。

### Phase 5：清理重复实现与兼容迁移

- [ ] 删除/改名 `history_budget_for_context`、旧 budget ratio 和 20% target 常量。
- [ ] 删除入口重复的 `_unlocked` 历史预算、等待 baseline 和 retry 分支。
- [ ] 清理 local baseline task 作为事实来源的旧逻辑；仅保留可取消的进程内调度优化。
- [ ] 清理旧 snapshot 双水位、legacy group 注入和临时 fallback 分支。
- [ ] 复核 provider history/loop driver，确保只保留 payload 合法性处理。
- [ ] 更新旧 PRD 的替代说明，删除互相矛盾的 TODO 和 20%描述。

### Phase 6：测试、压测、部署与收口

- [ ] 单元测试：ContextBudget、消息原子组、压缩 cap、硬截断、重试。
- [ ] 集成测试：Web/私聊/群聊/定时任务统一历史窗口和 baseline 更新。
- [ ] 并发测试：同 session 10 条消息只有一个 active task，pending 顺序稳定。
- [ ] 回归测试：工具调用、图片附件、RAG 动态尾部、provider 413、模型切换。
- [ ] 使用真实脱敏 LoopScope/trace 对比 cache、输入 token、压缩次数和响应顺序。
- [ ] 在 devserver 执行迁移、重启 web/worker/supervisor，验证旧 session 可继续对话。
- [ ] 清理探针、临时日志、临时迁移和无用兼容导出。
- [ ] 对比重构前后代码量；新增抽象代码必须由删除的旧逻辑抵消，禁止保留双实现。
- [ ] 更新 changelog、devlog 和本 PRD 状态；提交前执行全量 typecheck/test。

---

## 10. 验收标准

### 10.1 正确性

- [ ] 任一入口发送给 provider 的 `total_tokens <= hard_limit_tokens`，除 provider 估算误差外不依赖 413 才裁剪。
- [ ] 任何压缩结果的总上下文 `<= compression_cap_tokens`（模型上限 50%）。
- [ ] 达到 90% 时当前 run 完成后才推进 baseline，不打断正常输出。
- [ ] 超硬上限的压缩/裁剪提交后，当前 round 必须重试且不会重复用户消息。
- [ ] 当前 run 的 user、assistant/tool_use、tool_result 不会被压缩删除。
- [ ] baseline、summary、snapshot、revision 同事务提交，旧任务不能覆盖新任务。
- [ ] 同一 session 永远只有一个 active generation；pending 消息按顺序继续。
- [ ] 被动群消息可见于下一次上下文，但不自动回复。

### 10.2 性能与缓存

- [ ] 跨 run 首轮在 baseline 未变化时 history 前缀稳定，cache 不因每轮 inline summary 变化而抖动。
- [ ] 长群会话不再每轮重复压缩；压缩次数与 90% baseline 更新次数一致。
- [ ] 超大历史不会在数据库查询或 Python 内存中先完整加载。
- [ ] pending drain 不产生重复 provider 请求和重复渠道发送。

### 10.3 可观测性

每次决策至少记录以下脱敏字段：

```json
{
  "event": "budget",
  "session_id_fp": "…",
  "run_id": "…",
  "round": 1,
  "model_context_tokens": 128000,
  "total_tokens": 0,
  "fixed_prefix_tokens": 0,
  "dynamic_tail_tokens": 0,
  "history_tokens": 0,
  "current_turn_tokens": 0,
  "soft_limit_tokens": 0,
  "compression_cap_tokens": 0,
  "baseline_message_id": 0,
  "action": "none|trim|compact|baseline_update|retry|queue",
  "pending": false,
  "attempt": 0
}
```

不得写入聊天正文、附件名、URL token、用户昵称或原始 provider 异常。

### 10.4 代码量与重复逻辑

- [ ] 运行时代码总行数相对重构前保持同量级；新增的协调逻辑必须由删除旧实现抵消。
- [ ] 预算计算、历史窗口、压缩触发、baseline 更新、pending 排队各自只有一个权威实现。
- [ ] Web、IM、定时任务不得通过复制函数体实现统一行为；入口只保留渠道适配和调度。
- [ ] 不保留旧函数的“兼容转发”超过一个迁移周期；迁移完成后直接删除旧 API、旧常量和旧 wrapper。
- [ ] 代码审查清单必须列出新增行数、删除行数、重复函数数和重复 CSS/日志/请求数。

---

## 11. 风险与迁移策略

| 风险 | 缓解措施 |
| --- | --- |
| 旧 session 没有 baseline/revision | 迁移默认 baseline=0、revision=1，首轮按 ContextBudget 受限读取并在成功 baseline 更新后建立新水位。 |
| 旧 summary/snapshot 结构不一致 | 读取时做一次结构归一化，写回新版本；不在每轮重建。 |
| provider token 估算偏差 | 保留 provider overhead 和一次 413 确定性兜底；记录估算与实际错误类型。 |
| 压缩模型失败 | 先执行本地原子裁剪；当前 run 不因后台 baseline 更新失败而丢回复。 |
| worker 崩溃留下 running | lease + heartbeat 超时恢复；session pending/active_run_id 负责判断是否可重试。 |
| cache 率下降 | 固定前缀只在 baseline/revision 变化时更新；动态成员记忆/RAG 留在动态尾部并计入预算。 |
| 长期记忆与 session 压缩混淆 | Memory PRD 继续维护 daily/profile/pattern；本 PRD 仅消费其 snapshot/RAG 结果。 |

---

## 12. 文档与发布要求

- [ ] 更新 `docs/agent/context/context-budget-baseline-design.md`，改为引用本 PRD 的唯一预算语义。
- [ ] 更新 `PRD-AGENT-3`，标注其历史窗口方案已被本 PRD 替代。
- [ ] 更新 `PRD-LLM-8`，删除旧 20%压缩目标和重复 baseline 更新 TODO。
- [ ] 更新 `PRD-IM-6`，仅保留渠道会话复用与消息窗口的兼容说明。
- [ ] 在 `docs/devlog.md` 记录迁移前后 token/cache/压缩次数对比，不记录正文。
- [ ] changelog 只记录用户可感知的上下文稳定性、长群会话和并发行为变化。
- [ ] 完成代码审查后清理所有无效探针、旧 ratio、临时 fallback、重复 API 和未使用类型。
