# Agent Loop 主循环后续拆分方案

> 类型：架构调查与拆分实施跟踪；调查基线为 2026-10-12，实施状态以当前源码与测试为准。
> 调查基线：2026-10-12 工作区源码；本文是已完成 PRD-LLM-25 的后续建议，不重开或覆盖其历史实施记录。

## 1. 结论

`backend/agent/loop/machine.py` 值得继续拆分，但不能只按行数切文件或把文件整体改名。

初次调查时（2026-10-12），`machine.py` 在 HEAD 为 1624 行；当时工作区文件为 1270 行，`run_loop()` 本体为 1171 行、圈复杂度约 710。Ripwire 热点分数 6534（9 次变更 × ccx 726）也是当时工作区快照，不应与 HEAD 基线混为一谈。实施中的当前规模会持续变化，行数只作历史背景，不作为验收指标。

建议目标是让一个薄的 `loop/runner.py` 负责顺序编排，由少数有明确输入/输出的流程模块负责 round 执行、工具轮次、交互恢复和最终回复。拆分的主线应是**让共享运行状态有明确 owner，再迁移完整行为边界**，而非把现有代码原样分散到更多文件。

命名建议：第一阶段不重命名；主要职责迁出后，再将入口实现从 `machine.py` 改为 `loop/runner.py`。`backend/agent/runner.py` 已是外层 Agent run 生命周期入口，两者路径层级不同但名称相同，文档和 import 必须始终使用完整模块路径。改名时暂留 `machine.py` 兼容转发，待引用清零再删除。

### 初次调查快照与当前实施进度

- 初次调查时 HEAD `machine.py` 为 1624 行、工作区为 1270 行；这些不是当前实施快照，且不作为验收指标。
- `EventSequencer`、`RunState`、`ContextRuntime`、`ProviderRoundRuntime` 和 `ParallelToolBatchRuntime` 已接入主循环；并行 runtime 的终态结果协议已闭合。
- `InteractionRuntime` 已接管工具返回后的等待、取消、确认 replay 与 MCP 凭据二阶段恢复。`ReplyRuntime` 已接管空回复及 narration、intent、colon、tool-required、decision guard 的跨轮状态与决策；仍需继续验证完成/取消出口和职责边界。
- 并行 runtime 会发出 `complete` emission，主循环也会消费它并回填 `dispatched` 与取消状态；完整源码及并行顺序/取消行为用例均确认结果协议已闭合。此前只查看了文件截断输出，已撤回“缺少 complete emission”的判断。
- 对当前并行路径相关用例定向验证：6 项通过；其中包含并行模型顺序、canonical tool history、取消保留已完成结果等行为。后续继续保留这些高层断言，不增加只检查 emission 名称的低信号测试。
- 工作区同时包含 MCP、前端、锁文件、测试、报告等其他修改。本计划的范围只涵盖 Agent Loop；执行时不得格式化、重排或清理这些无关文件。当前 characterization 测试也有工作区增量，先按实际代码确认现状，不用旧计划中的测试通过数量冒充当前基线。
- Ripwire 的 co-change 结果显示 `machine.py` 与 `rounds.py`、`tools.py`、`provider.py` 有反复共同变更，其中部分被静态索引视为隐藏耦合。阶段迁移必须显式保留这些策略/执行边界；Ripwire `impact` 未解析出动态导入调用方，因此调用方清单以 `core.py` 和 LoopScope 源码检索为准。

## 2. 当前代码职责与边界

### 2.1 主要实现

