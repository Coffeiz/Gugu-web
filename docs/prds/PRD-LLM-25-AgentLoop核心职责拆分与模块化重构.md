# PRD-LLM-25：Agent Loop 核心职责拆分与模块化重构

> 状态：🔲 待实施，已完成职责审查和迁移方案设计
> 创建：2026-09-16
> 最近更新：2026-09-16
> 所属层：Agent / LLM Runtime / Loop Architecture
> 关联模块：`backend/agent/core.py`、`backend/agent/loop_drivers.py`、`backend/agent/runner.py`、`backend/agent/context/`、`backend/agent/interactions/`、`backend/agent/tools/`
> 背景参考：`PRD-LLM-1`、`PRD-LLM-11`、`PRD-LLM-14`、`PRD-LLM-18`、2026-09-16 `core.py` 职责审查报告

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| `LLMRunner` 公共入口 | 已有 | 🟡 部分完成 | `core.py` 对外提供稳定入口，多个 gateway、runner、scheduled runner、LoopScope hook 和测试直接依赖。 |
| Provider 驱动抽象 | 已有 | 🟡 部分完成 | `loop_drivers.py` 已承担多数 provider round 逻辑，但 `_stream_round` 和部分 provider 转发仍留在 `core.py`。 |
| Context / History 模块 | 已有 | 🟡 部分完成 | 压缩、预算、canonical history、provider history、动态尾部和持久化已有独立模块，但主循环仍直接编排大量细节。 |
| 工具协议与工具注册 | 已有 | 🟡 部分完成 | `tools/base.py`、`tool_contract.py`、`meta.py` 已形成工具基础设施，工具解析、批次状态和交互恢复仍集中在 `core.py`。 |
| 交互确认与恢复 | 已有 | 🟡 部分完成 | 确认门和交互服务已经独立，但 `ask_user`、确认重放、MCP 凭据输入、取消和过期仍与主循环深度耦合。 |
| Agent Loop 模块边界 | 未完成 | 🔲 待评估 | 当前 `LLMRunner._run_loop` 约 1485 行，混合至少八类职责，是本 PRD 的主要重构对象。 |

## 1. 背景与目标

### 1.1 背景

`backend/agent/core.py` 当前约 2318 行，核心问题集中在 `LLMRunner._run_loop`。该函数同时维护 provider 请求、上下文压缩、工具调用、确认交互、自我核实、输出守卫、SSE 事件和 IM 状态。

当前结构指标如下：

| 指标 | 观察值 | 说明 |
|---|---:|---|
| `core.py` 总行数 | 约 2318 | 包含公共入口、兼容 helper 和主循环。 |
| `_run_loop` 行数 | 约 1485 | 从第 834 行至第 2318 行。 |
| `_run_loop` 复杂度 | `ccx≈904` | 为当前 Agent Python 代码的主要复杂度热点。 |
| `core.py` 热点 | `churn=111`、`ccx=1118`、`score=124098` | 说明该文件既复杂又经常变化。 |
| `_run_loop` 局部状态 | 20 余项 | 包括预算、核实、守卫、重试、工具熔断、压缩和事件序号。 |

近期 MCP 管理工具出现确认后无限循环，修复需要直接修改主循环的交互恢复分支。这说明交互状态机和工具执行状态仍然缺少独立边界，继续在 `core.py` 追加特殊分支会增加回归风险。

### 1.2 目标

1. 将 Agent Loop 按职责拆分为 provider、round、tool、interaction、guard、event 和 state 模块。
2. 让 `core.py` 只负责公开 runner 兼容层、依赖注入和高层状态转移。
3. 复用现有 `context/`、`interactions/`、`tools/`、`providers/` 和 `runtime/` 模块，禁止建立重复的第二套上下文、权限、确认或 provider 协议。
4. 保持 Anthropic、OpenAI、OpenAI Responses 和 Ollama 的行为一致。
5. 保持 canonical history、tool call/result 顺序、dynamic tail、cache control 和 reasoning state 边界不变。
6. 保持 LoopScope hook、scheduled runner、gateway、IM 和现有测试的兼容性。
7. 将复杂度从一个 1485 行函数分散到具名的、可单独测试的职责模块，而不是仅做文件搬运。

### 1.3 非目标

- 不重新设计 Agent Loop 的业务行为、工具额度、核实次数、压缩阈值或无限模式语义。
- 不重新设计 provider API；provider 差异继续由现有 driver/adapter 处理。
- 不把业务工具实现搬到 Loop 目录。
- 不把权限判断、确认门或用户偏好复制到提示词或新的循环模块。
- 不在本 PRD 中重写 ContextBudget、canonical history 或压缩算法；这些能力继续以现有 PRD 和模块为准。
- 不为了缩短 `core.py` 把每个小 helper 拆成独立文件。
- 不删除旧导入路径，除非所有外部调用点和测试已经迁移并有兼容验证。

