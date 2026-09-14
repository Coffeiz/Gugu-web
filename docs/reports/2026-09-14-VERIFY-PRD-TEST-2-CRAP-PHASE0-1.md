# VERIFY：PRD-TEST-2 Phase 0–1 CRAP 基线报告

> 报告日期：2026-09-14
> Commit：999bddb1da80baff2fbdfacc65b6aa3971667355（工作区修改：是）
> 状态：failed（非阻断；本次未运行变异测试）
> 耗时：21757 ms

---

## 范围与方法

只分析 scripts/quality/crap_scope.json 中显式列出的源码/测试配对。CRAP = CC² × (1 − Cov)³ + CC。风险标签只用于报告排序，不构成门禁。Python 覆盖率按 AST 函数体区间计算（排除 def 和参数签名行）；TypeScript 按复杂度工具给出的函数区间计算。

| 语言 | 源码 | 测试入口 | 领域 / 层级 | CI 状态 | 测试结果 | 耗时 |
|---|---|---|---|---|---|---|
| python | [backend/agent/context/budget.py](../../backend/agent/context/budget.py) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py), [backend/tests/test_session_history.py](../../backend/tests/test_session_history.py) | Agent 上下文预算 / L0 单元测试 | 普通 pytest 随 runtime-integration 自动执行；CRAP 报告与变异测试仅周期性手动运行，不由 CI 自动触发 | passed | 2187 ms |
| typescript | [frontend/src/utils/optimisticMutation.ts](../../frontend/src/utils/optimisticMutation.ts) | [frontend/test/optimisticMutation.test.ts](../../frontend/test/optimisticMutation.test.ts) | 文件库乐观更新时序 / L0 单元测试 | 普通 Vitest 随 runtime-integration 自动执行；CRAP 报告与变异测试仅周期性手动运行，不由 CI 自动触发 | failed | 19444 ms |

## CRAP 明细