| 位置 | 当前职责 | 观察到的耦合 | 建议归属 |
|---|---|---|---|
| `loop/runner.py` 工具/诊断 helper | 工具批次低敏日志、工具图片能力判断、provider 诊断字段 | `_allow_tool_images`、`_log_tool_batch_observation` 旧路径仍有测试引用 | `machine.py` 显式兼容导出；完成引用迁移后再考虑删除 |
| `loop/runner.py` 初始化与状态 | `run_loop` 入口、模型与能力上下文准备、Run 初始化、任务/核验计数 | 主编排器仍较大；若干跨阶段状态仍为局部变量 | 继续明确阶段 owner，只迁移真实共享状态到 `RunState` |
| `loop/runner.py` round/context 编排 | 轮次计数、SSE 序号、usage 记账、90% 阈值、provider 调用和错误恢复 | `EventSequencer`、`ContextRuntime`、`ProviderRoundRuntime` 已接入；主循环保留部分 outcome/usage 决策 | 保持现有 context/provider API，继续缩窄 runtime 输入输出 |
| `loop/runner.py` 工具轮 | 并行预检、串行 dispatch、工具状态事件、Skill digest、交互创建、canonical history | `ParallelToolBatchRuntime`、`SerialToolBatchRuntime` 已接管 dispatch；runner 仍负责预检、canonical batch 原子提交和交互 runtime 调用 | 继续保持 registry/dispatch/confirmations 为权限事实来源；后续可评估预检与 canonical assembler 是否值得抽取 |
| `loop/runner.py` 回复收尾 | 核验回复、goal 续行、各类 guard、反思快照与成功收尾 | guard 状态和重试决策已进入 `reply_runtime.py`；verify/goal/反思/终态输出仍由 runner 编排 | 保持明确阶段 outcome，不重复文本规则；核验/goal/快照边界由集成测试保护 |
| `loop/runner.py` 交互恢复 | 工具后的等待、取消/过期、确认 replay、MCP 二阶段凭据与 tool result 替换 | `interaction_runtime.py` 已承接 pending 恢复；创建表单仍由 serial tool runtime 发起，服务端仍为事实来源 | 保持 canonical batch 提交与交互结果替换的原子性 |

区间是按当前源码结构估算的导航范围，不是未来文件行数要求；应以提取时实际控制流和数据依赖为准。

### 2.2 已有模块与尚未落地的抽象

- `provider.py` 已有 provider 请求重试及 usage 归一化；`rounds.py` 已有 compaction 阈值、轮次起点映射与 overflow 纯决策。
- `tools.py` 已有工具并行资格、验证策略、结果 helper 和 dispatch 上下文；`tool_scheduler.py` 承担并发调度。
- `interactions.py` 仍以纯答案分类、取消判断与收尾帧为主，不承载实际等待/恢复状态机；答案分类已在主循环两条恢复路径使用，但状态处理和 replay 仍在 `run_loop`。
- `events.py::EventSequencer` 已在生产主循环使用；`run_state.event_seq` 只是权威序号的镜像。兼容 SSE 仍有直接编码路径，不能将“事件序号已迁移”误认为所有事件生成已归一。
- `models.py::RunState` 已进入生产路径并被 context runtime 使用，但迁移不完整。`round_number/task_rounds/verify_rounds/tool_call_count/pending/run_context_usage/hard_budget_retries/round_start_indices/event_seq` 已读写；`absolute_rounds_used/total_usage_out/guard_retry_count` 在当前主循环未使用。总 usage、部分 retry/guard 计数仍是局部变量。先核对并清理类型与实际状态的差异，再扩展状态包。
- `ContextRuntime` 已承担压缩、确定性裁切、压缩进度和 reasoning boundary；`ProviderRoundRuntime` 已承担流式 round 关闭和 Responses 兼容回退。主循环仍负责 round outcome、重试计数、usage 汇总及错误/overflow 顺序。
- `ParallelToolBatchRuntime` 已由主循环实际调用，并在结束时 yield `complete`，携带有序 dispatch 结果和取消状态；调用方消费该 emission。该接口目前已闭合。
- `overflow_recovery_plan()` 仍主要是模块级策略/测试契约，主循环目前保留直接分支，不应在迁移时漏掉单次重试与计数回滚语义。

这些差距意味着后续工作是把既有设计接入主流程并补齐真实职责边界，不是再造 provider、事件、工具或权限框架。

## 3. 调用方、兼容性与风险

### 3.1 生产入口

- `core.py::LLMRunner._run_loop` 动态导入 `agent.loop.machine.run_loop`，并作为 LoopScope hook 的稳定包装点。LoopScope 在类方法层包装 `_run_loop` 并观察完成/取消/error；重命名内部实现不能改变方法名、签名和 hook 行为。
- `backend/agent/runner.py` 是外层 run 生命周期入口，调用 `LLMRunner.run()`；它不应承接或复制 provider round 状态机。
- `runtime/loopscope_trace/hooks.py` 包裹 `LLMRunner._run_loop`，并依赖其完成/取消/error 语义；不应绕过该入口直接调用新的内部阶段模块。

