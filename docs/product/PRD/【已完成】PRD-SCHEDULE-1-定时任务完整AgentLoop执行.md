# PRD-SCHEDULE-1：定时任务完整 AgentLoop 执行

## 1. 背景

定时任务曾经被拆成 execution 与 report 两个阶段，并在创建/编辑任务时额外调用 LLM 选择工具组，再把 `context_config` 保存到任务中。实际运行中，这会产生多套提示词、两次模型调用和两套失败/重试语义：

- 工具调用成功后，独立 report 阶段可能再次失败；
- 试运行和正式运行的路径不完全一致；
- 工具分类选错时，任务运行时缺少真正需要的工具或上下文；
- 写操作已经产生副作用后，阶段级重试容易重复执行；
- 前端创建任务、Agent 创建任务和后台分类各自维护一部分规则，职责分散。

定时任务本质上仍是一条 Agent 请求。execution 复用完整 AgentLoop，负责真实执行；report 再以 execution 的完整输出为上下文，只做无工具的结果整理，避免把工具过程和不必要的中间输出直接投递给用户。

## 2. 目标

- 定时任务的 execution 每次只进入一套完整 AgentLoop。
- 工具调用、工具复查和执行结论由 execution 负责。
- report 只根据 execution 完整输出整理最终投递正文，不调用工具。
- 创建/编辑任务不再提供或自动生成工具选择配置。
- 不再依据任务内容裁剪工具集或业务上下文；每次使用完整 AgentLoop 所需的工具和上下文。
- 试运行与正式任务使用同一条 execution/report 执行路径。
- 任务级重试放在 AgentLoop 外层，整轮最多重试一次。
- 已产生写副作用时不得盲目重放整轮。
- 普通 Web/IM 对话继续使用现有 AgentLoop，不改变其会话与权限语义。

## 3. 非目标

- 不改变普通 Web/IM 对话的 AgentLoop、工具权限、确认门和复查规则。
- 不把定时任务写入普通 `ConversationSession`。
- 不新增任务执行结果持久化表。
- 不在本次工作中实现按任务动态选择模型、工具或上下文的优化。
- 不改变渠道投递目标规则：网页、QQ、飞书、微信和当前群/私聊目标仍按现有配置解析。

## 4. 目标架构

```text
APScheduler / 手动试运行
          ↓
   scheduled_tasks.execute_task
          ↓
    任务级锁与重试
          ↓
   execution：runner.run_scheduled
          ↓
   完整 AgentLoop（一次）
   ├─ 构建完整系统提示词和业务上下文
   ├─ 提供完整默认工具集
   ├─ 工具调用
   ├─ 写操作后的查询复查
   ├─ 多轮工具循环
   └─ 生成完整 execution 输出
          ↓
   report：只读结果整理
   ├─ 接收 execution 完整输出
   ├─ 不提供工具
   ├─ 去掉过程噪音
   └─ 生成最终投递正文
          ↓
       渠道投递
```

### 4.1 各层职责

**调度器 / `app.scheduled_tasks`**

- 读取任务和投递目标；
- 控制同一任务的并发锁；
- 编排 execution、report、重试和渠道投递；
- 只在 execution 失败且允许重试时重新调用整轮；
- report 失败时只重试 report，不重跑 execution；
- 投递最终回答和文件产物；
- 记录结构化阶段状态。

**`agent.runner`**

- 为定时任务提供非流式 AgentLoop 入口；
- 使用 `DefaultProfile` 的完整工具集和完整业务上下文；
- 收集完整 execution 输出、工具调用、文件产物、是否产生副作用和错误状态；
- 提供只读 report 调用入口；
- 不负责调度、任务锁、重试和渠道投递；
- 不接收工具选择覆盖参数。

**`agent.core`**

- 保持通用工具循环、确认门、写操作复查和 execution 最终输出逻辑；
- 不负责 report 编排。

**scheduled report 模块/函数**

- 接收 execution 的完整输出、工具结果、文件产物和错误状态；
- 只生成最终投递正文；
- 不提供工具，不修改业务数据，不重新执行任务；
- 与 `runner.py` 分离，避免 runner 变成定时任务总控文件。

**API / 前端 / Agent 工具**

- 创建和编辑任务只维护名称、指令、时间、渠道、启用状态和投递模式；
- 不显示、不提交、不生成工具组或上下文选择字段；
- Agent 创建任务与网页创建任务使用相同的数据边界。

## 5. 统一执行流程

### 5.1 触发

1. APScheduler 或手动试运行取得任务快照。
2. 解析渠道和投递目标。
3. 获取任务级锁；已有同一任务运行时，跳过本次重复触发。
4. 调用完整 `run_scheduled()`。