## 2. 功能需求

### FR-LLM25-001：保留稳定的 Runner 公共入口

`LLMRunner`、`LLMRunner.run`、`LLMRunner._run_loop` 以及现有 provider 入口在迁移期间保持可用。外部调用方不需要知道内部模块拆分。

以下调用关系必须继续成立：

```text
gateway/web.py            → LLMRunner
runner.py                 → LLMRunner
scheduled.py              → ScheduledLLMRunner(LLMRunner)
loopscope_trace/hooks.py  → LLMRunner._run_loop
diagnostic scripts        → agent.core compatibility exports
tests                     → core helper monkeypatch/imports
```

### FR-LLM25-002：统一 Round 生命周期

一次 provider round 必须具有明确的生命周期：

```text
准备 round
→ 检查取消、预算和绝对轮次
→ 调用 provider driver
→ 归一化文本、tool calls 和 usage
→ 处理 context overflow / compaction
→ 决定继续、暂停、核实或结束
```

round 模块不得直接持久化数据库消息，不得生成具体业务工具结果，不得决定渠道展示格式。

### FR-LLM25-003：统一工具批次生命周期

工具调用必须经过统一流程：

```text
provider tool call
→ 工具名/Adapter 解析
→ Schema 和权限校验
→ destructive confirmation gate
→ dispatch
→ canonical tool result
→ tool event / artifact event
→ 判断是否进入核实或下一轮
```

直接工具调用、固定 Adapter 调用、确认后重放和交互恢复不得各自实现一套不同的结果写回逻辑。

### FR-LLM25-004：交互暂停和恢复必须显式建模

以下状态必须能够被结构化表达，而不是依赖多个局部布尔变量组合猜测：

- 等待破坏性操作确认；
- 等待 `ask_user` 选择或文本；
- 等待 MCP 或其他工具凭据；
- 等待工具额度继续/停止；
- 用户主动取消；
- 交互过期；
- 确认后按原参数重放工具；
- 两阶段交互返回新的 `ask_user`。

确认重放必须保持原始工具名、参数、tool call ID、session、run 和权限上下文一致；不得让模型因重放结果格式错误而重新规划同一个调用。

### FR-LLM25-005：Context 只复用现有模块

Loop 只负责决定“何时触发”压缩和 fallback，具体能力必须继续由以下模块提供：

```text
context/assembly/          PromptMessages、批次和消息替换
context/budget.py          预算、截断、overflow fallback
context/compaction.py      摘要压缩、原子消息单元和摘要校验
context/provider_history.py Provider 历史角色与持久化边界
context/canonical_tool_history.py canonical tool event
context/reasoning_state.py 跨 provider 推理状态
context/run_finalize.py    run 收尾持久化
```

不得在新 Loop 模块中复制消息拼接、压缩、canonical serialization 或 baseline 持久化实现。

### FR-LLM25-006：Guard 行为集中且有界

空回复、叙事型假执行、行动意图、句末冒号、工具必调、决策回避、goal 完成和核实占位文本等 guard 必须具备：

- 明确的触发条件；
- 单独的重试计数；
- 明确的最大重试边界；
- 不泄漏内部提示或完成标记；
- 与 provider 无关；
- 失败后可安全结束或返回明确结果。

基础文本判断继续复用 `security/core_guards.py`，Loop 只负责将判断结果转成状态转移。

### FR-LLM25-007：事件输出与业务状态分离

事件编码、序号、round 起止、tool 状态、artifact、usage、取消和压缩事件必须由事件模块统一生成。事件模块不得读取数据库或执行工具；业务工具不得自行拼接 SSE 字符串。

### FR-LLM25-008：取消、预算和绝对安全上限不可丢失

拆分后必须保留当前安全边界：

- IM 和 Web 的取消检查；
- 普通工具调用额度；
- 核实轮次额度；
- 连续相同工具调用熔断；
- 绝对 round 安全上限；
- provider context overflow 后的压缩/fallback；
- interaction timeout 和 cancellation。

任何模块不得以“无限模式”为理由移除服务级安全上限。

## 3. 技术方案

### 3.1 目标文件目录

