# PRD-LLM-18：Agent 运行时生命周期收敛

> 状态：待实施
> 创建：2026-09-01
> 最近更新：2026-09-01
> 关联模块：`backend/agent/runner.py`、`backend/agent/context/run_context.py`、`backend/agent/context/run_finalize.py`、`backend/agent/core.py`、`backend/agent/im/loop.py`
> 背景参考：`docs/agent/02-ARCHITECTURE.md`、`docs/agent/03-AGENT-LOOP.md`、`【已完成】PRD-IM-2-IM-LOOP与GATEWAY解耦.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| 上下文准备统一 | 已有 `PreparedRun` 和 `prepare_run()` | 🟡 部分完成 | 已统一历史、RAG、姿态和 provider 消息组装，但入口前置生命周期仍在 Runner 中重复。 |
| 收尾逻辑统一 | 已有 `finalize_run()` | 🟡 部分完成 | canonical history、展示时间线、用量和 baseline 已有公共收尾，调用前后的生命周期仍分别维护。 |
| Agent 执行循环统一 | `core.py` 已有统一 `_run_loop` | ✅ 已完成 | Provider 差异已下沉到 driver；本 PRD 不重复改造该部分。 |
| collect/stream 生命周期 | 两个 `_unlocked()` 入口各自准备并执行 | 🔲 待评估 | 是本 PRD 的主要收敛对象。 |
| IM 编排 | `agent/im/loop.py` 仍同时负责策略和出站选择 | 🔲 待评估 | 作为后续阶段处理，不在第一阶段重写。 |

## 1. 背景与目标

### 1.1 现状问题

`run_collect()` 和 `run_stream()` 当前是两条完整的 Agent 生命周期。两者都分别处理会话、工作区、snapshot、history、附件、配额、连续性桥接、音频、工具能力、上下文准备、模型执行和持久化，只在 token 消费和渠道事件输出上存在必要差异。

这种复制已经造成过实际漂移风险：AsyncSession 退出时机、IM snapshot memory、主动消息前导、语音能力判断、baseline drain 等修复都需要同时维护两条路径。即使当前行为看似一致，后续修改也容易只改到其中一条。

同时，`agent/im/loop.py` 仍把消息归一化、shortcut、命令、会话、平台策略、Agent 执行、交互、记忆调度、平台发送和 trace 收尾集中在一个入口中。它不是本阶段的首要重写目标，但 Runner 生命周期收敛必须为后续拆分提供稳定的执行契约。

### 1.2 目标

建立一条共享的 Agent Run 生命周期：

```text
AgentRequest
  -> prepare_agent_run()
  -> PreparedExecution
  -> execute_agent_run()
  -> AgentEvent stream
  -> CollectSink / WebSSESink / QQSink / FeishuSink
  -> finalize_agent_run()
