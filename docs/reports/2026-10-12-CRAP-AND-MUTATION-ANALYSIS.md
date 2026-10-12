# 全量 CRAP 与变异测试分析报告

> 日期：2026-10-12
> 代码基线：`3c7bae9078e242bc59ba0c218fd92fa323c453df`
> 运行环境：本地测试环境，低调度优先级；Vitest 复核限制为最多 2 个 worker，Python 变异复核限制为 1 个子进程。
> 工作树：测试期间存在本任务范围外的未提交修改；这些改动未由本任务触碰。报告记录的是运行时工作树结果，不代表干净提交快照。

## 结论

本轮扫描已覆盖 `backend/agent`、`backend/app` 与 `frontend/src`，识别 4,583 个函数，其中 CRAP 高风险 467 个、中风险 372 个、低风险 3,744 个。后端完整 pytest 通过；前端全套 Vitest 有 2 项失败（753 项中 751 项通过），因此全量 CRAP 报告状态为失败，不能把该结果视作前端覆盖率基线已验证通过。

变异测试只按仓库登记的 Phase 2 目标执行：Python 7 个目标因 mutmut 沙箱测试收集错误而未能生成变异；TypeScript 对 `optimisticMutation.ts` 生成 30 个变异，其中 29 个有效变异全部被测试杀死，另 1 个在 TypeScript 编译阶段被拦截。TypeScript 有效变异分数为 100%（29/29），但这只代表单一目标模块，不代表整个前端。

**总体判断：** 已得到有用的风险排序和一个明确的前端测试失败信号，但本轮并非全绿；Python 变异结果为空，前端 coverage 扫描还受 `.DS_Store` 噪声影响。先修复测试/工具链问题，再把重点放在高 CRAP 的关键业务函数及其行为测试。

### 后续复核更新（2026-10-12）

按后续要求，先清理了 devserver 上确认无用的进程，再修复测试失败项并完成隔离变异测试：

- 仅终止 4 个已运行数日、无活跃连接的孤立 Vite preview 进程组；应用、Loopscope、容器服务和 Mutagen 均保留。清理后可用内存从约 2.6 GiB 升至约 3.3 GiB，swap 使用量从约 3.7 GiB 降至约 3.0 GiB。临时隔离副本随后已删除，回收约 376 MB。
- 两个前端失败项确认为过时测试契约：FolderCard 断言改为验证当前动态 accent token；主题测试改为验证品牌色 token 与 mask 的契约。相关两个测试文件 71/71 通过，完整 Vitest 在最多 2 个 worker 下 753/753 通过。
- 修正了 mutmut 的测试选择和副本目录复制配置，并更新 Stryker 测试路径。随后在 devserver 的隔离临时副本执行变异：Python 60/60 被杀死；TypeScript 29/29 个有效变异被杀死，另 1 个编译错误变异由 TypeScript 检查器拦截。两个目标范围的有效 mutation score 均为 100%。
- 变异期间固定单 CPU，使用低调度与最低 I/O 优先级；Python、TypeScript 工具并发分别限制为 2、2。整轮约 4 分钟，未在 Mutagen 实时同步目录中改写源文件，结束后没有残留测试/变异进程。
- **CRAP 未在修复测试契约后重跑。** 初始 CRAP 原始报告仍如实保留当时 Vitest 失败状态；全套 Vitest 已经复核通过，但不能据此推断新的 coverage/CRAP 数值。

详细复测数据见 [`2026-10-12-DEVSERVER-MUTATION-PHASE2.md`](2026-10-12-DEVSERVER-MUTATION-PHASE2.md)。devserver 的 Git 元数据不作为基线依据；结果对应 Mutagen 同步后的文件快照。

## 执行范围与资源控制

| 项目 | 执行方式 | 结果 | 耗时 |
|---|---|---|---:|
| Python 全量 CRAP | pytest 全套，覆盖率作用于 `agent` 与 `app` | 通过 | 313.9 秒 |
| TypeScript 全量 CRAP | Vitest 全套，coverage include 为 `src/**` | 失败：2 项测试失败、751 项通过 | 33.9 秒 |
| Python 变异 | scope 登记的 7 个精确目标，mutmut 配置最多 2 个子进程；失败后以 1 个子进程复核 | 失败于变异测试收集阶段，0 个 mutant | 首轮 25.3 秒；复核约 30 秒 |
| TypeScript 变异 | `frontend/src/utils/optimisticMutation.ts` 及对应单元测试 | 29/29 有效 mutant 被杀死，1 个编译错误 mutant | 8.3 秒 |