### 3.2 测试与兼容导入

当前 Python 测试直接依赖 `loop.machine` 的位置至少包括：

- `tests/agent/test_loop_driver_vision.py` 导入 `_allow_tool_images`。
- `tests/agent/test_parallel_tool_policy.py` 导入 `_log_tool_batch_observation`。
- `tests/agent/test_core_loop_characterization.py` 导入 `loop.machine` 并通过 `_core` seam 观察并行调度。
- `tests/agent/test_core_loop_characterization.py` 通过 `loop.machine._core` monkeypatch 并行调度、串行 dispatch 等兼容别名；它覆盖交互取消、确认 replay、MCP 二阶段凭据、工具批次、Responses 回退、任务 100 轮限制及收尾事件。
- 当前工作区另有针对交互终态的未提交测试；计划基线不是干净 HEAD，不能把当前测试数/通过数作为 HEAD 的已验证基线。

迁移不得仅靠 `from new_module import *` 维护私有符号，因为下划线名称不会自动进入通配导出。兼容层应显式列出已知旧路径符号；每阶段都搜索全仓引用，并检查 monkeypatch 是否仍作用于实际运行时查找的对象。

### 3.3 关键安全/行为不变量

1. provider canonical/tool history 中每个 tool call 与 result 配对且顺序稳定；交互期间只替换该调用结果，不重复或丢失批次。
2. 等待、回答、用户取消、渠道取消、过期、确认 replay 及 MCP 二阶段凭据都必须给展示时间线发出正确终态；展示事件不能泄露用户输入或凭据。
3. 工具可用范围、归属、确认授权仍以 registry、dispatch 和 confirmations 为事实来源；loop 新模块不得复制授权判定或绕过确认门。
4. ContextBudget、压缩、provider history、cache anchor、reasoning state 和 reflection snapshot 继续由现有 context API 管理；Loop 只控制触发与状态转移。
5. 四类 provider driver 的重试、错误脱敏、usage 计数、缓存输入口径、overflow 单次恢复和绝对轮次限制保持一致。
6. LoopScope、Web、IM、定时任务仍通过 `LLMRunner` 的稳定入口观察 run 生命周期；事件 `run_id`、`seq`、round 边界和收尾顺序不变。

## 4. 建议目标结构

```text
backend/agent/loop/
├── runner.py                 # 薄入口：阶段顺序、转移决策、取消/结束协调
├── models.py                 # 真实运行时使用的显式状态，不做无依据的大型状态包
├── events.py                 # EventSequencer 与事件编码/不泄露约束
├── provider.py               # 已有：底层 provider round/retry/usage helper
├── rounds.py                 # 已有：纯轮次/预算/overflow 策略
├── round_runtime.py          # 一次模型 round 的准备、调用、错误/overflow恢复编排
├── context_runtime.py        # Loop 触发 context compaction/fallback 的生命周期协调
├── tool_round.py             # 一轮工具调用：预检、dispatch、批次结果与历史配对
├── tool_scheduler.py         # 已有：并行执行调度
├── tools.py                  # 已有：工具资格、验证、dispatch helper
├── interaction_runtime.py    # 等待/取消/过期/replay/回答恢复状态转换
├── interactions.py           # 已有纯交互判定；需要时被 runtime 复用
├── reply_runtime.py           # 核验和最终回复/重试/成功收尾协调
├── guards.py                 # 已有纯守卫规则适配
└── watchdog.py               # 已有低敏诊断事件
```

这只是职责建议，不要求每个文件都新建。若提取后的职责小且只有一个调用方，可留在 `runner.py` 或并入现有模块。禁止将所有方法放入一个 `LoopMachine`/`LoopRuntime` 巨型类，也禁止为每个 if 分支创建文件。

建议阶段对象用显式、窄接口共享必要数据：可演进现有 `RunState` 和新增 `LoopContext`（若确实需要）。上下文只放跨阶段共享的依赖与状态；模型/驱动/消息区域使用明确类型，避免把几十个闭包变量重新包装成无类型的大字典。`RunState` 的字段应由当前运行过程真实读写，并对各字段指定唯一 owner。

依赖方向建议：

```text
LLMRunner._run_loop (稳定 hook/API)
             │
             ▼
       loop.runner
       ├── round_runtime ── provider.py / rounds.py / context API
       ├── tool_round ────── tools.py / tool_scheduler / registry / MessageArea
       ├── interaction_runtime ── interactions service / confirmations
       └── reply_runtime ─── guards / reflection snapshot API
```