| 风险 | CRAP | CC | Cov | 函数 | 源码位置 | 函数级测试关联 |
|---|---:|---:|---:|---|---|---|
| 中 | 18.0000 | 18 | 100.0% | enforce_provider_overflow_fallback | [backend/agent/context/budget.py:449](../../backend/agent/context/budget.py#L449) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 中 | 15.0000 | 15 | 100.0% | _select_kept_units | [backend/agent/context/budget.py:314](../../backend/agent/context/budget.py#L314) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 12.0000 | 3 | 0.0% | is_context_overflow_error | [backend/agent/context/budget.py:511](../../backend/agent/context/budget.py#L511) | 待人工关联 |
| 低 | 10.0000 | 10 | 100.0% | from_messages | [backend/agent/context/budget.py:44](../../backend/agent/context/budget.py#L44) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 10.0000 | 10 | 100.0% | from_parts | [backend/agent/context/budget.py:83](../../backend/agent/context/budget.py#L83) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py), [backend/tests/test_session_history.py](../../backend/tests/test_session_history.py) |
| 低 | 9.0000 | 9 | 100.0% | _recent_fallback_selection | [backend/agent/context/budget.py:293](../../backend/agent/context/budget.py#L293) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 9.0000 | 9 | 100.0% | truncate_messages | [backend/agent/context/budget.py:345](../../backend/agent/context/budget.py#L345) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 6.0000 | 2 | 0.0% | with_history | [backend/agent/context/budget.py:150](../../backend/agent/context/budget.py#L150) | 待人工关联 |
| 低 | 6.0000 | 6 | 100.0% | _truncate_value | [backend/agent/context/budget.py:272](../../backend/agent/context/budget.py#L272) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 5.9259 | 5 | 66.7% | _blocks | [backend/agent/context/budget.py:205](../../backend/agent/context/budget.py#L205) | 待人工关联 |
| 低 | 4.0000 | 4 | 100.0% | _units | [backend/agent/context/budget.py:235](../../backend/agent/context/budget.py#L235) | 待人工关联 |
| 低 | 4.0000 | 4 | 100.0% | _truncate_text | [backend/agent/context/budget.py:256](../../backend/agent/context/budget.py#L256) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 4.0000 | 4 | 100.0% | _fit_oversized_message | [backend/agent/context/budget.py:282](../../backend/agent/context/budget.py#L282) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 3.7085 | 3 | 57.1% | estimate_tool_schema_tokens | [backend/agent/context/budget.py:194](../../backend/agent/context/budget.py#L194) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 3.0988 | 3 | 77.8% | enforce_message_budget | [backend/agent/context/budget.py:420](../../backend/agent/context/budget.py#L420) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 3.0000 | 3 | 100.0% | _has_tool_call | [backend/agent/context/budget.py:214](../../backend/agent/context/budget.py#L214) | 待人工关联 |
| 低 | 3.0000 | 3 | 100.0% | _has_tool_result | [backend/agent/context/budget.py:220](../../backend/agent/context/budget.py#L220) | 待人工关联 |
| 低 | 3.0000 | 3 | 100.0% | _consecutive_tool_result_indices | [backend/agent/context/budget.py:226](../../backend/agent/context/budget.py#L226) | 待人工关联 |
| 低 | 2.0000 | 1 | 0.0% | hard_history_capacity_tokens | [backend/agent/context/budget.py:146](../../backend/agent/context/budget.py#L146) | 待人工关联 |
| 低 | 1.0000 | 1 | 100.0% | non_history_tokens | [backend/agent/context/budget.py:110](../../backend/agent/context/budget.py#L110) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 1.0000 | 1 | 100.0% | total_tokens | [backend/agent/context/budget.py:122](../../backend/agent/context/budget.py#L122) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 1.0000 | 1 | 100.0% | soft_limit_tokens | [backend/agent/context/budget.py:126](../../backend/agent/context/budget.py#L126) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 1.0000 | 1 | 100.0% | compression_cap_tokens | [backend/agent/context/budget.py:131](../../backend/agent/context/budget.py#L131) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 1.0000 | 1 | 100.0% | truncation_limit_tokens | [backend/agent/context/budget.py:136](../../backend/agent/context/budget.py#L136) | 待人工关联 |
| 低 | 1.0000 | 1 | 100.0% | history_capacity_tokens | [backend/agent/context/budget.py:141](../../backend/agent/context/budget.py#L141) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py), [backend/tests/test_session_history.py](../../backend/tests/test_session_history.py) |
| 低 | 1.0000 | 1 | 100.0% | diagnostics | [backend/agent/context/budget.py:165](../../backend/agent/context/budget.py#L165) | [backend/tests/test_context_budget.py](../../backend/tests/test_context_budget.py) |
| 低 | 1.0000 | 1 | 100.0% | atomic_message_units | [backend/agent/context/budget.py:251](../../backend/agent/context/budget.py#L251) | 待人工关联 |

## 结果摘要

- 函数数：27；CRAP 高风险（≥30）：0。
- 工具版本：lizard 1.23.0、pytest-cov 7.1.0、coverage 7.16.0、Vitest 4.1.11、@vitest/coverage-v8 4.1.11。
- 变异统计：本阶段未执行（JSON 中为 null，不是 0 个变异）。
- 执行策略：CRAP 报告与变异测试仅周期性手动运行，不由自动 CI 触发；普通 pytest/Vitest 仍按现有 workflow 执行。CRAP 分数不会令命令失败；测试、工具或分析失败会显式标记 failed 或 timeout 并返回非零状态。

## 排除范围与数据边界

- 本轮仅选两个确定性单元测试目标；不扫描同目录其他模块。
- 不连接真实模型、网络、IM、Docker、PTY、共享 Redis/Postgres 或用户文件。
- 变异测试属于 Phase 2，本报告不运行，也不推断 mutation score。
- 报告只保留仓库相对路径、函数名、覆盖率/复杂度和测试状态；不保存测试 stdout、聊天正文、附件、真实用户数据或凭据。覆盖率 JSON 与 .coverage 在系统临时目录生成，由 TemporaryDirectory 自动清理。

## 测试脚本与复现

- 编排脚本：scripts/quality/crap_report.py。
- 范围配置：scripts/quality/crap_scope.json。
- 命令：backend/.venv/bin/python scripts/quality/crap_report.py。
- 原始脱敏结果：同目录 JSON 报告；临时覆盖率文件不保留。
- 真实 provider / 服务 / 数据：否；试点为纯单元测试，未连接真实模型、数据库、Redis、IM、网络或用户文件。
- 工具文档：[Lizard](https://github.com/terryyin/lizard)、[pytest-cov JSON 报告](https://pytest-cov.readthedocs.io/en/stable/reporting.html)、[Vitest coverage](https://vitest.dev/guide/coverage.html)。
