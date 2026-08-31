# 测试维护审计（2026-08-31）

> 由 `scripts/tests/run-maintenance-audit.mjs` 生成；用于月度清单、skip 到期和入口健康检查。

## 清单状态

- 测试资产：298 个
- 声明用例：2157 个
- skip 文件：3 个，均有未到期策略
- 未归类文件：0 个

## 维护入口

| 检查 | 命令 | 目的 |
|---|---|---|
| 快速门禁 | `pnpm test:fast` | PR L0 与快速回归 |
| 受影响测试 | `pnpm test:affected -- --base=<sha>` | PR 受影响 L1 |
| 完整矩阵 | `pnpm test:all` | 主分支/发布前完整验证 |
| 月度审计 | `pnpm test:maintenance` | 清单、helper、边界和 skip 到期 |

## 慢测与失败记录

- 慢测耗时由 CI job 摘要记录；失败按环境准备、代码/测试执行和测试分类三类步骤区分。
- 本次审计不自动重试失败测试；重试必须在 CI job 中显式记录，避免把 flaky 当成通过。

## 结论

- [x] 清单无失联文件。
- [x] `other=0`，所有实际 skip 均有责任人和到期日期。
- [x] 新增测试需通过 `test:metadata` 元数据门禁。
