# 质量报告脚本

本目录只放质量分析编排与其自身的回归测试，不放业务测试。

## 执行策略

CRAP 报告和变异测试均为维护者周期性手动执行的质量检查，不属于自动 CI，不由 push、PR 或发布流水线触发。重要重构或发布前可以额外手动运行。当前自动 CI 继续运行既有 pytest、Vitest 等测试，不运行本目录的 CRAP 报告或变异测试；不得把它们加入 workflow。若将来要改变策略，需先更新 PRD 并单独评审。

## Phase 0 盘点与工具选择

- 后端现有入口：runtime-integration workflow 在服务隔离环境中运行 backend 的完整 pytest；开发测试基座使用内存 SQLite 和 fakeredis。本报告所选测试不需要访问真实服务。
- 前端现有入口：runtime-integration workflow 运行 frontend 的 npm run test:run；本报告只额外启用 Vitest V8 coverage，不改既有测试脚本。
- 仓库原先没有 Python pytest 覆盖率/统一圈复杂度依赖，也没有前端 Vitest coverage provider。本报告使用开发依赖 pytest-cov 7.1.0、coverage 7.16.0、Lizard 1.23.0，以及与 Vitest 4.1.11 对齐的 @vitest/coverage-v8。
- Lizard 对 Python 与 TypeScript 使用同一复杂度口径；覆盖率来自各语言原生测试工具。流程只合并显式列出的单文件，不把工具默认范围扩展到整个仓库。
- 风险展示规则：CRAP ≥30 为高、≥15 为中、其余为低；仅用于人工排序，不作为通过条件或 CI 阈值。
- 工具参考：[Lizard](https://github.com/terryyin/lizard)、[pytest-cov JSON 报告](https://pytest-cov.readthedocs.io/en/stable/reporting.html)、[Vitest coverage](https://vitest.dev/guide/coverage.html)。

## CRAP 基线

    backend/.venv/bin/python scripts/quality/crap_report.py

分析范围仅由 crap_scope.json 明确列出。当前入口分别执行对应 Python pytest 与 Vitest 单元测试，输出 CC、覆盖率和 CRAP 的 JSON/Markdown 到 docs/reports/。Python 的函数覆盖率按 AST 函数体区间统计，不把 import 时执行的 def/参数签名行算作函数体覆盖。运行是周期性手动、非阻断的；高 CRAP 分数不会令入口失败，测试/工具/分析失败会写入显式失败状态并返回非零退出码。

## Phase 2 变异测试

变异测试只运行 `mutation_scope.json` 登记的目标：Python 使用 Mutmut 的函数/指定变异范围，TypeScript 使用 Stryker + Vitest；每个目标都固定对应测试文件。统一入口会生成 JSON/Markdown 报告到 `docs/reports/`，分别记录 killed、survived、timeout、compile error、runtime error、no coverage、equivalent 和 not checked。mutation score 只按 killed+survived 计算，其他状态单列，避免把未执行或编译失败伪装成测试杀死。

手动运行两种语言并归档当日报告：

    backend/.venv/bin/python scripts/quality/mutation_report.py --language both

仅重跑一种语言：

    backend/.venv/bin/python scripts/quality/mutation_report.py --language python
    backend/.venv/bin/python scripts/quality/mutation_report.py --language typescript

如需在保留当日既有基线的情况下归档复跑，可指定 `docs/reports/` 下的子目录：

    backend/.venv/bin/python scripts/quality/mutation_report.py --language both --report-dir docs/reports/phase3-rerun

报告目录被限制在 `docs/reports/` 内，避免误写运行配置或用户数据。

报告同日已存在时，必须显式添加 `--overwrite`。Mutmut 的 `backend/mutants/`、Stryker 的 `frontend/.stryker-tmp/` 与 `frontend/.stryker-report/` 是忽略的本地生成物，不进业务目录或 Git。Mutmut 不命中已登记的精确目标时会报告 `not_checked`，不能被算作成功。

变异范围或测试关联的调整必须同步更新 `mutation_scope.json`，并说明原因。CRAP 与变异测试仍是维护者定期手动质量检查，不属于自动 CI，不触发、不阻断 push/PR/release workflow。

## 周期复核清单

- 责任人：仓库维护者负责执行和归档；相关模块责任人复核所属热点、存活变异和安全/状态边界。
- 周期：每季度一次；触及显式范围的重大重构或发布前额外执行。
- 时间预算：CRAP 目标不超过 5 分钟；Mutmut 和 Stryker 各不超过 10 分钟。超出时先查环境、依赖和范围，不将任务接入 CI 或通过放宽失败状态达成通过。
- 误报处理：CRAP 仅用于排序并需核对函数级测试映射；timeout、编译/运行错误、无覆盖、等价和未检查状态分别调查，不计入 killed。等价变异须附行为证据并由维护者复核。
- 留存：`docs/reports/` 中 Markdown/JSON 基线与趋势记录长期保留；每季度检查工具临时产物，只清理确认可再生的缓存，不删除历史报告。
- 2026-09-13 的 Phase 3 趋势见 `docs/reports/2026-09-13-VERIFY-PRD-TEST-2-PHASE3.md`。

同名报告已存在时不会覆盖；如需重跑并替换当天报告，显式加 --overwrite。

首次安装质量报告依赖：backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt；corepack pnpm install --filter gugu-web。

覆盖率 JSON 和 .coverage 文件写入系统临时目录，进程退出后自动清理。测试子进程会剔除数据库、Redis、provider、IM 与凭据类环境变量，不记录测试 stdout，也不读取用户运行配置。

报告计算器回归：

    backend/.venv/bin/python -m pytest -c backend/pytest.ini scripts/quality/test_crap_report.py scripts/quality/test_mutation_report.py -q

添加范围时必须一并核对源码、运行测试范围、领域、测试层级、CI 情况和排除说明。源码级 `tests` 只表示本次覆盖率运行的测试集合；函数级关联必须通过 `function_tests` 明确登记，未登记的函数会显示“待人工关联”，禁止把源码下所有测试伪装成每个函数的关联测试。禁止将整个目录或仓库交给复杂度/覆盖率工具默认扫描。

## CRAP 全量扫描（2026-09-14 起）

- 命令：`backend/.venv/bin/python scripts/quality/crap_report.py --full`。
- 范围：`crap_scope.json` 的 `full_scan` 段声明目录（当前 backend/agent + backend/app、frontend/src）
  内全部源文件；覆盖率来自整语言测试套件单次运行（pytest --cov=agent --cov=app / vitest --coverage.include=src/**）。
- 报告：`docs/reports/{date}-VERIFY-PRD-TEST-2-CRAP-FULL.{json,md}`；中/高风险全量列出，低风险仅计数。
- 全量模式同样手动运行、不进 CI；测试运行失败时仍提取已生成的覆盖率并标注 failed。