```text
backend/agent/
├── core.py                                      【修改】公共 Runner 兼容层与高层状态机
├── loop_drivers.py                              【修改】统一 provider round 驱动，去除反向依赖
├── loop/
│   ├── __init__.py                              【新增】稳定导出和模块说明
│   ├── models.py                                【新增】RunState、RoundState、PendingInteraction 等状态模型
│   ├── provider.py                              【新增】provider round 调用、usage 和重试适配
│   ├── rounds.py                                【新增】轮次预算、压缩触发和 round 状态转移
│   ├── tools.py                                 【新增】工具解析、批次 dispatch、结果与 verify 信号
│   ├── interactions.py                          【新增】确认、ask_user、暂停、恢复和 replay
│   ├── guards.py                                【新增】最终回复守卫和 guard 状态转移
│   └── events.py                                【新增】运行事件、artifact 和 usage 事件生成
│
├── context/
│   ├── assembly/messages.py                     【修改】集中保留 tool result 替换能力
│   ├── budget.py                                【修改】接收统一的 provider usage/overflow 调用
│   ├── provider_history.py                      【修改】承接 Anthropic 历史清洗
│   └── canonical_tool_history.py                【修改】承接工具结果和 canonical event 边界
│
├── interactions/
│   ├── confirmations.py                         【不改】确认身份、授权、消费和安全边界的唯一来源
│   ├── service.py                               【不改】交互创建、等待、回答消费和服务端状态
│   └── stream_events.py                         【修改】统一事件编码；不承载 Loop 状态机
│
├── tools/
│   ├── base.py                                  【修改】承接 dispatch 上下文和工具结果协议
│   ├── meta.py                                  【修改】承接固定 Adapter 工具处理
│   └── tool_contract.py                         【修改】承接工具名和 Adapter 参数规范化
│
├── runtime/
│   └── runtime_state.py                         【不改】取消、活动状态和 IM 状态的唯一存储接口
│
├── im/
│   └── context_runtime.py                       【条件】仅在确认存在重复 IM 状态桥接后承接 Loop 适配函数
│
└── security/
    └── core_guards.py                           【不改】基础文本 guard 判断和 locale 文案

backend/tests/
├── test_core_loop_characterization.py           【修改】保留兼容行为和主循环回归
├── test_loop_driver_usage_semantics.py          【修改】迁移 provider helper 导入并保留兼容导出测试
├── test_stream_round_retry.py                   【修改】覆盖 provider round 重试边界
├── test_interaction_protocol.py                 【修改】覆盖暂停、确认、恢复和取消
├── test_mcp_user_tools_e2e.py                   【修改】覆盖二阶段交互和 MCP 恢复
├── test_canonical_tool_history.py               【修改】覆盖工具批次和持久化顺序
└── test_agent_loop_modules.py                   【新增】新 Loop 模块的纯单元测试
```

关键边界：

- `core.py` 只做生命周期编排，不拥有 provider、工具业务、数据库或 SSE 细节。
- `loop/` 只处理 Agent Loop 状态，不取代 `context/`、`tools/`、`interactions/` 和 `providers/`。
- `context/` 负责消息、预算、压缩和 canonical history；Loop 只能调用其公开接口。
- `interactions/confirmations.py` 和 `runtime/runtime_state.py` 是权限/取消事实来源，不得在 Loop 中复制状态存储。
- `security/core_guards.py` 不迁移基础判断逻辑；新 `loop/guards.py` 只负责调度判断结果。
- `runner.py`、`gateway/web.py`、`scheduled.py` 和 LoopScope hook 本 PRD 中明确不改公共调用协议。

### 3.2 函数迁移矩阵

| 当前函数/区域 | 当前行数估计 | 目标归属 | 处理方式 |
|---|---:|---|---|
| `_sanitize_anthropic_history` | 20 | `context/provider_history.py` | 移动实现，`core.py` 保留兼容导出。 |
| `_provider_context_usage` | 12 | `context/budget.py` 或 `loop/provider.py` | 统一 provider usage 语义，不重复计算 IDF/缓存等指标。 |
| `_resolve_tool_call` | 55 | `tools/tool_contract.py` 或 `loop/tools.py` | 协议解析与主循环分离，保留旧导入名。 |
| `_resolve_adapter_arguments` | 15 | `tools/tool_contract.py` | 作为兼容适配，不再由主循环解释参数。 |
| `_stream_round` | 50 | `loop_drivers.py` / `loop/provider.py` | 消除 `loop_drivers.py → core.py` 反向 import。 |
| `_goal_mode_enabled`、`_unlimited_mode_enabled` | 30 | `context/run_context.py` / `commands/` | core 接收解析后的状态，不直接读取持久化偏好。 |
| `_user_unlimited_mode_enabled` | 12 | `context/run_context.py` 或偏好服务边界 | 不让主循环直接创建 DB session。 |
| `_goal_completed`、`_strip_goal_marker` | 8 | `loop/guards.py` | 保留 goal 完成协议。 |
| `_mutating_tools` | 11 | `tools/base.py` / `loop/tools.py` | 统一工具行为元数据，避免业务名称判断分散。 |
| `_is_successful_tool_result` | 21 | `tools/base.py` / `tools/result.py` | 统一字符串和 dict 结果判断。 |
| `_loaded_skill_slugs` | 35 | `capabilities/skill_registry.py` 或 `capabilities/runtime.py` | 归入能力状态，不在 Loop 扫描历史。 |
| `_is_verify_placeholder` | 11 | `loop/guards.py` | 与核实收尾状态集中管理。 |
| `_replace_tool_result` | 20 | `context/assembly/messages.py` | 使用 `PromptMessages.replace_tool_result` 作为唯一实现。 |
| `_artifact_sse`、`_closing_frames` | 21 | `loop/events.py` / `interactions/stream_events.py` | 结构化事件后统一编码。 |
| `_pending_tool_signal`、`_PendingInteraction` | 27 | `loop/models.py`、`loop/events.py` | 运行状态与显示事件分离。 |
| `_dispatch_in_session` | 20 | `loop/tools.py` | 保留 dispatch 上下文的单一入口。 |
| `_im_cancelled`、`_im_set_tool_state` | 45 | `runtime/` / `im/context_runtime.py` | 复用现有 runtime state，Loop 只调用接口。 |
| `_run_loop` 初始化区 | 100～140 | `loop/models.py`、`core.py` | 局部变量收敛为显式 `RunState`。 |
| `_run_loop` budget/provider 区 | 350～460 | `loop/provider.py`、`loop/rounds.py` | 保留状态转移，不保留 provider 细节。 |
| `_run_loop` tool 区 | 380～480 | `loop/tools.py` | 工具批次、结果、canonical event 独立测试。 |
| `_run_loop` interaction/replay 区 | 220～300 | `loop/interactions.py` | 最高风险，最后迁移并保留 characterization。 |
| `_run_loop` final guard 区 | 180～240 | `loop/guards.py`、`loop/events.py` | 只保留统一 guard 调度和收尾转移。 |