内部 runtime 模块接收明确依赖或窄 context，不反向导入 `core.py` 读取别名。旧 monkeypatch seam 由稳定 wrapper 显式传入所需依赖，不能依赖循环中任意时刻读取 core 全局变量。

## 5. 分阶段实施

### Phase 0：基线与引用契约（已完成）

- 更新并冻结实际入口、事件序列和 `loop.machine` 的直接引用/monkeypatch 清单。
- 复核当前 parallel runtime 的 completion/result 协议和行为测试，再记录四 driver 行为和定向测试基线；基线必须说明 HEAD 与工作区改动的边界，不复用历史测试计数。
- 建立关键事件序列断言：provider round、工具运行/等待/终态、交互恢复、取消/error 和成功 done。
- 不修改 `LLMRunner._run_loop` 的公共 hook 形态，不触碰真实模型、运行配置或用户数据。

验收：能够从测试观察关键调用完成或终止；引用清单明确区分生产入口、私有测试导入和 monkeypatch seam。

### Phase 1：让状态和事件抽象成为唯一事实源（已完成）

- 扩展并采用 `RunState`，先迁移 round number、预算/usage、pending interaction、核验/重试及 compaction 状态中确有共享需要的字段；不做全量盲目字段搬家。
- 使用 `EventSequencer` 统一生成带 `run_id` 与递增 `seq` 的事件；保持事件协议字节/字段语义兼容。
- 明确每个字段谁创建、谁更新、哪些终态清理；优先清理重复的闭包状态。

验收：RunState/EventSequencer 是运行路径实际使用的实现；循环行为、事件序列和兼容 monkeypatch 测试不变。

### Phase 2：抽取 context/runtime 与 provider round 编排（已完成）

- 把 `compact_context_now`、确定性 fallback 与 usage/overflow 触发整合为 context runtime；纯触发策略留在 `rounds.py`，压缩算法仍只调用 `agent.context`。
- 把单轮 provider 准备/调用、Responses 能力回退、usage 记账和异常/overflow 的一次性重试提取为 round runtime。
- runner 只根据结构化 round outcome 决定继续、重试、交互暂停或回复收尾。

验收：90% 判定、cache read/write usage、取消期间压缩心跳、overflow 最多重试一次、reasoning boundary 和 Responses fallback 有运行时回归测试。

### Phase 3：抽取工具轮次协调（已完成）

- 将串行和并行工具调用共用生命周期收敛为工具轮次协调模块；先定义明确的终态 outcome（包含有序 dispatched 结果、取消状态和 artifacts），并确保 async-generator 消费端确实收到它；保持 `tool_scheduler.py` 只管并发调度，`tools.py` 只管资格/策略/dispatch helper。
- 明确预检、工具事件、dispatch 状态、取消部分结果、artifact、Skill 状态和 canonical tool batch 的责任边界。
- 交互工具返回时转交 interaction runtime，不在工具协调模块内重复实现等待/恢复。

验收：串行/并行、无效参数隔离、确认门、部分取消、artifact、工具结果顺序以及 canonical batch 原子性仍通过行为测试。

### Phase 4：抽取交互生命周期（已完成）

- 把普通 ask_user、MCP 凭据、确认/确认后 replay、取消、渠道中断、过期和 stale pending 统一成显式状态转移。
- 交互服务/确认门继续作为事实来源；runtime 只负责消费答案、替换 pending result、闭合 SSE 状态并决定恢复/结束。
- 以 `classify_interaction_answer()` 为统一判定入口，补充每种状态与原工具卡终态一一对应的模型/状态序列测试。

验收：所有正常、取消、过期和错误路径都不会留下等待态；tool call/result 配对保持完整；事件不包含 answer/secret。

### Phase 5：抽取回复与完成决策（已完成）

- 将核验轮、goal marker、空回复、narration/intent/colon/tool-required/decision guard 的“是否继续下一轮”决策与最终正文输出分开。
- `guards.py` 保持规则或纯状态决策，不复制 `security.core_guards` 的文本判定。
- reflection snapshot、usage 终态和 reasoning completed 在明确的成功/失败/取消出口收敛，但不得把失败也当成功捕获。

