# PRD-LLM-31：单 Round 并行工具执行

> 状态：🚧 实施中（Phase 0–3 已完成，待 Phase 4 最终复审）
> 创建：2026-10-01
> 最近更新：2026-10-02
> 关联模块：backend/agent/loop/machine.py、backend/agent/loop/tools.py、backend/agent/tools/base.py、backend/agent/providers/
> 背景参考：docs/prds/PRD-LLM-29-统一Canonical消息区域与持久化增量.md、docs/prds/PRD-LLM-30-Provider思考深度与API格式能力配置.md

## 0. 代码调查结论

| 项目 | 当前实现 | 对并行的影响 |
|---|---|---|
| 单 Round 多工具调用 | machine.run_loop() 遍历 result.tool_calls，每个调用完成后才处理下一个 | 当前是串行执行 |
| 数据库事务 | 每次 registry.dispatch() 独立创建 AsyncSession；成功提交、错误回滚 | 工具间没有共享数据库 session；无需为并行另行拆分 |
| Agent 执行上下文 | dispatch_in_session() 通过 ContextVar 绑定对话 session、run id、工具快照和技能状态 | 此处 session 不是数据库 session；要验证 ContextVar 继承以及可变技能状态是否竞争 |
| 工具安全元数据 | Tool 有 mutates、mutates_for_input、destructive、确认门和复核策略 | mutates 不能单独证明调用可并行 |
| Provider 能力 | ProviderCapabilities.parallel_tools 存在，默认关闭，Qwen 显式关闭 | 它描述模型/API 是否能返回多个调用；当前执行器不据此调度 |
| 交互/确认 | ask_user、MCP 管理表单、破坏性工具可能等待用户；等待时 Provider adapter 只投影已配对调用 | 交互调用不应与同批其他调用并行启动 |
| Provider 历史 | 各 build_tool_round() 根据已执行调用构造历史；已有未处理调用裁剪和 id 配对测试 | 并发完成顺序不能改变模型声明顺序或留下悬空 tool call |

### 0.1 代码入口

- backend/agent/loop/machine.py：接收 Provider 的 result.tool_calls，发出 tool_call/tool_done 事件，调用 dispatch_in_session() 并汇总结果。
- backend/agent/loop/tools.py::dispatch_in_session：设置 Agent dispatch 上下文，再调用 registry。
- backend/agent/tools/base.py::SkillRegistry.dispatch：校验输入后为每个工具创建独立数据库会话和事务。
- backend/agent/providers/base.py::ProviderCapabilities.parallel_tools：Provider 能力描述，不是 handler 并发安全授权。

## 1. 背景与目标

### 1.1 背景

模型可以在一次响应中返回多个工具调用。当前 Agent Loop 接收整组调用，却逐个 await。若同 Round 有多个互不依赖的只读查询，总等待时间接近各调用耗时之和。

不能只按 mutates=False 推断安全。工具可能访问网络或共享状态、操作文件、发消息、改变缓存、暂停等待用户，或依赖另一个工具的结果。错误并发会改变现有副作用和交互语义。

数据库层已经为每次 registry dispatch 创建独立 AsyncSession 与事务。并行设计不需要额外拆分数据库 session；主要风险在 Agent 上下文中的可变状态、工具副作用、确认/交互生命周期以及 Provider 消息顺序。

### 1.2 目标

1. 在一个 Round 内有界并发执行明确声明为并发安全、彼此独立的工具调用。
2. 未声明安全的调用保持原有串行执行。
3. 保持调用顺序、tool id、SSE 终态、失败/取消语义及各 Provider 的调用/结果配对。
4. 保留全局回退到串行的快速开关。
5. 先验证并发收益与兼容性，再逐一启用合适工具。

### 1.3 非目标

- 不跨 Round 并行，也不并行多个 Agent Run。
- 不默认并发执行写操作、Shell/脚本、MCP、发消息或交互工具。
- 不改变模型协议、工具 schema、权限、确认门或数据库事务边界。
- 不把 Provider 的 parallel_tools 能力当成执行安全授权。
- 不自动识别工具之间的数据依赖；依赖前置结果的调用应放到后续 Round。

## 2. 术语