### 3.3 目标行数

| 文件 | 预计行数 | 说明 |
|---|---:|---|
| `backend/agent/core.py` | 500～700 | 公共 API、状态机、依赖注入和兼容导出。 |
| `backend/agent/loop/models.py` | 80～120 | 显式运行状态和交互状态。 |
| `backend/agent/loop/provider.py` | 100～150 | Provider round、重试和 usage 归一化。 |
| `backend/agent/loop/rounds.py` | 220～300 | 预算、压缩触发和 round 转移。 |
| `backend/agent/loop/tools.py` | 350～450 | 工具调用、结果、批次和核实信号。 |
| `backend/agent/loop/interactions.py` | 220～300 | 交互暂停、恢复、确认和 replay。 |
| `backend/agent/loop/guards.py` | 180～240 | 最终回复守卫和有限重试。 |
| `backend/agent/loop/events.py` | 80～120 | 事件模型和编码桥接。 |

迁移后 `core.py` 预计减少约 1100～1350 行；总代码量预计因状态模型、接口和测试增加约 5%～10%，但复杂度会从单一大函数分散到可独立验证的模块。

### 3.3.1 现有职责模块完整盘点

以下是本次审查时已经存在、且与 `core.py` 有职责关联的模块。行数为审查基线附近的近似值，用于评估重复职责和迁移规模，不作为实现后的硬性行数门禁。