验收：各 guard 的触发上限、verify 缓冲/flush、goal 完成协议、空回复兜底、snapshot 成功边界和最终事件次序不变。

### Phase 6：入口命名与兼容清理（迁移完成，旧路径兼容保留）

- 实现已迁至 `loop/runner.py`；`core.py::LLMRunner._run_loop` 继续作为 LoopScope hook 点。
- `machine.py` 显式转发旧测试/诊断符号；全仓确认生产动态导入已改用新路径，少量测试仍依赖兼容路径，故本轮保留 shim。
- 后续如迁移所有旧路径测试导入，再单独移除兼容层；不影响当前运行入口。

验收：全仓 `loop.machine` 引用符合已批准的兼容清单；顶层 `agent.runner` 与内部 `agent.loop.runner` 的职责和文档命名没有歧义；稳定入口、LoopScope 生命周期和定向测试通过。

## 6. 测试与回归策略

每个阶段先运行最贴近改动的测试，再跑 loop 集成与模块测试；不以 source-string 断言代替运行时状态和事件行为。

- 主循环行为：`tests/agent/test_core_loop_characterization.py`。
- 模块规则：`tests/agent/test_agent_loop_modules.py`。
- 工具并发策略：`tests/agent/test_parallel_tool_policy.py` 及相关并发/取消用例。
- provider/tool 视觉能力：`tests/agent/test_loop_driver_vision.py`。
- LoopScope 生命周期与 usage：`tests/platform/observability/test_loopscope_usage.py` 及 trace hook 测试。
- 同步检查 Web/gateway、IM、定时任务、确认门、上下文压缩/cache/reasoning-state 测试；变更公共阶段接口时扩大到后端测试套件。

高价值状态序列至少包含：

```text
tool_call → waiting → answer → success → next round
tool_call → waiting → user cancel → cancelled → normal close
tool_call → waiting → expiry/error → terminal error
confirm → replay → second interaction → answer → terminal success
parallel batch → one result/cancel → remaining results settled → canonical history paired
provider overflow → summary compaction or deterministic fallback → one retry → terminal/next round
```

测试应验证可观察结果、状态和安全边界；实现方式重构不应因为函数改名或模块搬迁造成无关失败。真实 LLM A/B、devserver 配置和外部 CI 不属于模块迁移的默认验收步骤。

当前拆分验证记录：Agent Loop 定向回归 143 项通过；后端全量 pytest 4433 项通过、1 项既有 skip。第一次全量运行因临时目录写入 24 MiB fixture 时遇到空间不足而有 1 fail/3 setup errors；清理本次测试生成的精确临时目录后，文件同步相关 20 项通过，随后全量复跑完整通过。警告包含依赖弃用提示和一条 asyncio 资源警告；没有测试失败。测试临时文件已清理，未改用户运行配置。

## 7. 排序、提交粒度与退出条件

建议依次执行 Phase 0→1→2→3→4→5→6。Phase 1 建立可拆边界，Phase 2/3/4/5 各自可单独回滚；每阶段只提交其代码、对应行为测试和必要文档，不混入已有 MCP、UI、镜像或质量报告变更。

**完成条件：** `loop/runner.py` 是可读的阶段协调器而非第二个巨型函数；主流程模块有明确依赖和可观察输入/输出；状态/事件只有一个事实源；PRD 定义的安全与 provider/context 不变量有测试保护；旧路径兼容边界经过全仓审计。

不设置机械行数上限。若一个 runtime 文件仍需要共享十余个可变闭包变量，或跨模块必须传递大量不相关参数，应先改进状态/阶段接口，而不是继续切文件。

## 8. 现有 PRD 文档关系

PRD-LLM-25 已标为完成，但当前文档内“实际状态”仍有待评估项，引用的 `_run_loop` 行数、目标行数与当前代码不完全一致；`machine.py` 的 HEAD 为 1624 行，调查工作区因未提交抽取改动为 1270 行，二者不能混写为同一基线。`backend/agent/runner.py` 的历史行数也不是当前值。该 PRD保留为 2026-09 的历史实施基线。后续若批准本方案实施，应在实施前单独决定：是给 PRD 增加后续阶段/修订当前状态，还是保持其历史状态并以本文作为独立后续方案；不要把旧行数当成本次重构的验收指标。
