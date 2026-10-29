# 测试维护配置

## 回归测试与主动验证脚本

仓库把**可自动重复的回归断言**与**人工发起的验证/实验脚本**分开管理。前者保护已确认的产品行为并可进入测试门禁；后者用于调查真实环境、Provider 行为、性能或服务链路，不因名字含有“test”就视为回归测试。

| 类型 | 放置位置 | 自动运行边界 |
| --- | --- | --- |
| 后端回归测试 | `backend/tests/<功能域>/` | `backend/pytest.ini` 的 `testpaths`；可按标记分层 |
| 前端单元/集成回归 | `frontend/tests/<功能域>/` | Vitest 的 `tests/` 范围 |
| 浏览器 E2E 回归 | `frontend/e2e/` | 仅由 `frontend/package.json` 明确列入的稳定命令进入 CI；实验用例用独立命令 |
| 包内/工具回归测试 | `backend/ts/**/test/`、`loopscope/**/*.test.ts`、`scripts/release/*.test.mjs`、`scripts/quality/test_*.py`、`scripts/licenses/tests/` | 由各包或仓库 CI 的明确命令调用；保持靠近独立包和被测工具 |
| 手动诊断/复现 | `backend/scripts/diagnostics/` | 人工执行；可能访问真实数据、网络或 Provider，必须显式说明边界和开关 |
| 手动基准/A-B | `backend/scripts/benchmarks/` | 人工执行；记录输入、测量口径、成本与限制，不作为回归断言 |
| 冒烟/静态检查 | `backend/scripts/smoke/`、`backend/scripts/checks/` | 按各自命令执行；检查脚本不得意外访问真实业务数据或模型 |
| 测试治理工具 | `scripts/tests/` | 用于分层调度、清单和元数据审计，不承载产品回归用例 |

新增人工脚本使用表示动作和风险的名称：诊断用 `probe_`，对照用 `compare_`，性能测量用 `bench_`，冒烟用 `smoke_`；不要用 `test_*.py`、`*_test.py`、`.test.*` 或 `.spec.*`，避免被工具识别为测试。新增自动回归测试则使用 pytest 的 `test_*.py`、Vitest 的 `*.test.ts` 或 Playwright 的 `*.spec.ts`，并放在对应测试目录。

脚本若发现稳定回归，应在相应测试目录新增行为断言；不要把一次性真实 Provider 调用、基准结果或诊断探针直接接入 CI。搬移或改名时更新所有命令、导入、文档链接及元数据；历史报告可保留运行时的原始证据，但当前可执行入口应指向新路径。

## 新增测试元数据

新增自动回归测试文件必须放入对应测试目录，并在 `test-metadata.json` 增加同路径条目。主动验证脚本不登记为自动回归测试：

```json
{
  "frontend/tests/example-feature/example.test.ts": {
    "domain": "frontend-ui",
    "layer": "L0",
    "owner": "frontend/frontend-ui",
    "productionEntry": "被测模块或入口",
    "keyBehavior": "关键回归行为",
    "ci": "test:fast"
  }
}
```

`test:metadata` 只阻断真正新增的测试文件；改名或修改已有测试仍由自动清单维护，避免一次性改写全部旧文件。

## Skip 策略

`skip-policy.json` 中每个实际 skip 都必须有 owner、原因、替代验收路径和到期日期。月度维护入口会阻断缺失、失联或到期的 skip。