CRAP 主扫描曾使用 Vitest 默认 worker 数。发现 CPU 使用偏高后，将测试进程树调至最低 nice 优先级；随后使用 `--maxWorkers=2` 低并发复跑以复核前端失败，约 60 秒。Python 变异问题复核使用 1 个 worker。未在 devserver 的 Mutagen 同步目录执行变异：检查时 devserver swap 几乎耗尽，且变异器会改写源文件，直接运行有资源压力与同步污染风险。后续如需在 devserver 复跑，应先安排低负载窗口，并在与 Mutagen 同步树隔离的临时副本内执行。

## CRAP 指标

| 指标 | 数值 |
|---|---:|
| 函数总数 | 4,583 |
| 高风险（CRAP ≥ 30） | 467（10.2%） |
| 中风险（15 ≤ CRAP < 30） | 372（8.1%） |
| 低风险（CRAP < 15） | 3,744（81.7%） |

全量最高 CRAP 项如下。它们是按风险值排序的排查入口，不等于每一项都必须立即重构；先确认是否是实际业务路径、是否存在等价/生成代码，再结合调用频率和故障影响决定优先级。

| CRAP | CC | 覆盖 | 函数 | 文件位置 |
|---:|---:|---:|---|---|
| 13,572 | 116 | 0.0% | `_generate_unlocked` | `backend/agent/gateway/web.py:625` |
| 5,060.7 | 304 | 62.8% | `run_loop` | `backend/agent/loop/machine.py:98` |
| 3,782 | 61 | 0.0% | `stream` | `backend/agent/gateway/web.py:57` |
| 3,656.3 | 125 | 39.1% | `dispatch_im_message` | `backend/agent/im/loop.py:740` |
| 2,756 | 52 | 0.0% | `_extract_xlsx_preview_sync` | `backend/app/services/files/previews.py:131` |
| 2,450 | 49 | 0.0% | `terminal_websocket` | `backend/app/api/v1/terminals.py:213` |
| 2,162 | 46 | 0.0% | `_execute_job_locked` | `backend/agent/memory/im_reflection.py:406` |
| 1,560 | 39 | 0.0% | `summary` | `backend/app/core/opsmetrics.py:157` |
| 1,406 | 37 | 0.0% | `test_search` | `backend/app/api/v1/config.py:772` |
| 992 | 31 | 0.0% | `reconcile` | `backend/app/scheduled_tasks.py:196` |
| 930 | 30 | 0.0% | `_apply_output` | `backend/agent/memory/im_reflection.py:868` |
| 887.2 | 68 | 43.8% | `batch_canvas_operations` | `backend/app/services/canvas/batch.py:72` |
| 782.7 | 37 | 18.3% | `build_source_records` | `backend/agent/rag/index_builder.py:229` |
| 702 | 26 | 0.0% | `update_config` | `backend/app/api/v1/config.py:128` |
| 650 | 25 | 0.0% | `search_persistent_index` | `backend/agent/rag/persistent_store.py:269` |

CRAP 高值同时受复杂度与覆盖率影响。比如 `run_loop` 的 CC 为 304，即便有 62.8% 覆盖仍显著偏高，适合先拆分状态步骤并为边界状态补测试；`_generate_unlocked` 和 `stream` 的 0% 覆盖需要先确认覆盖率是否正确映射到异步/生成入口，再补可观察行为测试。不要仅为降低数字机械拆函数。

## 前端全量测试失败（初始运行）

低并发复核得到 **2 个失败、69 个通过**（仅运行失败所在的两个测试文件）；全套扫描报告为 **2 个失败、751 个通过**。失败均为 CSS 回归契约与当前实现不一致：

1. `tests/design/styles/file-browser-visual-regression.test.ts` 的 FolderCard 用例仍断言旧的固定 accent border 表达式；组件现在使用 `--folder-card-border-accent` 与共享 `--folder-card-border-base` 组合。
2. `tests/design/styles/theme-regression.test.ts` 仍要求各 palette 声明 `--theme-brand-logo-filter`，当前 palette CSS 未提供该 token。

后续对照当前实现后确认两项均为测试契约过时，已更新测试并复核通过（见“后续复核更新”）。全量覆盖率 remap 还遇到 `frontend/src` 下 6 个、`backend/agent`/`backend/app` 下 3 个 `.DS_Store` 文件的二进制解析噪声。它们未被删除。建议把扫描范围改为基于受版本控制的源码文件清单，或显式排除 macOS 元数据文件。