```

目标是：

1. collect 和 stream 共享同一套会话、上下文、模型执行、取消、错误和持久化语义。
2. 渠道差异只体现在事件消费和发送，不再复制 Agent 生命周期。
3. 在 LLM 第一次调用前，collect 与 stream 对同一请求产生等价的 `PreparedExecution`。
4. 保留现有公共入口和调用方兼容性，支持渐进迁移和回滚。
5. 为 IM loop 后续拆成 route、policy、execution、delivery 四层提供稳定边界。

### 1.3 非目标

- 不改变模型选择、工具权限、用户记忆、会话路由、RAG 召回或消息持久化语义。
- 不把 Web、QQ、飞书、微信强行抽象成一个万能 Gateway。
- 不在本阶段重写 `agent/core.py` 的 provider driver 和工具循环。
- 不在本阶段一次性拆分所有 Gateway 文件或重写 `agent/im/loop.py`。
- 不通过复制另一套“兼容 Runner”来掩盖旧实现；迁移完成后只能保留一套事实生命周期。

## 2. 功能需求

### FR-RUN-01：统一 Run 准备

所有需要执行 Agent 的入口必须调用同一个准备流程，按固定顺序完成会话解析、snapshot/history 读取、附件和语音处理、配额检查、连续性上下文、工具能力和 `PreparedExecution` 构造。

准备流程必须明确区分：

- 已持久化事实：session、snapshot、canonical history、用户消息和附件 claim。
- 本轮动态输入：当前消息、时间、RAG 尾部、主动消息和临时提醒。
- provider 适配输入：Anthropic/OpenAI 消息结构及各自的初始长度。

### FR-RUN-02：统一 Agent 事件协议

执行层必须以统一事件序列向 Sink 输出至少以下事件：

| 事件 | 语义 |
|---|---|
| `round_start` | 新模型轮次开始。 |
| `token` | 可展示的增量文本。 |
| `round_end` | 一轮文本结束，可供 IM 分轮发送。 |
| `tool_event` | 工具调用或工具完成状态。 |
| `interaction` | 等待用户选择、确认或补充输入。 |
| `file` | 本轮产生的文件。 |
| `error` | 不可继续的执行错误。 |
| `cancelled` | 用户取消或运行时取消。 |
| `final` | 本次 Run 的最终结果及会话标识。 |

事件不包含用户正文、附件名、凭据或未经脱敏的内部异常。Sink 不得改变事件语义或重新执行 Agent。

### FR-RUN-03：collect 与 stream 行为等价

对相同的 `AgentRequest`、session snapshot 和 history，collect 与 stream 在第一次调用 LLM 前必须生成等价的：

- system prompt；
- snapshot 注入；
- canonical history；
- RAG 结果和动态提醒；
- 工具集合与工具 Schema 来源；
- 图片、音频和其他媒体输入；
- provider model config；
- 消息初始长度和持久化所需的上下文元数据。

允许的差异仅包括 Sink 类型、token 是否即时交付以及 provider 流式参数。

### FR-RUN-04：统一收尾与资源生命周期

正常完成、工具续轮、交互暂停、取消、模型错误、平台发送失败和生成器提前关闭，都必须经过同一套可判定的收尾策略。

收尾必须保证：

- AsyncSession 不跨越 LLM 等待时间复用；
- 模型计数、连接和临时资源在所有出口释放；
- final 事件不早于必要的持久化和 baseline 处理承诺；
- collect 与 stream 生成的 canonical history、用量、反思和压缩行为一致；
- Sink 发送失败不会静默把 Run 标记为成功。

### FR-RUN-05：兼容现有入口

保留 `run_collect()`、`run_stream()`、`OwnerAgentLoop` 和现有 Web/IM 调用方式。兼容入口只负责构造请求、选择 Sink 和转发结果，不再保留业务生命周期副本。

## 3. 技术方案

### 3.1 分层

建议在 `backend/agent/` 下形成以下职责边界：

```text
agent/
  run/
    preparation.py     # 请求、会话、上下文和能力准备
    execution.py       # 统一 AgentEvent 执行流
    finalization.py    # 统一收尾门面
    events.py          # 事件类型和状态约束
  runner.py            # 现有兼容入口和 Sink 适配
  context/
    run_context.py     # PreparedRun 的上下文组装实现
    run_finalize.py    # canonical history 与用量持久化实现