### 5.2 Execution：完整 AgentLoop

一次调用必须完成：

1. 构建当前时间、用户资料、项目、日历、文件、记忆、IM 渠道等完整上下文；
2. 注入完整默认工具集，不依据任务正文做工具分类；
3. 让模型自行判断是否需要工具；
4. 执行工具调用和必要的写后复查；
5. 在同一个 loop 内生成完整执行输出；
6. 收集文本、工具结果、文件和结构化执行元数据；
7. 将完整 execution 输出传给 report。

### 5.3 Report：只读结果整理

report 是一次独立的无工具模型请求，只接收 execution 的完整输出，包括最终文本、工具结果、复查结论、文件产物和已知错误。

report 只能删除过程噪音、合并重复信息、保留成功/失败结果，并按咕咕的语气生成最终正文。report 不得调用工具、改变事实、声称未执行的操作已完成，或隐藏 execution 已明确报告的失败。

如果 execution 没有工具调用且最终文本已经适合直接展示，可以跳过 report，直接投递 execution 文本。

### 5.4 外层重试

- 正式任务和试运行都使用同一轮完整 execution + report；
- execution 默认最多执行 1 次，失败时允许外层再完整执行 1 次；
- 仅在没有产生副作用时自动重试；
- 已产生创建、修改、删除、移动、发送等副作用时，不得盲目重放整轮；
- report 失败只单独重试 report，不重跑 execution；
- 外层重试不进入 AgentLoop 内部，不改变工具循环的轮次和复查语义；
- 两次整轮都失败后，向渠道投递明确失败结果，不伪装成成功。

### 5.5 试运行

试运行只是“立即触发一次正式任务流程”，不是另一种 Agent 模式：

- 使用同一个 execution AgentLoop 和 report 入口；
- 使用同一套上下文、工具、确认和复查规则；
- 不等待下一次 cron，不依赖延迟重试；
- 若 execution 发生可安全重试的瞬时失败，最多允许一次外层重试；
- report 失败只重试 report，不重复执行工具；
- 返回各投递渠道的结果。

## 6. 取消工具选择功能

### 6.1 取消内容

以下能力全部取消：

- 前端创建/编辑任务时的工具选择 UI 或字段；
- Agent `create_scheduled_task` / `update_scheduled_task` 的 `context_config` 参数；
- 创建/编辑任务后后台调用 LLM 的 `classify_context_config()`；
- `context_config.tool_groups` 对工具集的裁剪；
- `context_config.projects/calendar/files/memory` 对上下文的裁剪；
- `runner` 的 `tool_names_override`、`minimal_context` 等报告阶段专用覆盖入口。

### 6.2 数据处理

- 新任务不再写入 `context_config`；
- API 不再返回该字段；
- 已有数据库列先保留但不再读取和写入，作为非破坏性过渡；
- 后续单独安排数据库清理迁移，不能在本次改动中删除生产列；
- 存量任务统一按完整 AgentLoop 执行。

### 6.3 保留的“渠道选择”

工具选择与投递渠道选择不是一回事。保留：

- `web`、`qq`、`feishu`、`wechat` 等投递渠道；
- QQ 群聊中“发当前群 / 私聊提醒我”的投递模式确认；
- 用户是否启用任务；
- 日历事件提醒与独立定时任务的边界。

## 7. 结果与错误语义

内部结果至少包含：

```python
ScheduledExecutionResult(
    text="完整执行输出",
    files=[],
    tool_names=[],
    mutated=False,
    verified=False,
    completed=True,
    error_code=None,
    retryable=False,
)

ScheduledReportResult(
    text="最终投递正文",
    completed=True,
    error_code=None,
    retryable=False,
)
```

结果只在本次调用内传递，不保存完整工具参数和原始消息正文。

错误分为：

- `agent_failed`：AgentLoop 未完成；
- `tool_failed`：工具或外部服务失败；
- `side_effect_completed`：已产生副作用，不允许盲目重试；
- `delivery_failed`：AgentLoop 成功但渠道投递失败；
- `concurrent_skipped`：同一任务已有运行实例。

投递失败不能反向重跑 AgentLoop；应记录渠道失败并按现有投递重试/补偿机制处理。

## 8. 可观测性与安全

结构化日志只记录：任务阶段、尝试次数、工具数量/名称、是否产生副作用、是否完成复查、耗时、错误分类和投递状态。

禁止记录：任务正文、工具参数、文件名、用户消息原文、完整上游响应和平台敏感标识。异常通过受限诊断出口记录，公开日志只保留脱敏错误类型。

## 9. 实施计划