## 变异测试结果与根因（初始运行）

### TypeScript

- 目标：`optimisticMutation.ts` 的提交、回滚与更新意图结算时序。
- 30 个候选中 29 个进入行为判定且全部被测试杀死；1 个变异使 TypeScript 产生 TS1313 编译错误，被编译器拦截，不计入有效分母。
- 当前目标测试对变异的敏感度良好。下一步可在相邻关键状态补充行为测试后扩展范围，避免从单目标 100% 推断整个前端质量。

### Python

- 7 个 scope 目标未开始变异，mutmut 在创建隔离测试副本后收集 `tests/test_context_budget.py` 失败：旧副本测试导入 `agent.context.assembly.PromptMessages`，但当前 `agent.context.assembly` 不导出该名称。
- 全量 pytest 已通过，说明问题集中在 mutmut 的 `also_copy`/测试选择配置仍复制旧测试文件，而不是本轮全套 Python 测试失败。
- 由于目标没有生成 mutant，初始 Python mutation score 不可用；不能把报告中的 0% 当作测试质量分数。后续已修复 harness，并在隔离 devserver 副本完成 60 个 Python mutant 的复测，结果见“后续复核更新”。
- 初始复核将 mutmut 子进程降至 1，确认错误仍可复现；随后修正了选择路径与副本目录配置。

## 优化方案

### P0：恢复报告可信度

1. 更新 Python mutation harness：让 `pyproject.toml` 的 `also_copy` 和 test-selection 指向当前真实测试目录/模块，移除过时副本；先以单个目标验证 mutmut 能完成生成、执行与结果解析，再运行登记的全部 7 个目标。
2. 明确两项前端 CSS 契约的真实期望：依据设计 token 源确认 folder border 的新动态 accent 是否正确，以及 logo filter 是否应该继续存在；选择修复实现或更新测试后，低并发重跑两个失败文件与全套 Vitest。
3. 调整 coverage include/exclude，排除 `.DS_Store` 等非源码文件；优先从 Git 跟踪文件枚举源，而不是宽泛 glob。

### P1：按 CRAP 与风险影响补行为测试

1. 从最高 CRAP 且有用户可观察影响的入口开始：Web 流式生成/续接、Agent 主循环、IM 消息派发、文件预览、终端 WebSocket、画布批量操作、文件同步对账。
2. 每个入口先拆清责任边界，再为状态转换、取消/失败、边界输入、重试与幂等编写行为测试；测试应能在错误实现下失败，避免只做源码结构断言。
3. 重点治理 CC 特别高的函数（如 `run_loop` CC 304、`dispatch_im_message` CC 125、`batch_canvas_operations` CC 68）：抽取可独立验证的决策步骤，但保持对外契约与事务/所有权边界。

### P2：扩大变异覆盖并纳入周期回归

1. Python harness 修复后，先按目标逐个运行，区分 killed、survived、timeout、compile/error、equivalent；对存活变异补充能表达业务不变量的测试，不为提高分数而盲目改实现。
2. 逐步扩展 mutation scope 到高风险领域，优先文件归属/删除、消息确认与队列、文件覆盖、同步对账和终端结束通知；维持明确白名单，不做无边界全仓库变异。
3. 将完整 CRAP 与变异测试保留为手动周期任务，不加入每次 CI；在资源有限的机器上使用低优先级、固定 worker 数和隔离临时目录，并记录运行时长与峰值资源，先跑核心目标，空闲窗口再扩大范围。

## 边界与可复现报告

- CRAP 原始报告：[`2026-10-12-VERIFY-PRD-TEST-2-CRAP-FULL.md`](2026-10-12-VERIFY-PRD-TEST-2-CRAP-FULL.md) 与同名 JSON。
- 变异原始报告：[`2026-10-12-VERIFY-PRD-TEST-2-MUTATION-PHASE2.md`](2026-10-12-VERIFY-PRD-TEST-2-MUTATION-PHASE2.md) 与同名 JSON。
- 本轮没有改业务逻辑；更新了两项前端回归测试、Python mutmut 配置和 Stryker 测试路径。没有触发 CI，也没有提交或推送。变异仅运行在隔离临时副本，未在实时同步树中执行；其他既存工作区修改保持原样。
- CRAP 的风险是静态排序指标；覆盖率不代表断言质量。变异分数只对实际成功执行的目标有效。所有报告都应结合测试失败、调用路径和安全/数据边界人工审查。
