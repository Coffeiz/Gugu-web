# PRD-TEST-2 Phase 3：趋势复跑与周期复核

## 目标

完成 Phase 3 的同范围趋势复核、人工复核责任/节奏/预算/留存策略，并将结果同步到 PRD、测试约定和质量脚本说明。CRAP 与变异测试明确保持手动、非阻断，不进入自动 CI。

## 结果

- 对最终 CRAP scope 连续运行两次：同为 26 个函数、2 个高风险；每个函数的 CC、覆盖率、CRAP 和风险等级一致。报告耗时分别为 4.768 秒和 4.201 秒。
- 对 Phase 2 变异范围复跑：Python 60/60 killed；TypeScript 29/29 可执行变异 killed，另有 1 个 compile error 单列。所有 mutant ID 和状态均与 Phase 2 基线一致，没有存活、超时、运行错误、无覆盖或未检查项。
- 确认 Phase 0–1 的 25 函数 CRAP 报告早于 Phase 2 helper 抽取；新增 `_consecutive_tool_result_indices`，`_units` CC 从 5 降为 4，`atomic_message_units` 覆盖从 0 升为 1。没有把这项源代码变化误记为重复运行波动。
- 定下季度手动复核；重大重构/发布前加跑。维护者统筹、模块责任人审查。CRAP 目标 ≤5 分钟，单语言变异测试 ≤10 分钟。历史报告长期保留，季度检查并清理可再生临时缓存。
- 为保留同日基线，变异报告入口新增 `--report-dir`，并限制写入 `docs/reports/`；新增路径安全测试。

## 验证

- `scripts/quality/test_crap_report.py` 与 `scripts/quality/test_mutation_report.py`：33 passed。
- 同范围 CRAP 两次均通过；Mutation Python、TypeScript 均通过，异常状态按类别单独记账。
- 复跑报告和对比见 [`Phase 3 趋势报告`](../reports/2026-09-13-VERIFY-PRD-TEST-2-PHASE3.md)。