| 现有文件 | 约行数 | 已有职责 | 与 `core.py` 的关系 |
|---|---:|---|---|
| `backend/agent/loop_drivers.py` | 754 | Anthropic/OpenAI/Ollama 的 provider prepare、round、tool schema 和消息投影 | 已拥有 provider round 主体；应接收 `_stream_round`，消除反向依赖。 |
| `backend/agent/runner.py` | 1243 | 流式/非流式 runner、MCP 能力装配、stream 收集、gateway 运行编排 | 是外层运行入口，不应再复制核心 round 状态机。 |
| `backend/agent/context/compaction.py` | 633 | 摘要压缩、原子消息单元、分支历史、摘要校验 | `core.py` 只负责触发时机和结果转移。 |
| `backend/agent/context/compress_conv.py` | 619 | 历史压缩策略、压缩提示和相关调度 | `core.py` 不应再次维护压缩比例和摘要策略。 |
| `backend/agent/context/budget.py` | 555 | ContextBudget、截断、provider overflow fallback、上下文预算 | 承接 `_provider_context_usage` 和 fallback 细节。 |
| `backend/agent/context/history.py` | 495 | canonical history envelope、tool message canonicalization、provider history parts | core 不应从 provider wire 重新推导历史语义。 |
| `backend/agent/context/assembly/messages.py` | 约 210 | `PromptMessages`、dynamic tail、conversation 替换、tool result 替换 | 承接 `_replace_tool_result`，是活动消息容器唯一修改入口。 |
| `backend/agent/context/canonical_tool_history.py` | 431 | canonical tool batch、ToolCall/ToolResult、Schema/Skill/Discovery event | 承接工具批次和结果持久化结构。 |
| `backend/agent/context/session_snapshot.py` | 418 | session snapshot、baseline hash、message hash | core 不直接维护 snapshot 或 baseline。 |
| `backend/agent/context/reasoning_runtime.py` | 311 | provider reasoning runtime | core 只在生命周期边界通知。 |
| `backend/agent/context/canonical_context.py` | 310 | canonical turn、历史单元分组、时间上下文规范化 | 负责 canonical 语义，不由 loop 复制。 |
| `backend/agent/context/reasoning_state.py` | 285 | 推理状态 envelope、状态指纹和持久化策略 | 继续接收 prepared/boundary/completed 生命周期事件。 |
| `backend/agent/context/run_finalize.py` | 281 | canonical turn 收尾、展示时间线、trim、baseline 持久化 | run 收尾由现有 finalize 服务负责。 |
| `backend/agent/context/builder.py` | 275 | prompt/context block 构造 | core 只接收已组装 context。 |
| `backend/agent/context/run_context.py` | 240 | run 准备、有效历史、姿态和上下文快照 | 适合承接 goal/unlimited 等 run 级输入状态。 |
| `backend/agent/context/loaders.py` | 229 | context 数据加载 | core 不直接拼装业务上下文。 |
| `backend/agent/context/provider_history.py` | 130 | provider role/history 准备、持久化历史清洗 | 适合承接 Anthropic 历史清洗。 |
| `backend/agent/context/context_diagnostics.py` | 168 | wire message shape、首个差异和上下文诊断 | core 只触发诊断，不保存诊断算法。 |
| `backend/agent/context/dynamic_tail.py` | 49 | 时间提醒和动态尾部消息 | 不得被新的 loop event 或 state 模块重复实现。 |
| `backend/agent/context/message_roles.py` | 71 | user message 定位和正文读取 | 保持为消息角色基础工具。 |
| `backend/agent/context/tokens.py` | 81 | 消息文本和 token 辅助 | 保持为上下文基础工具。 |
| `backend/agent/interactions/confirmations.py` | 326 | confirmation identity、grant、redeem、consume | 是确认授权唯一事实源，不能复制到 loop。 |
| `backend/agent/interactions/stream_events.py` | 约 20 | SSE 编解码 | 新 `loop/events.py` 只生成结构化事件，编码继续复用此处。 |
| `backend/app/services/interactions.py` | 现有服务 | prompt 创建、等待、动作/文本消费和确认桥接 | `loop/interactions.py` 只编排调用，不替代服务层。 |
| `backend/agent/tools/base.py` | 约 700 | registry、dispatch context、工具结果脱敏、progress、Tool/Skill 基础类型 | 承接工具协议和 dispatch 上下文。 |
| `backend/agent/tools/tool_contract.py` | 约 570 | 工具名、Legacy input、Schema validation、错误 payload | 承接 Adapter 参数和协议校验。 |
| `backend/agent/tools/meta.py` | 现有模块 | `call_tool`、`get_tool_schema`、`use_skill`、`ask_user` | 承接固定 Adapter，不让 core 解析业务协议。 |
| `backend/agent/runtime/runtime_state.py` | 约 240 | IM 活动、取消、等待和细粒度状态 | 是取消/运行状态的唯一存储接口。 |
| `backend/agent/security/core_guards.py` | 现有模块 | narration、intent、decision、colon、tool-progress 判断和 locale 文案 | 基础 guard 不复制；新模块只编排触发。 |
| `backend/agent/capabilities/skill_registry.py` | 现有模块 | Skill metadata、digest、用户 Skill registry | `_loaded_skill_slugs` 应并入能力状态边界。 |
| `backend/agent/gateway/web.py` | 约 1249 | Web SSE、session queue、取消和输出收集 | 仍是 transport/gateway 层，不下沉到 loop。 |

这份盘点的结论是：`core.py` 并非缺少所有抽象，而是已有抽象没有覆盖到主循环的状态编排边界；重构应优先“归位并复用”，而不是继续新增平行实现。

### 3.3.2 `core.py` 当前完整职责分布

| `core.py` 范围 | 主要职责 | 处理结论 |
|---|---|---|
| 第 1～199 行 | 常量、provider retry、`_stream_round` | retry/provider 迁移；常量中与状态机直接相关的安全上限可由 `loop/models.py` 或 `rounds.py` 统一导出。 |
| 第 223～274 行 | goal/unlimited 状态和完成标记 | 读取逻辑迁移到 `context/run_context.py`/commands；完成判定归入 guards。 |
| 第 322～447 行 | label、mutation、结果判断、Skill history 扫描、tool result 替换 | 分别归入 events、tools、capabilities、context；保留必要兼容导出。 |
| 第 450～616 行 | cancel、closing frame、pending interaction、artifact、dispatch session | 分别归入 runtime/interactions/events/tools，不应继续留在 core。 |
| 第 619～833 行 | `LLMRunner` 初始化、公共入口、provider 转发 | 只保留公共 API 和薄转发；provider 方法迁移到 driver/provider 模块。 |
| 第 834～1109 行 | `_run_loop` 初始化、动态状态、压缩 helper、interaction 通知 | 初始化收敛为 `RunState`；压缩调用归 `rounds`；通知归 `interactions`。 |
| 第 1110～1425 行 | 轮次预算、provider 请求、usage、异常和压缩 | 迁移到 `rounds.py`/`provider.py`。 |
| 第 1426～1912 行 | tool calls、协议错误、dispatch、工具结果、canonical event、verify 触发 | 迁移到 `tools.py`，canonical event 继续由 context 模块定义。 |
| 第 1913～2132 行 | confirmation、ask_user、MCP 凭据、取消、恢复、replay | 迁移到 `interactions.py`，这是最高风险边界。 |
| 第 2133～2318 行 | verify cycle、最终回复、空回复和各类 guard | 状态转移归 `rounds.py`，guard 判断/收尾归 `guards.py` 和 `events.py`。 |