- Round：一次模型请求和响应。一次响应中的多个工具调用属于同一工具批次。
- Run：用户发起的一次完整 Agent 执行，可包含多个 Round。
- Provider 并行调用能力：模型/API 能否在一次响应中表达多个调用。
- 执行并行：服务端是否同时运行同一 Round 的多个 handler。
- 并发安全工具：显式声明可与同批其他安全调用同时执行，且不依赖执行顺序或彼此结果。

## 3. 功能需求

### FR-LLM31-01：显式并发安全声明

新增与 mutates 分离的工具元数据，例如 parallel_safe，缺省 false。只有经代码审查确认无副作用、无共享可变状态、无顺序依赖的工具可开启。

- mutates=False 不自动意味着 parallel_safe=True。
- destructive、需确认、可暂停交互、Shell/脚本、发消息、修改数据库/文件/外部服务的工具默认不可并行。
- call_tool 等通用委托不能只按外层属性判断；可信解析实际目标后检查目标声明。无法确认时按不可并行。
- 并发安全声明纳入测试或静态清单，避免新工具未经审核被调度。

### FR-LLM31-02：保守批次调度

默认仍为串行。启用并行后，仅当一整个 Round 的工具调用全部满足以下条件时，才进入有界并发调度：

1. 工具名和协议参数已解析，schema 输入归一化成功；
2. 所有目标工具显式声明 parallel_safe；
3. 不含 ask_user、MCP 管理交互、确认等待或其他暂停 Run 的路径；
4. 不含无法解析的委托或工具名；
5. 工具契约确认同批调用彼此独立。

任一条件不满足，整批按模型顺序串行执行。初期不拆分混合批次，避免悄悄改变工具顺序语义。

并发上限初始建议为每 Round 4 个。超过上限时按原始顺序分批执行。该上限集中定义，不暴露为普通用户选项。

### FR-LLM31-03：事件与结果顺序稳定

- 所有 tool_call running 事件按模型返回顺序发出。
- 并发任务可以任意顺序完成；dispatched、canonical history 和下一轮 Provider 输入仍按模型原始顺序排列。
- 每个 tool call 恰有一个终态结果；普通单调用失败不丢弃同批其他结果。
- Run 取消时取消尚未完成任务并等待清理；已完成结果遵循当前持久化/可观测策略。不可并行副作用工具不进入并行批次。
- 继续遵守 Provider 对 assistant tool call 与 tool result 的一一配对规则。

### FR-LLM31-04：失败隔离与上下文

每次工具继续使用当前独立 registry dispatch、数据库 session、事务提交/回滚、输入校验、权限与确认流程。

- 安全只读工具异常时，将脱敏错误作为该调用的结果，收集同批其余结果。
- Task cancellation 必须传播，不能被普通异常处理吞掉。
- 并发任务继承只读 dispatch 上下文；技能加载状态等可变对象不得在并发任务间共享写入。
- 可见日志仅记低敏度调度摘要，不记录正文、工具参数或原始异常。

### FR-LLM31-05：Provider 能力与执行策略解耦

- Provider.parallel_tools 表示模型/API 可否生成多调用；parallel_safe 表示 handler 可否并行，二者独立。
- Provider adapter 正确解析多个 tool id 后，服务端按工具安全声明决定执行方式。
- Provider 标记为不支持并行但实际返回多个调用时，不能丢调用；按工具安全策略处理，默认串行。
- 本 PRD 不向 Provider 请求添加 parallel_tool_calls 参数。若将来需要控制模型生成侧行为，另行验证各协议支持情况。

### FR-LLM31-06：快速回退

提供全局串行开关，默认关闭，可由部署环境设置初始值，并可在 Admin → Agent → 运行行为中持久化切换，便于调试和快速回退。关闭后使用当前串行执行路径，不改变工具输入、结果、事件顺序或历史投影。开关和观测日志不包含用户数据。

## 4. 安全与正确性边界

1. 并发声明是授权边界：不得根据名称、Provider 能力或 mutates=False 自动推断。
2. 同 Round 的调用必须独立；需要 A 结果的 B 留到下一 Round。
3. 每个工具独立事务，因此批次不是原子事务；并行读只看到数据库各自事务允许读取的已提交数据。
4. ContextVar 的执行上下文可以继承，但可变状态不能无锁共享写入。首批候选排除 use_skill 等会更新技能状态的路径。
5. 外部搜索、MCP、网络请求不纳入首批；扩展前评估限流、超时和取消。
6. 含交互调用的批次整体串行，避免等待用户时其他调用已执行，或历史中遗留未配对 call。