```

目录名可以根据现有模块约定调整，但必须保持单一事实源；不允许新的 `collect_*` 和 `stream_*` 各自复制 preparation/finalization。

### 3.2 PreparedExecution

`PreparedExecution` 应是执行层唯一输入，至少包含：

- `session_id`、`is_new_session` 和请求归属信息；
- `model_cfg`、`use_anthropic`、工具能力和权限裁剪结果；
- `PreparedRun`；
- 用户消息和附件持久化标识；
- baseline、RAG、反思和压缩收尾所需元数据；
- 取消、交互和 trace 所需的运行标识。

对象构造完成后应视为不可变执行快照。需要修改的执行状态放在 Run state 中，不回写准备对象中的输入事实。

### 3.3 Sink 边界

执行层只产生事件，不知道 QQ、飞书 CardKit、Web SSE 或普通 collect 的发送细节：

- `CollectSink`：收集 token、round 和 final，返回 `AgentResponse`。
- `WebSSESink`：将事件映射为现有 SSE 帧，保持前端协议兼容。
- `QQRoundStreamSink`：按 `round_end` 发送，处理传输失败后的 drain。
- `FeishuCardSink`：把 token/round 更新到 CardKit，保留 fallback drain 语义。

Sink 只能消费事件；最终持久化由统一 finalization 负责，不能由平台 Sink 各自补写历史。

### 3.4 IM 后续拆分边界

本 PRD 只预留接口，不在 Phase 1 同时搬迁全部 IM 逻辑。后续可将 `agent/im/loop.py` 的职责逐步分为：

```text
normalize/route -> IM policy -> Agent execution -> DeliverySink
```

平台差异仍保留在平台适配层；共享的是 AgentEvent 到 delivery outcome 的契约，而不是所有平台实现。

### 3.5 观测与隐私

运行诊断只记录事件类型、阶段、耗时、计数、错误分类和脱敏 fingerprint。不得记录聊天正文、附件名、模型密钥或完整工具参数。探针只能用于迁移期间定位生命周期差异，验证完成后必须删除。

## 4. 验证与上线

验证分三层：

1. **契约测试**：对相同 fake request、snapshot、history、attachments 和 model config，比较 collect/stream 的 `PreparedExecution` canonical fingerprint。
2. **生命周期测试**：覆盖首轮文本、多轮工具、交互暂停、取消、模型异常、Sink 发送失败和生成器提前关闭；验证 final、持久化和资源释放顺序。
3. **真实入口回归**：Web collect、Web SSE、QQ 普通回复、QQ 流式回复和飞书 CardKit 分别验证事件顺序、重复发送、附件发送、baseline drain 和 trace 状态。

重点验收指标：

- collect/stream preparation parity 测试不依赖源码字符串计数；
- 连续 N 次 streamed run 后连接 checkout 回到 baseline；fake session 在退出 context 后被调用时测试失败；
- 同一 Run 的 canonical history 和 usage 只能写入一次；
- QQ/飞书传输失败后 Agent 仍按既有约定 drain 或明确失败；
- 现有 Web/IM API 响应协议无破坏性变化。

发布采用兼容入口逐步切换。若新执行层出现异常，可将入口开关切回旧路径，但旧路径只作为短期回滚手段，不能继续接受新功能修改。迁移完成后删除旧生命周期代码和临时探针。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 过早统一事件语义 | 破坏 QQ/飞书已有分轮、CardKit 或 fallback 行为 | 先锁定现有事件与回归，再迁移 Sink；保留平台特有发送策略。 |
| preparation 包含平台条件 | 共享层继续出现隐式平台分支 | 将平台策略作为显式 `ContextPolicy`/execution option 传入，并测试来源。 |
| final 与 baseline 时序改变 | 下一轮读取到不完整 snapshot 或重复压缩 | 将 baseline gate 作为 finalization contract，不由 Sink 决定。 |
| 迁移期间新旧路径并存过久 | 修复继续发生分叉 | 为兼容路径设置明确删除任务和迁移完成门槛。 |
| IM loop 同时重构 | 问题定位范围扩大，平台回归成本上升 | 本 PRD Phase 1 只收 Runner；IM/Gateway 另立阶段或更新对应 PRD。 |

待确认问题：

- `PreparedExecution` 是否直接放入新的 `agent/run/` 目录，还是先在 `runner.py` 内部建立兼容类型后再迁移。
- 统一事件是否沿用当前 tuple 形式，还是迁移为带类型约束的 dataclass；必须以不破坏现有 Web/IM 协议为前提。
- 是否在第一阶段接入运行时 feature flag，还是通过测试完成后一次性切换兼容入口。

## 6. 唯一实施 TODO

### Phase 1：契约与基线

- [ ] `LLM18-001` 定义 `PreparedExecution`、`AgentEvent` 和 finalization contract；验收：类型、状态转移和事件字段有单一实现，未引入平台发送逻辑。
- [ ] `LLM18-002` 将当前 collect/stream 的 LLM 前准备流程抽为共享 preparation；验收：两条入口不再分别执行 session、snapshot、history、附件、配额和能力准备。
- [ ] `LLM18-003` 增加基于行为 fingerprint 的 collect/stream preparation parity 测试；验收：测试比较实际准备结果，不读取 `runner.py` 源码计数。

### Phase 2：统一执行与收尾

- [ ] `LLM18-004` 将模型事件消费和统一收尾接入共享 execution pipeline；验收：文本、工具续轮、交互、取消、错误和提前关闭均经过同一收尾门。
- [ ] `LLM18-005` 将 Web、Collect、QQ 和飞书的差异收敛为 Sink；验收：现有响应协议、分轮发送、CardKit 更新和传输失败 drain 回归通过。
- [ ] `LLM18-006` 增加 AsyncSession、模型计数、baseline 和 canonical history 的生命周期回归；验收：连续 streamed run 无资源泄漏、重复持久化或提前 final。

### Phase 3：兼容清理与后续边界

- [ ] `LLM18-007` 保留并验证 `run_collect()`、`run_stream()`、`OwnerAgentLoop` 兼容入口；验收：调用方无需修改即可切换共享执行层，旧入口只剩适配职责。
- [ ] `LLM18-008` 删除重复生命周期、临时探针和过渡分支，并同步 `docs/agent/02-ARCHITECTURE.md`、`docs/agent/03-AGENT-LOOP.md`；验收：静态检查确认不存在第二套 preparation/finalization，文档与代码一致。
- [ ] `LLM18-009` 评估并单独规划 IM loop 的 route/policy/execution/delivery 拆分及 Gateway 纵向模块化；验收：形成下一阶段边界结论，不在本阶段扩大 Runner 迁移范围。