### Phase 0：冻结行为基线

- [x] 确认普通 Web/IM AgentLoop 行为不变。
- [x] 确认定时任务不创建普通会话。
- [x] 记录当前渠道投递、文件产物、写后复查和任务锁行为。
- [x] 确认试运行与正式任务的输入和输出边界。

### Phase 1：取消工具选择（已完成）

- [x] 前端创建/编辑请求删除工具选择相关字段和逻辑。
- [x] Agent 创建/更新工具 schema 删除 `context_config`。
- [x] 删除前端创建/编辑后的后台 LLM 分类调用。
- [x] API 响应不再返回 `context_config`。
- [x] `ScheduledTask` 旧列暂保留但应用层不再读写。
- [x] 删除工具选择相关的测试和过期注释，补全量执行测试。

### Phase 2：收口完整 AgentLoop（已完成）

- [x] 将 execution 收口为一次完整 AgentLoop 调用。
- [x] 保留只读 report 入口，输入为 execution 的完整输出。
- [x] 删除 report 阶段调用工具或重新执行任务的旧路径。
- [x] 定时任务固定使用完整工具集和完整业务上下文。
- [x] 保留工具调用、写后复查、文件产物和 execution 输出收集能力。
- [x] 无工具且 execution 文本已适合展示时允许跳过 report。
- [x] `minimal_context` 与空工具列表仅作为内部 report 适配参数保留，不向用户配置面暴露。

### Phase 3：外层重试与并发边界（已完成）

- [x] 将 execution 重试放到 `app.scheduled_tasks` 调度编排层。
- [x] 整轮最多重试一次，避免内部多套重试叠加。
- [x] 无副作用失败可重试；有副作用失败禁止盲重放。
- [x] 试运行和正式任务复用同一 execution/report 函数。
- [x] report 失败最多单独重试一次，不重跑 execution。
- [x] 同一任务并发时保持跳过，不创建重复执行。
- [x] 渠道投递失败与 AgentLoop 失败分离处理。

### Phase 4：测试与清理（已完成）

- [x] 无工具任务只调用一次完整 AgentLoop，并可直接跳过 report。
- [x] 单个只读工具任务能在同一 loop 内完成工具调用，再由 report 整理最终正文。
- [x] 多工具任务不会在 report 阶段再次调用工具。
- [x] 写工具完成复查后不会重复执行。
- [x] 试运行和正式运行走同一 execution/report 入口。
- [x] 瞬时失败最多触发一次外层重试。
- [x] 有副作用失败不会自动重放。
- [x] 删除旧 execution/report 日志、兼容分支和无效分类测试。
- [x] 补充 API、Agent 工具和 runner 回归测试。
- [x] 在 devserver 执行后端回归测试、`git diff --check`，并验证 QQ/网页投递。

### Phase 5：数据库清理（已完成）

- [x] 确认线上代码已完全不读取 `context_config`。
- [x] 通过幂等、可回滚的 `20260805000004` 迁移删除 `context_config` 列。
- [x] 保留历史迁移文件作为迁移链记录，不再由运行时代码引用。

## 10. 验收标准

1. 创建和编辑定时任务时，前端没有工具选择项，也不会额外发起分类 LLM 请求。
2. Agent 创建/更新定时任务时，工具 schema 不再暴露工具选择字段。
3. 新旧任务都使用完整工具集和完整业务上下文执行。
4. 一次任务只进入一个完整 execution AgentLoop；report 只做无工具整理，不重新执行任务。
5. 多工具任务能在同一 execution loop 内完成所有必要调用，再由 report 输出最终正文。
6. 试运行和正式运行执行链路一致，试运行不依赖特殊 AgentLoop 参数。
7. 外层最多重试一整轮；已产生副作用时不会盲目重复执行。
8. 工具调用成功但渠道失败时，不会重新调用 AgentLoop。
9. QQ 群聊/私聊、网页和文件产物投递行为保持现有规则。
10. 日志可区分 AgentLoop、重试、复查和投递阶段，且不泄露正文、参数或敏感标识。
11. 现有定时任务不会因移除工具选择配置而失效。

## 11. 默认决策

- 完整 AgentLoop 优先于任务级工具裁剪。
- 调度器负责编排与投递，AgentLoop 负责理解、工具和最终回答。
- 工具选择不作为用户配置，也不由创建任务时的额外 LLM 分类决定。
- 重试只存在于 AgentLoop 外层，最多一次。
- 副作用优先级高于“重试成功率”，有副作用时宁可报告不完整，也不重复写操作。
- 历史 `context_config` 迁移仅作为迁移链记录保留，运行时不再依赖任务级工具裁剪。