## 5. 建议实施阶段

### Phase 0：基线与调度契约

- 为多工具 Round 建立 characterization 测试：当前顺序、SSE 事件、确认中断、Provider 配对、取消与失败。
- 定义 parallel_safe 元数据和 call_tool 实际目标资格检查。
- 验证 ContextVar 在 asyncio task 间继承，以及 skill_state 是否只读。
- 验收：现有串行行为可由测试保护，并行资格可确定判定。

### Phase 1：有界执行器（已完成，2026-10-02）

- `AgentBehaviorSettings.parallel_tool_execution_enabled` 是全局并行开关，默认 `false`，可由环境变量 `AGENT__PARALLEL_TOOL_EXECUTION_ENABLED` 设置初始值，并可在 Admin → Agent → 运行行为中持久化切换，方便调试和快速回退。关闭时已审查的候选批次走串行路径；未审查、混合或含交互的批次无论开关状态都保持串行。
- 单 Round 固定最多并发 4 项，按输入顺序切块；任一批次不满足资格或输入 schema 预检失败，整批使用原串行路径。
- 全批 `tool_call/running` 先按模型顺序发出；并行任务完成后，结果事件、`dispatched`、canonical history 和 Provider round 均按原索引回填。
- 单项普通异常作为该项脱敏错误回执，不丢弃其他结果；任务取消时取消并等待未完成项，保留已完成项的真实回执，为未完成项写入取消回执并发 `cancelled` 终态，然后结束当前 Run，不继续请求 Provider。
- 验收：屏障测试确认真实重叠；逆序完成仍按模型顺序回填；启用开关的混合批次仍严格串行；单项失败隔离、部分完成取消、canonical 配对与取消后不续轮测试通过。

### Phase 2：按领域启用（已完成，2026-10-02）

- 对审查确认独立且无副作用的只读工具逐个设 parallel_safe=True。
- 为每类候选补 dispatch 集成测试，覆盖用户归属和结果；共享执行器测试覆盖失败隔离、取消清理及可观察错误不泄漏异常正文。
- 候选限于时钟和本地数据库读取，不触发外部 URL/文件后端；本阶段不增加并行专属单项超时策略，服务延迟风险在 Phase 3 观察。
- 验收：屏障/运行时测试确认候选工具真实重叠；用户归属、结果顺序、失败/取消和 tool id 配对无回归。实际服务耗时收益由 Phase 3 单独观测，不用合成耗时替代。

当前审查通过并已启用的范围：

- `get_current_time`：读取请求上下文时区和当前时钟，无共享写状态。
- `list_projects` / `get_project`：仅做按 user_id 过滤的项目查询；详情使用 ownership 查询。
- `list_events`：只读当前用户活动及提醒记录。
- `get_upcoming` / `get_dashboard_stats`：只读聚合查询，各 SQL 均显式限制当前 user_id。

暂不启用 `read_file`、`list_dir`、`global_search`、`note_search` 等涉及文件后端、URL、搜索/RAG 或更复杂关系查询的工具；后续须单独审查共享状态、耗时和取消行为。Phase 2 的本地行为测试证明白名单工具进入有界调度器、混合批次仍串行，且项目/活动/总览返回保持用户隔离；真实服务负载收益留给 Phase 3 观测，不以合成屏障测试冒充生产耗时结论。

### Phase 3：观测与评估

- 在 `agent.traj` 记录多工具批次的脱敏调度摘要：串行/并行、调用数、固定原因类别；并行批次另记录执行耗时、成功/失败/取消计数。不记录用户、run、工具名、参数、URL、正文或异常文本。
- 串行单项耗时继续使用现有工具轨迹；不能将 SSE 等待、用户交互等待算进 handler 耗时。
- 观察并行命中率、延迟、失败/取消及回退原因。限流只对实际执行的外部网络路径有意义；未启用的网络工具不得声称“没有限流”。
- 只有具备幂等、冲突检测和部分成功回执后，才单独评审并行写工具。
- 验收：形成脱敏观测结论，决定扩展、维持或关闭；缺少真实运行样本时维持当前白名单，不凭合成屏障测试扩大范围。

