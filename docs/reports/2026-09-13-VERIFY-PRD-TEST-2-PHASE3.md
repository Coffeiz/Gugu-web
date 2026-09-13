# PRD-TEST-2 Phase 3 趋势与周期复核

> 日期：2026-09-13  
> 基线提交：`0bdc6f877`（测试期间工作区有未提交修改）  
> 状态：完成；周期检查仍为手动、非阻断，不接入自动 CI。

## 范围与复跑

- CRAP 使用 `scripts/quality/crap_scope.json` 的 2 个显式源码/测试配对；对最终范围连续复跑两次。范围：上下文预算 `budget.py` 及其两个 pytest 文件、前端 `optimisticMutation.ts` 及其 Vitest 文件。
- 变异测试使用 `scripts/quality/mutation_scope.json` 的 7 个 Python helper 和 1 个 TypeScript 模块。与 Phase 2 基线比较同一目标、同一工具版本和同一工作区提交；逐 mutant ID 对照，目标数及状态均未改变。
- 两次 CRAP 最终范围报告的函数键集合和 CC、覆盖率、CRAP、风险等级逐项相同。无执行或分析错误。

## 趋势结果

| 检查 | 基线/复跑 | 本次复跑 | 对比结果 |
|---|---:|---:|---|
| CRAP 函数数 / 高风险数 | 26 / 2 | 26 / 2 | 不变 |
| CRAP 平均 CC / 平均覆盖率 / 平均 CRAP | 4.731 / 76.4% / 18.335 | 4.731 / 76.4% / 18.335 | 26 个函数的指标逐项一致 |
| CRAP 总耗时 | 4.768 秒 | 4.201 秒 | −0.567 秒；两个语言测试与分析均通过 |
| Python 变异 | 60/60 killed；100%；0 个异常状态 | 60/60 killed；100%；0 个异常状态 | 60 个 ID/状态完全一致 |
| Python 变异耗时 | 29.207 秒 | 39.829 秒 | +10.622 秒；仍低于 10 分钟预算 |
| TypeScript 变异 | 29/29 可执行项 killed；1 compile error；100% | 29/29 可执行项 killed；1 compile error；100% | 30 个 ID/状态完全一致；编译错误不计入分母 |
| TypeScript 变异耗时 | 28.768 秒 | 43.067 秒 | +14.299 秒；仍低于 10 分钟预算 |
| 失败/超时/未检查 | 0 | 0 | 未见质量状态回退 |

Phase 0–1 的历史 CRAP 报告包含 25 个函数，和本报告的 26 个不是同代码重复运行：Phase 2 将上下文工具结果分组抽为 `_consecutive_tool_result_indices`，使 `_units` 的 CC 从 5 降到 4；`atomic_message_units` 也从未覆盖变成全覆盖。当前两次 CRAP 复跑已使用相同最终源码与测试，结果逐项稳定。

变异耗时相对 Phase 2 基线增加，但所有变异 ID、状态和分数完全一致，且单语言低于时间预算。该差值仅记录为耗时波动，不能据此判断性能回归；如果后续连续多个季度超过预算，再检查主机负载、依赖版本和 scope。

报告链接：

- [CRAP 复跑 1（JSON）](./phase3-rerun/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.json) · [Markdown](./phase3-rerun/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.md)
- [CRAP 复跑 2（JSON）](./phase3-rerun-2/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.json) · [Markdown](./phase3-rerun-2/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.md)
- [变异复跑（JSON）](./phase3-rerun/2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.json) · [Markdown](./phase3-rerun/2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.md)
- [Phase 2 变异基线（JSON）](./2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.json) · [Markdown](./2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.md)

## 周期复核清单

- 负责人：仓库维护者负责运行、归档和趋势更新；对应模块责任人复核所属热点、存活变异及安全/状态边界。
- 周期：每季度手动运行一次；触及登记范围的重大重构或发布前额外运行。
- 时间预算：CRAP ≤5 分钟；Mutmut、Stryker 各 ≤10 分钟。超过预算先诊断环境、工具和 scope，不接入 CI，也不放宽错误统计。
- CRAP 复核：检查高风险函数、函数级测试映射及覆盖率变化。CRAP 只用于人工排序，不设全局通过阈值。
- 变异复核：survived 必须补测试、修复实现或提供等价行为证据；timeout、compile/runtime error、no coverage、not checked 分别调查，不计为 killed。等价项须经维护者复核。
- 报告留存：`docs/reports/` 中脱敏 JSON/Markdown 和趋势摘要作为版本化审计记录长期保留；每季度检查临时产物，只清理确认可再生的缓存，不自动删除历史报告。
- CI 边界：CRAP/变异命令仅由维护者手动执行，不由 push、PR、发布 workflow 或定时任务调用；普通 pytest/Vitest 自动 CI 保持原样。

## 本次验证

- CRAP 连续两次通过；26 个函数、2 个高风险项，逐函数指标一致。
- Mutmut：60/60 killed，0 survived/timeout/error/no coverage/equivalent/not checked。
- Stryker：29/29 可执行项 killed；1 个无效语法 compile error 单列；0 survived/timeout/runtime error/no coverage/equivalent/not checked。
- 质量报告脚本回归测试通过；未在 workflow 中发现 CRAP/变异测试调用。