### 3.3.3 当前外部调用与兼容约束

当前已确认的外部依赖包括：

```text
backend/agent/gateway/web.py
  → from agent.core import LLMRunner

backend/agent/runner.py
  → from agent.core import LLMRunner

backend/agent/scheduled.py
  → ScheduledLLMRunner(LLMRunner)

backend/agent/runtime/loopscope_trace/hooks.py
  → 保存/替换 LLMRunner._run_loop

backend/scripts/*
  → 直接导入 LLMRunner 或 core helper

backend/tests/*
  → monkeypatch core._stream_round、core._im_cancelled 等符号
```

因此本 PRD 的迁移单位是“内部实现可移动、外部兼容名暂时不动”。除非 Phase 6 明确完成引用清理，否则不得直接删除 `core.py` 的兼容导出。

### 3.4 兼容策略

迁移期间 `core.py` 保留兼容导出，不允许一次性修改所有调用方：

```python
# 迁移过渡示意
from agent.loop.provider import stream_round as _stream_round
from agent.loop.tools import resolve_tool_call as _resolve_tool_call
from agent.context.provider_history import sanitize_anthropic_history as _sanitize_anthropic_history
```

必须保留的兼容对象：

```text
LLMRunner
LLMRunner._run_loop
_stream_round
_sanitize_anthropic_history
_provider_context_usage
_loaded_skill_slugs
_resolve_adapter_arguments
SPECIAL_STATE_LABELS
```

旧测试对 `agent.core` 符号进行 monkeypatch 时，第一阶段不能强制改成新路径。待所有测试和 LoopScope hook 改为稳定公开接口后，才可以删除内部兼容别名，并单独记录 breaking change。

### 3.5 状态与数据不变量

拆分前后必须保持以下不变量：

1. `PromptMessages` 是当前 run 的唯一活动消息容器；压缩后仍更新同一生命周期中的消息引用。
2. canonical history 的追加顺序保持：动态上下文/RAG、当前用户消息、assistant/tool batch、tool result、后续 user follow-up。
3. Anthropic 和 OpenAI provider projection 可以不同，但 canonical history 不能因 provider 改变。
4. `cache_control`、dynamic tail 和稳定前缀不进入错误的历史批次，不因模块拆分被重复注入。
5. 确认后重放沿用原始工具调用的 session、run、tool call ID、参数和 dispatch context。
6. 工具结果先写入 canonical batch，再生成下一轮 provider 请求；不能先显示结果再补写历史。
7. reasoning state 在 provider 准备、context boundary change、round finish 和 run finish 时仍收到相同语义的通知。
8. 取消、过期、拒绝、工具失败和 provider overflow 不得被包装成成功结果。

### 3.6 责任归属判定

#### 应留在 `core.py`

- `LLMRunner` 公共构造、`run` 入口和旧接口兼容转发；
- 本次 run 的依赖注入：user/session/messages/driver/callback；
- `RunState`、`RoundResult`、`ToolTransition` 等模块之间的高层状态转移；
- provider round、tool batch、interaction resume、verify 和 final response 之间的顺序约束；
- run 级 usage 汇总和最终返回；
- 跨模块不变量检查和安全终止。

#### 应抽到已有模块

- Provider request、stream、retry：`loop_drivers.py`、`providers/`；
- Context、history、compression、budget：`context/`；
- canonical tool event 和消息替换：`context/assembly/`、`canonical_tool_history.py`；
- confirmation、wait、answer consume：`interactions/`、`app.services.interactions`；
- tool registry、Schema、Adapter 和 dispatch context：`tools/`；
- IM cancel/activity：`runtime/runtime_state.py`、`im/`；
- 基础文本 guards：`security/core_guards.py`；
- run finalization：`context/run_finalize.py`。

#### 应抽到新模块

只有当前没有合适 owner、且需要共享运行状态的部分才新建 `agent/loop/`：

- `RunState` 和 pending interaction 领域模型；
- round 生命周期和状态转移；
- 工具循环的编排层；
- interaction replay 编排层；
- final guard 的触发编排；
- 结构化 loop event。