## 6. 测试与验收矩阵

| 场景 | 预期 |
|---|---|
| 两个并发安全独立工具 | 屏障测试确认真实重叠，不以不稳定耗时断言代替 |
| 任务逆序完成 | tool result、canonical history、Provider follow-up 保持模型顺序和 id |
| 一安全、一普通工具 | 整批串行，保持原顺序 |
| 多个 mutation/destructive 调用 | 串行，确认门语义不变 |
| 同批含 ask_user/管理表单 | 整批串行；等待期间无其他调用后台运行 |
| 一个安全只读调用异常 | 失败只影响该调用，其余结果完整 |
| Run 中途取消 | 取消未完成任务，不吞取消、不重复发终态 |
| 动态 call_tool | 根据实际目标资格判断；不明目标串行 |
| Provider 能力标记关闭但返回多 call | 不丢调用，默认串行 |
| 全局开关关闭 | 回到当前串行路径 |
| 所有调用 | 用户归属和跨用户隔离不变 |
| 日志 | 不含聊天正文、工具参数或秘密 |

完成标准：矩阵通过；现有 Anthropic/OpenAI/Ollama round-trip 和确认中断测试通过；后端全量测试、ownership/confirm gate、compileall 通过；有即时串行回退开关。

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 将 mutates=False 当作并行安全 | 网络或共享状态竞争 | 单独 parallel_safe 白名单，默认 false |
| 确认时已有同批调用启动 | 未授权副作用或悬空协议调用 | 含交互的整批串行 |
| 按完成顺序回填 | tool call/result 配对错误 | 按模型 call index 排序 |
| skill_state 在协程共享写入 | 技能状态竞态 | 初期排除 use_skill，并验证上下文只读性 |
| 同数据并发读写 | 冲突、死锁或读取时点不同 | 初期只读，写工具另行评审 |
| 突发请求触发限流 | 单 Round 失败/负载增加 | 并发上限 4，可快速切串行 |
| 漏掉未执行 call | Provider follow-up 无效 | 保留已执行 id 投影并覆盖各协议配对测试 |

**推荐决策**：先采用默认串行、显式只读并行白名单和固定上限；初期拒绝混合批次局部并行，不启用 mutation、MCP、Shell 或交互工具。Provider 声明和执行器安全策略保持独立。

## 8. 待评审问题

已确认的实施决策：

1. 每 Round 并发上限固定为 4，超出按原顺序分批；不暴露为用户选项。
2. 全局串行回退由默认关闭的配置控制，并在 Admin → Agent → 运行行为提供持久化调试开关。
3. 交互/确认/技能加载/外部 MCP 调用，以及无法解析或无法证明安全的整批均串行。
4. 并行批次先按模型顺序发出全部 running，再按模型顺序发终态；取消时取消并等待未完成任务，已完成调用保留其实际结果，已取消调用发取消终态，之后不再请求下一轮 Provider。
5. 首批安全工具名单留到 Phase 2，逐个审查 handler、副作用、共享状态和归属校验后再启用。

## 9. TODO

- [x] LLM31-001 状态：完成（2026-10-02）。固定上限 4、全局并行开关（Admin 可调试/回退）、交互批次串行和取消终态语义已记录。
- [x] LLM31-002 状态：完成（2026-10-02）。补充当前多工具串行/SSE 顺序基线；已有 Anthropic 未处理调用裁剪配对与 Loop 确认、取消特征测试继续覆盖对应行为。
- [x] LLM31-003 状态：完成（2026-10-02）。默认关闭的全局开关（Admin 可切换）、有界并发执行、schema 预检、混合批次串行、稳定顺序聚合和部分完成取消收尾已实现并测试。
- [x] LLM31-004 状态：完成（2026-10-02）。审查并启用 6 个时钟、项目、活动和总览只读工具；验证注册白名单、进入有界调度器、用户归属和混合批次串行。服务端实际耗时与限流观察留给 Phase 3。
- [x] LLM31-005 状态：完成（2026-10-02）。补充不含用户/工具输入数据的批次决策与并行结果摘要；串行耗时复用单工具轨迹。评估决定维持六个本地只读工具白名单：网页搜索与 HTTP GET 属外部网络请求，首批按安全边界保持串行；当前没有其并行执行的真实限流/取消观测，不能据此扩大范围。全量验证发现非本阶段故障，按任务约定记录并跳过，详见本阶段实施记录。

### Phase 0 实施记录

- `Tool.parallel_safe` 新增为独立元数据，缺省为 `false`，不由 `mutates=False` 推断。
- 批次资格判定先通过固定 Adapter 解析最终业务工具，再检查目标工具的显式声明；写入、确认、MCP、交互、技能加载、参数/目标不明或声明谓词异常均拒绝并行。
- ContextVar 子任务继承的是同一技能状态字典引用；并行 dispatch 必须使用按调用复制的状态，Phase 1 将接入复制 helper。
- 现有串行多工具 Round 的 dispatch 与 SSE 次序已补 characterization；确认取消和 Anthropic 未处理调用的配对已有独立测试覆盖。

### Phase 1 实施记录

- 新增独立并行调度器，最多 4 个 dispatch 同时运行；每组完成后才启动下一组，返回值保持原调用次序，普通单项异常隔离。
- 并行前对完整批次解析目标、归一化参数并执行与正式 dispatch 共用的 schema 校验；任一调用校验失败就回到串行入口，避免并行预检和真实执行采用不同参数契约。
- machine 先发出整批 `running`，收齐后按模型顺序发终态及写入 canonical/provider 工具往返。混合批次不拆分。
- 取消收尾携带已完成项结果；未完成项取消、等待子任务清理并写取消终态/回执；完整工具往返先提交到当前 `MessageArea`，再发 `_cancelled` 结束 Run。
- 定向测试覆盖屏障重叠、逆序完成顺序、混合批次串行、并发上限、单项失败隔离、取消清理和部分结果配对。

### Phase 2 实施记录（已完成，审查范围）

- 首批候选限定为 `get_current_time`、`list_projects`、`get_project`、`list_events`、`get_upcoming`、`get_dashboard_stats`；均显式设置 `parallel_safe=True`，且仍受 `mutates/destructive/confirmation` 二次拒绝检查。
- 逐项检查到的实现只有当前时区读取或当前用户范围内的 SELECT；没有外部 HTTP、文件操作、写事务、后台任务或跨调用共享可变状态。
- 既有项目/活动 handler 与服务层用例加上本阶段双用户回归验证列表、详情、活动、近期汇总和计数不跨用户；注册表测试保证其他工具（含文件读取与写工具）不会被误放入白名单。
- 实际部署的耗时、限流及异常率不在本地合成测试中推断，将由 Phase 3 观测决定是否扩大或回退。

### Phase 3 实施记录（已完成，审查范围）

- `agent.traj` 新增多工具批次摘要。串行记录仅含模式、调用数与固定回退原因；并行完成记录另含执行耗时和成功/失败/取消数，不记录用户标识、工具名、参数、URL、正文或异常文本。记录失败不会影响工具执行。
- 现有单工具轨迹已包含单项执行耗时，因此串行批次不增加涵盖 SSE/交互等待的误导性总耗时。
- 回归测试确认 `web_search`、`http_get` 未授权进入并行批次；两者继续保持串行。`http_get` 自身的 `urls` 批量输入可并发取数，是工具内部行为，与跨工具并行授权不同。
- 本地验证和合成测试只能证明调度契约与日志脱敏，不能代表真实服务时延或网络限流数据；因此评估结论为维持当前白名单，不启用外部网络、文件、MCP 或写工具。
- 验证：`tests/test_parallel_tool_policy.py` + `tests/test_core_loop_characterization.py` 为 79 passed；`compileall`、ownership、confirm-gate 和 diff check 通过。全量 pytest 为 3753 passed、13 failed。失败分布在 BYOK 草稿密钥复用（7）、IM 反思快照（3）、推理策略（1）、图片搜索测试导入（1）、目录路径夹具唯一约束（1）；故障点与本阶段变更文件无关。工作区另有未提交的 BYOK、IM/provider 等修改，因此不把失败归因于本阶段，也不擅自改动这些范围外内容。