这一区分避免两种错误：一是把所有内容机械搬进新目录，二是继续把新逻辑堆回已有的 god module。

## 4. 验证与上线

### 4.1 测试命令

每个阶段至少运行对应的后端测试：

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q \
  tests/test_core_loop_characterization.py \
  tests/test_loop_driver_usage_semantics.py \
  tests/test_stream_round_retry.py \
  tests/test_interaction_protocol.py \
  tests/test_mcp_user_tools_e2e.py \
  tests/test_canonical_tool_history.py \
  tests/test_agent_loop_modules.py

PYTHONPATH=. .venv/bin/pytest -q
python -m compileall -q app agent
python scripts/check_ownership.py
python scripts/check_confirm_gate.py
```

### 4.2 必须覆盖的行为

| 场景 | 验收标准 |
|---|---|
| Anthropic 普通回复 | 文本、usage、round event 与迁移前一致。 |
| OpenAI 普通回复 | 文本、usage、tool call 和异常收尾与迁移前一致。 |
| OpenAI Responses | 输入投影、工具结果和最终回复正常。 |
| Ollama | 本地 provider 不依赖 Anthropic/OpenAI 专属路径。 |
| 工具成功 | canonical tool call/result 顺序正确，写工具按规则进入 verify。 |
| 工具失败 | 不误判为成功，不无条件触发核实，不丢失错误结果。 |
| 确认门 | 未确认不 dispatch；确认后只重放一次原参数调用。 |
| 二阶段交互 | 确认后返回 `ask_user` 时等待用户输入，输入后继续同一 run，不进入无限循环。 |
| 取消和过期 | 工具气泡有终态事件，run 正常结束，不生成额外模型续轮。 |
| 工具额度 | 继续/停止语义与现有行为一致。 |
| 重复工具熔断 | 无限模式下仍受连续相同调用和绝对轮次上限保护。 |
| Context overflow | 只触发一次受控压缩/fallback，成功后继续，失败后明确收尾。 |
| 90% 压缩 | usage 语义仍为完整 provider input，缓存读写不被错误相加到累计用量。 |
| canonical history | 下一轮恢复、Anthropic/OpenAI 投影、连续 user 合并和缓存前缀测试通过。 |
| LoopScope | hook 仍能包裹 `_run_loop`，round/span 能正确完成、取消和记录 usage。 |

### 4.3 观测指标

迁移期间必须对比：

- 每个 run 的 round 数、tool call 数、verify 次数和终止原因；
- interaction waiting、resolved、cancelled、expired 数量；
- provider error 分类、context overflow recovery 次数；
- canonical batch 数、重复 batch 和 history shape 校验失败数；
- LoopScope span 是否残留 `running`；
- Anthropic/OpenAI 的输入、缓存读写和输出 usage；
- 无限模式下绝对安全上限触发次数；
- 同一测试 run 的最终文本和工具结果是否出现差异。

日志只能记录类型、状态、ID 指纹、耗时和计数；不得记录聊天正文、附件名、工具参数原文、凭据或 provider 原始密钥。

### 4.4 上线与回滚

采用兼容适配器分阶段上线：

1. 新模块默认只接管一个 provider round 或一个纯工具 helper，并保留旧路径回退。
2. characterization tests 和 LoopScope 对比无差异后，再扩大到完整 round。
3. 交互恢复模块最后切换，并重点观察 MCP、确认门和凭据输入。
4. 迁移期间保留内部开关或可回退导入路径；发现 canonical 顺序、确认或取消异常时，可切回旧实现。
5. 删除旧实现前必须完成全仓库引用搜索、测试迁移和 `git diff --check`，不能仅因新模块已能运行就删除旧符号。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 状态被拆散后出现隐式竞态 | 工具结果丢失、重复调用或无限循环 | 先建立 `RunState`/`PendingInteraction`，交互迁移最后进行。 |
| `loop_drivers.py` 与 `core.py` 互相 import | 初始化顺序或 monkeypatch 行为改变 | 先把 provider round 放入单向依赖模块，保留 core 兼容别名。 |
| canonical history 写入时机改变 | 下一轮 provider 请求非法或缓存前缀断裂 | 用 canonical batch、Anthropic/OpenAI projection 和连续 user 测试锁定顺序。 |
| `PromptMessages` 和普通 list 行为不一致 | 直接调用 runner 的测试或旧入口失败 | 保留普通 list 兼容适配，并测试两种容器。 |
| 交互恢复逻辑重复 | 确认、ask_user、MCP 凭据路径语义漂移 | 所有恢复统一进入 `loop/interactions.py`，工具执行统一由 `loop/tools.py` 调用。 |
| guard 迁移改变回复文本 | 用户看到内部提示、重复回复或假完成 | 复用 `security/core_guards.py`，保留现有 characterization tests。 |
| IM 状态桥接重复 | Web/IM 取消或状态显示不一致 | 取消和活动状态继续由 `runtime/runtime_state.py` 作为唯一事实源。 |
| 仅按文件长度拆分 | 文件数量增加但职责仍混合 | 每个新模块必须有明确输入/输出和独立测试，不接受机械搬运。 |

待确认事项：

- `loop/` 是否作为长期稳定目录，还是并入现有 `agent/runtime/`；本 PRD 推荐独立 `agent/loop/`，因为它表示 Agent Loop 领域而不是平台 runtime。
- `loop/events.py` 与 `interactions/stream_events.py` 的最终边界：推荐前者负责结构化运行事件，后者只负责 SSE 编码。
- `_loaded_skill_slugs` 是否应扩展现有 `capabilities/skill_registry.py`，还是新建 `capabilities/runtime.py`；实施前需根据调用方数量决定，禁止重复注册表。
- `_user_unlimited_mode_enabled` 是否应由 `context/run_context.py` 在 run 准备阶段完成，还是由上层 `runner.py` 注入；两种方案都不得让主循环直接访问数据库。

## 6. 唯一实施 TODO

### Phase 0：冻结基线

- [ ] `LLM25-001` 建立 core 迁移基线；验收：记录当前 commit、`core.py`/`_run_loop` 行数、关键测试结果、Anthropic/OpenAI/Responses/Ollama 行为和 LoopScope 观测指标；不修改运行代码。
- [ ] `LLM25-002` 梳理兼容调用点；验收：全仓库列出 `LLMRunner`、`_run_loop`、`_stream_round` 及 core helper 的导入、monkeypatch、继承和 hook 使用点，形成迁移清单。

### Phase 1：纯函数和 Provider 边界

- [ ] `LLM25-003` 抽取 provider round 和 usage 适配；验收：`loop_drivers.py` 不再反向 import `core.py`，provider retry 测试通过，`core.py` 兼容导出仍可被旧测试 monkeypatch。
- [ ] `LLM25-004` 迁移历史清洗、工具协议解析和工具结果基础 helper；验收：Anthropic history sanitize、Adapter 参数、tool result 替换和已有导入路径测试通过。
- [ ] `LLM25-005` 建立 `loop/models.py` 与 `loop/events.py`；验收：Run ID、event sequence、pending interaction 和 usage/event payload 有明确类型，事件输出与迁移前结构一致。

### Phase 2：Round 与 Context 编排

- [ ] `LLM25-006` 抽取 `loop/provider.py` 和 `loop/rounds.py`；验收：预算、取消、provider error、usage、90% 压缩、overflow fallback、绝对轮次上限行为与基线一致。
- [ ] `LLM25-007` 收口 Context 调用边界；验收：core/loop 不复制压缩、预算、canonical serialization 或消息替换实现，现有 context、cache prefix 和 reasoning state 测试通过。

### Phase 3：工具生命周期

- [ ] `LLM25-008` 抽取 `loop/tools.py`；验收：工具名归一化、Adapter、Schema/权限 dispatch、结果写回、artifact、重复调用熔断和 verify 信号统一通过新入口。
- [ ] `LLM25-009` 验证 canonical tool batch；验收：Anthropic/OpenAI 两套 projection、连续 user 消息、tool call/result 顺序、Skill schema/discovery event 和跨轮 history 恢复测试通过。

### Phase 4：交互恢复

- [ ] `LLM25-010` 抽取 `loop/interactions.py`；验收：confirm、ask_user、MCP 凭据、工具额度、取消、过期、拒绝、确认后 replay 和两阶段 interaction 均通过回归测试。
- [ ] `LLM25-011` 完成无限循环安全回归；验收：确认后产生新的 `ask_user` 时最多按用户交互继续，不重复提交相同 waiting result；无限模式仍受重复工具熔断和绝对轮次上限保护。

### Phase 5：回复守卫与 core 收缩

- [ ] `LLM25-012` 抽取 `loop/guards.py`；验收：空回复、叙事、意图、冒号、工具必调、决策回避、goal 和 verify 收尾与基线一致，内部提示和完成标记不泄漏。
- [ ] `LLM25-013` 将 `core.py` 收缩为兼容入口和高层状态机；验收：`core.py` 控制在 500～700 行范围，`_run_loop` 不再直接实现 provider、工具 dispatch、交互等待、SSE 编码和 Context 细节。

### Phase 6：清理与验收

- [ ] `LLM25-014` 清理旧实现和临时兼容层；验收：全仓库无旧实现的死代码、反向 import、重复工具/交互/事件实现；兼容导出只保留有实际外部调用的符号。
- [ ] `LLM25-015` 完成全量验证和文档收口；验收：后端测试、compileall、ownership、confirm gate、LoopScope 关键测试全部通过，更新本 PRD 实际状态和相关 Agent 架构文档。
