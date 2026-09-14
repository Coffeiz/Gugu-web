# PRD-TEST-2：复杂度风险与变异测试质量门禁

> 状态：Phase 0–3 已完成（2026-09-13）；后续按周期手动复核
> 创建：2026-09-07
> 最近更新：2026-09-13
> 关联模块：`backend/tests/`、`frontend/src/**/*.test.ts`、`frontend/test/`、`scripts/quality/`
> 背景参考：[`【已完成】PRD-TEST-1-测试分层与冗余治理.md`](./【已完成】PRD-TEST-1-测试分层与冗余治理.md)、[`agentskills/testing/SKILL.md`](../../agentskills/testing/SKILL.md)

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| 代码复杂度风险分析 | 已形成 Python/TypeScript 函数级 CRAP 基线 | ✅ 已完成 | 显式试点 25 个函数，报告含 CC、Cov、CRAP、明确登记的测试关联（其余标待人工关联）和风险级别；周期性手动运行，高风险仅报告、不阻断、不接入自动 CI |
| 变异测试 | Python Mutmut、TypeScript Stryker 已建立显式范围和报告入口 | ✅ 已完成 | 周期性手动运行，不接入自动 CI；2026-09-13 基线见 Phase 2 报告 |
| 质量报告归档 | JSON/Markdown 统一归档到 `docs/reports/` | ✅ 已完成 | 覆盖率中间文件写入系统临时目录并自动清理；不落到用户数据或运行配置 |
| 自动 CI 策略 | CRAP 与变异测试均不接入自动 CI | ✅ 已明确 | 两者按迭代节奏由维护者手动运行；push、PR、发布流水线均不触发。普通 pytest/Vitest 等既有自动 CI 保持不变 |
| 趋势复跑与人工复核 | 已完成同范围 CRAP/变异报告复跑并建立季度清单 | ✅ 已完成 | 报告保留在版本库；复核周期为每季度，重要重构/发布前额外执行；详见 Phase 3 报告 |

### 0.1 Phase 0 盘点结果

- 工具基线：后端原有 pytest，但没有 pytest-cov/coverage；前端有 Vitest 4.1.11，但没有 coverage provider；仓库没有统一 Python/TypeScript 圈复杂度工具。
- 工具选择：开发依赖使用 `pytest-cov 7.1.0`、`coverage 7.16.0`、`Lizard 1.23.0` 和与 Vitest 对齐的 `@vitest/coverage-v8 4.1.11`。Lizard 统一计算 Python/TypeScript CC，各自原生 coverage 提供覆盖行。
- 既有 CI：`.github/workflows/runtime-integration.yml` 已运行前端 `npm run test:run` 和后端完整 `pytest -q`；报告脚本不加入 workflow，不改变既有测试/构建门禁。
- 执行策略：CRAP 报告和变异测试由维护者按迭代节奏定期手动运行；重要重构或发布前可加跑。它们不由 push、PR 或发布流水线自动触发，也不创建自动 CI job。策略变更必须先更新本 PRD 并单独评审。
- 显式试点：上述测试文件是源码级覆盖率运行范围；只有 `crap_scope.json` 中 `function_tests` 明确登记的函数才显示函数级测试关联，其余显示“待人工关联”，不从源码级测试列表推断函数关联。均标记为 L0 单元测试。
- 排除范围：试点基线未扫描目录/仓库其余代码；未连接真实 provider、网络、IM、Docker、PTY、共享 Redis/Postgres 或用户文件。变异测试同样只扫描 `mutation_scope.json` 明确登记的目标。2026-09-14 起 CRAP 增加 `--full` 全量扫描模式（声明目录内全部源文件 + 整语言套件覆盖率，手动运行，仍不接入 CI），试点基线保留作对照。
- 报告入口：`backend/.venv/bin/python scripts/quality/crap_report.py`；输出 `docs/reports/` 下同名 JSON/Markdown。CRAP ≥30 标高、≥15 标中，其余标低；风险分层是展示规则，不是门禁。
- 本次基线：[Markdown 报告](../reports/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.md) · [JSON 报告](../reports/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.json)。

### 0.2 Phase 2 变异测试基线

- 手动入口：`backend/.venv/bin/python scripts/quality/mutation_report.py --language both`；范围与源码—测试映射由 `scripts/quality/mutation_scope.json` 固定。
- Python：60 个变异全部 killed，0 survived、timeout、compile/runtime error、no coverage、equivalent 或 not checked；mutation score 100%。
- TypeScript：29 个可执行变异全部 killed，0 survived、timeout、runtime error、no coverage、equivalent 或 not checked；另有 1 个变异被 TS checker 判定为无效语法（compile error），不纳入 score 分母；可执行变异 mutation score 100%。
- 验证范围覆盖上下文工具结果分组、确认门、文件 ID 校验、ownership 隔离/脱敏、pending queue lease、文件覆盖判定，以及前端 optimistic mutation。变异目标和对应测试见 `mutation_scope.json`。
- 报告：[Markdown](../reports/2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.md) · [JSON](../reports/2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.json)。该报告是手动质量记录，不是 CI 产物。

### 0.3 Phase 3 稳定性复跑与人工复核

- 对 Phase 2 的同一变异目标和 Phase 0–1 的同一 CRAP 源码/测试路径进行手动复跑；稳定复跑的两个 CRAP 报告包含相同 26 个函数，所有函数的 CC、覆盖率、CRAP 和风险级别均一致；高风险函数仍为 2 个。
- 与 Phase 2 变异基线比较，Python 60 个和 TypeScript 30 个 mutant 的 ID、状态均未变化；Python 60/60 killed，TypeScript 29/29 可执行项 killed，1 个 compile error 继续单列；无存活、超时、运行错误、无覆盖或未检查项。
- CRAP 两次稳定复跑耗时分别为 4.768 秒和 4.201 秒；变异复跑分别为 Python 39.829 秒、TypeScript 43.067 秒。耗时有机器负载波动，未出现错误状态。
- Phase 0–1 历史 CRAP 报告有 25 个函数；当前为 26 个。差异来自 Phase 2 对上下文预算代码的纯函数边界抽取和新增测试：新增 `_consecutive_tool_result_indices`，`_units` 的 CC 由 5 降至 4，`atomic_message_units` 覆盖由 0 升至 1。该历史代码变化不计作同代码复跑波动。
- 复核责任：仓库维护者负责按期运行和归档，相关模块责任人审查本模块高风险项和存活变异；未分配到个人姓名，以免负责人变动造成文档失效。
- 节奏与时间预算：每季度手动运行一次；涉及本范围安全/状态边界的重大重构或发布前额外运行。CRAP 目标不超过 5 分钟，变异测试每种语言目标不超过 10 分钟；超预算先检查环境、工具和显式范围，不直接扩大 CI 或放宽超时。
- 误报处理：CRAP 分数只用于排序，先核对函数级覆盖和登记的测试关联，再由模块责任人判断；mutation 的 compile/runtime error、timeout、no coverage、not checked 各自调查，不计为 killed；只有给出行为等价证据并经维护者复核才可标记 equivalent。没有全局通过阈值。
- 归档策略：Markdown/JSON 质量报告和趋势摘要作为版本化审计记录保留，不自动清理；临时覆盖率文件按次清理，Mutmut/Stryker 临时目录由工具清理并保持 Git 忽略。每季度检查生成物和目录体积，只人工清理确认可再生成的临时文件，不删除历史报告。
- 复跑报告：[CRAP 复跑 1](../reports/phase3-rerun/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.md) · [CRAP 复跑 2](../reports/phase3-rerun-2/2026-09-13-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.md) · [变异复跑](../reports/phase3-rerun/2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.md) · [趋势报告](../reports/2026-09-13-VERIFY-PRD-TEST-2-PHASE3.md)。

## 1. 背景与目标

### 1.1 背景

Gugu-web 已有后端 pytest、前端 Vitest、Playwright 和 TypeScript 包测试，并已按 L0～L3 做执行分层。但“测试通过”仍有两个盲区：

1. 某些函数圈复杂度较高、覆盖率较低，维护时更容易引入未覆盖分支；单看总覆盖率无法定位这些局部风险。
2. 测试可能只验证了 happy path，生产代码被有意义地改动后，断言不一定会失败；覆盖率上升也不代表测试真的能杀死行为变异。

CRAP 指标用于定位“复杂且未被充分覆盖”的代码；变异测试用于验证测试是否能发现受控的行为改动。两者互补，不替代现有测试分层、越权测试、确认门测试、E2E 或人工验收。

### 1.2 目标

1. 建立后端和前端统一的复杂度风险报告，按文件、函数、领域和测试层级输出可追踪结果。
2. 在确定性核心模块上引入小范围变异测试，验证关键断言能够杀死常见行为变异。
3. 以周期性手动报告和趋势观察为主；基线稳定后可调整人工复核范围，不设置自动 CI 门禁。
4. 把慢速、非确定性、依赖真实服务或需要人工判断的模块排除在默认变异测试之外，并给出显式原因。
5. 保持现有测试目录和责任边界，不为了引入质量工具创建第二套业务测试目录。

### 1.3 非目标

- 不用 CRAP 分数替代覆盖率、断言质量、越权测试或真实链路验收。
- 不对整个仓库无差别运行变异测试；首版不覆盖 Docker、PTY、真实 Redis/Postgres、真实模型、第三方 IM 和网络请求。
- 不因为变异测试耗时而删除、跳过、放宽现有测试，或修改生产行为迎合工具。
- 不把等价变异误判为测试失败；等价变异必须登记并说明原因。
- 不把完整覆盖率或 mutation score 设成未经基线验证的全局硬阈值。
- 不新增运行时配置、用户数据表、业务日志字段或用户可见功能。

## 2. 功能需求

### FR-TEST-2-1：生成复杂度风险报告

质量流程应能对选定的 Python/TypeScript 源码生成复杂度、覆盖率和 CRAP 风险结果，至少包含：

- 文件路径、函数/方法名、所属领域；
- 圈复杂度 `CC`、可执行行覆盖率 `Cov`、CRAP 分数；
- 对应测试入口、测试层级及普通测试是否进入自动 CI；CRAP/变异分析本身按周期手动运行，不进入自动 CI；
- 风险等级及排除原因（如自动生成代码、适配器、外部依赖包装层）。

CRAP 采用标准定义：

```text
CRAP = CC² × (1 - Cov)³ + CC
```

首轮只报告，不预设仓库级硬阈值。报告应同时保留原始 `CC` 和 `Cov`，避免把归一化后的单一风险等级当成唯一依据。

### FR-TEST-2-2：按领域筛选分析范围

分析范围必须显式指定，不能因工具默认行为扫描整个工作区。首轮优先选择以下确定性高、行为价值高的模块：

- `backend/agent/context/`：历史、预算、压缩和前缀边界；
- `backend/agent/tools/`：工具 Schema、权限、确认门和参数校验；
- `backend/app/services/filesync/`：文件/文件夹变化、删除和状态投影；
- `frontend/src/components/common/gugu-chat/` 与相关 composable：消息状态、工具气泡和刷新恢复；
- `frontend/src/utils/`、`frontend/test/` 中的纯函数和协议转换。

具体文件必须在基线报告中登记；不应因目录名称相似而自动纳入。

### FR-TEST-2-3：执行受控变异测试

变异测试只对可重复的单元或小型集成测试运行。首轮支持：

- Python：以 `mutmut` 或等价工具对选定模块生成变异并运行对应 pytest；
- TypeScript：以 `Stryker` 或等价工具对选定模块运行 Vitest；
- 变异操作至少覆盖条件反转、边界值变化、返回值变化、布尔值变化和分支删除等常见类型；
- 每次报告记录总变异数、被杀死、存活、超时、运行错误和人工标记的等价变异数；
- 运行失败必须区分生产代码失败、测试失败、工具超时和环境失败，不能统称为“存活变异”。

### FR-TEST-2-4：按行为风险解释存活变异

存活变异不能只输出数字。每个需要处理的存活变异必须能回溯到：

- 生产文件和变异位置；
- 变异类型与变异前后行为；
- 应该捕获它的测试入口；
- 处置结论：补测试、调整分析范围、标记等价、修复生产缺陷或保留观察；
- 处置理由和验证命令。

涉及权限、数据隔离、文件删除/覆盖、确认门、上下文顺序、消息生命周期和敏感信息脱敏的存活变异，不得直接标记为“低风险”。

### FR-TEST-2-5：报告与缓存隔离

质量工具生成的报告、临时变异目录、覆盖率数据库和缓存不得进入业务源码、用户数据或运行配置。报告应：

- 输出到统一质量产物目录；
- 支持 JSON 机器读取和 Markdown 人工审查；
- 记录 commit、工具版本、命令、范围和时间；
- 不包含聊天正文、附件内容、真实用户名、Token、API Key 或真实路径中的敏感片段；
- 临时执行失败后可以安全清理，不修改 `backend/config.override.json`、`.env` 或部署数据。

### FR-TEST-2-6：手动报告与自动 CI 分离

CRAP 与变异测试只用于周期性手动质量评审，不提供自动 CI 门禁模式，也不阻断既有 CI。若未来确需接入 CI，必须先更新本 PRD、明确触发方式与阻断策略并单独评审。

定期人工评审至少检查：

- CRAP 高风险函数是否有明确处置；
- mutation score 是否低于该模块自身基线；
- 存活变异是否集中在安全/状态边界；
- 失败是否来自工具或环境，而非测试行为；
- 运行时间是否在约定预算内。

## 3. 技术方案

### 3.1 目录与责任边界

本 PRD 不创建新的业务测试目录。实现范围如下：

```text
Gugu-web/
├── docs/prds/
│   └── PRD-TEST-2-复杂度与变异测试质量门禁.md       【新增】
├── scripts/quality/
│   ├── crap_report.py                               【新增】
│   ├── mutation_report.py                           【新增】
│   └── README.md                                    【新增】
├── docs/reports/                                     【归档手动生成报告】
├── backend/tests/                                   【不改目录】
├── frontend/src/**/*.test.ts                        【不改目录】
├── frontend/test/                                   【不改目录】
├── backend/requirements-dev.txt                      【质量工具开发依赖】
├── frontend/package.json                             【质量工具开发依赖】
└── .github/workflows/                                【不修改；不接入 CRAP/变异测试】
```

`backend/tests/` 和前端既有测试目录继续负责行为测试；`scripts/quality/` 只负责编排和报告，不承载业务断言；`docs/reports/` 保存版本化脱敏报告，覆盖率、Mutmut 和 Stryker 临时数据由各自工具在隔离临时目录清理。若已有统一质量脚本入口，应扩展现有入口，不重复创建同义目录或命令。

### 3.2 复杂度与覆盖率计算

- Python 使用 pytest-cov JSON 覆盖率并按 AST 函数体行计算（排除定义/参数签名行），TypeScript 使用 Vitest V8 coverage JSON；复杂度统一由 Lizard 1.23.0 计算。
- 分析范围与对应测试入口来自 `scripts/quality/crap_scope.json`；每个源文件须显式登记领域、测试层级和 CI 现状，不把诊断脚本、迁移脚本和生成代码混入排名。
- CRAP 脚本负责合并 `CC` 和 `Cov`、输出排名和趋势，不重复实现测试执行器。
- 首轮报告必须能从一个函数跳转到源码和关联测试文件；无法自动建立映射时写“待人工关联”，不能伪造覆盖关系。源码级测试列表仅描述覆盖率运行范围，不等价于函数级关联。
- 当前报告手动、非阻断，不属于默认 CI；覆盖率 JSON、`.coverage` 和测试输出不归档，只归档脱敏的函数级 JSON/Markdown 报告。

### 3.3 变异执行隔离

- Python 与 TypeScript 分开执行、分开统计，不能把两种 mutation score 合并成一个数字。
- 首轮只允许显式列出的模块和测试入口，禁止工具扫描整个仓库后长时间运行。
- 变异测试使用临时目录、内存数据库和 mock 外部服务，遵守 `agentskills/testing/SKILL.md` 的数据隔离要求。
- 变异运行不读取真实运行配置，不连接真实模型、第三方 IM、用户存储或生产数据库。
- 超时、worker 崩溃、依赖缺失和收集失败单独计数；不得把未执行的变异计算为 killed。

### 3.4 报告模型

每次报告至少记录以下元数据和统计：

```json
{
  "commit": "<commit fingerprint>",
  "tool": "crap|mutmut|stryker",
  "tool_version": "<version>",
  "scope": ["<explicit source path>"],
  "test_command": "<redacted command>",
  "duration_ms": 0,
  "summary": {
    "complexity_hotspots": 0,
    "mutants_total": 0,
    "mutants_killed": 0,
    "mutants_survived": 0,
    "mutants_timeout": 0,
    "mutants_error": 0,
    "equivalent_marked": 0
  },
  "items": []
}
```

报告中的路径应使用仓库相对路径；命令参数需要脱敏。若工具必须写绝对临时路径，应在 Markdown 报告中清理为稳定占位符。

### 3.5 与既有测试分层的关系

CRAP 报告使用 L0/L1 的覆盖率和静态结果；变异测试首轮属于 L2 质量分析。两者都只按周期手动运行，不进入快速门禁或自动 CI；稳定后可以纳入定期人工复核的范围，但不得因此自动接入 workflow。

## 4. 验证与上线

### 4.1 验收方式

验收必须证明以下事实：

- 仅扫描显式范围，未意外执行真实模型、Docker、PTY、网络或用户数据访问；
- CRAP 报告中的复杂度和覆盖率可由对应工具复算；
- 人为删除一个关键断言或改变一个关键分支时，变异测试能产生对应存活变异；恢复测试后该变异被杀死；
- 工具失败、超时和等价变异在报告中有独立状态；
- 同一 commit、同一范围和同一工具版本可以稳定复跑；
- 既有后端 pytest、前端 Vitest、typecheck、构建和 E2E 入口结果不因接入报告而改变；
- 报告和临时目录不会污染 `Gugu-data/`、`uploads/`、运行配置或 Git 工作区。

### 4.2 手动运行入口

以下是维护者手动执行的命令，不由任何自动 CI workflow 调用：

```bash
# 生成 crap_scope.json 中登记的 CRAP 报告
backend/.venv/bin/python scripts/quality/crap_report.py

# 只运行某一种语言的 CRAP 范围
backend/.venv/bin/python scripts/quality/crap_report.py --language python
backend/.venv/bin/python scripts/quality/crap_report.py --language typescript

# 运行 mutation_scope.json 中全部显式范围的 Python 变异测试
backend/.venv/bin/python scripts/quality/mutation_report.py --language python

# 运行 mutation_scope.json 中全部显式范围的 TypeScript 变异测试
backend/.venv/bin/python scripts/quality/mutation_report.py --language typescript

# 手动运行两种语言并归档报告
backend/.venv/bin/python scripts/quality/mutation_report.py --language both

# 同日重新运行并替换报告时显式确认覆盖
backend/.venv/bin/python scripts/quality/mutation_report.py --language both --overwrite
```

CRAP 报告独立运行，命令见 `scripts/quality/README.md`。CRAP 和变异测试均为周期性手动评估，不属于自动 CI，也不阻断既有自动测试门禁。

### 4.3 上线策略

1. Phase 0～3 已完成；后续执行遵循本节定义的季度复核和归档策略。
2. CRAP 与变异测试仍为手动、非阻断质量评估，不创建自动 CI 提醒、报告 job 或门禁。若要改变策略，必须先更新本 PRD 并完成单独评审；普通 pytest/Vitest 等既有自动 CI 不受影响。

## 5. 风险与待确认问题

### 5.1 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 变异测试运行时间过长 | 手动评审耗时，维护者可能减少执行频率 | 限制显式范围并设置单模块时间预算；按周期人工安排，不创建自动 CI job |
| 等价变异较多 | mutation score 被低估，产生无效修复 | 单独登记等价变异，要求给出行为证明，不直接调高分数 |
| CRAP 被误解为质量总分 | 复杂但有意设计的编排代码被误报 | 同时展示 CC、Cov、测试入口和领域风险，由责任人审查 |
| 工具生成路径污染工作区 | 误提交缓存、覆盖率或敏感文件 | 统一临时目录和 `artifacts/quality/`，执行后检查 `git status` |
| 把环境失败算成存活变异 | 错误判断测试薄弱 | 报告独立记录 timeout/error/collection failure |
| 变异测试触及真实服务或数据 | 数据污染或安全事故 | 只允许临时 fixture/mock，默认拒绝真实配置和真实存储 |
| 人工复核过早依赖全局硬阈值 | 产生误报，错误影响质量判断 | 先建立模块基线，按模块趋势进行人工复核；不启用自动门禁 |

### 5.2 周期性人工复核

- 责任人：仓库维护者负责运行、归档和更新趋势摘要；相关模块责任人审查所属高风险函数、存活变异及安全/状态边界。
- 节奏：每季度运行一次；触及本范围的重大重构或发布前额外运行。只对相同显式范围和工具配置比较趋势。
- 预算：CRAP 报告目标 ≤5 分钟；变异测试 Python、TypeScript 各 ≤10 分钟。超过预算时先排查负载、依赖或范围，不改变自动 CI 策略。
- 误报和异常：CRAP 仅排序，人工核对覆盖与函数测试映射；timeout、compile/runtime error、no coverage、not checked 分开处理且不得计入 killed；等价变异必须有行为证明和维护者复核。
- 报告留存：`docs/reports/` 下的版本化 Markdown/JSON 与趋势记录长期保留，不自动清理。每季度检查临时产物；只清除已确认可再生的工具缓存，不删除历史报告。

## 6. 唯一实施 TODO

### Phase 0：基线与范围

- [x] `TEST2-001` 盘点现有 Python/TypeScript 的覆盖率、复杂度工具和 CI 入口；验收：形成工具选择记录，不修改业务代码和既有测试断言。
- [x] `TEST2-002` 选定首轮分析范围并登记源码、测试入口、领域、层级和排除原因；验收：范围是显式可复现列表，不包含真实服务和用户数据。
- [x] `TEST2-003` 建立质量报告输出格式、临时目录清理规则和敏感信息脱敏规则；验收：本地生成 JSON/Markdown 样例，`git status` 无生成物泄漏。

### Phase 1：CRAP 报告

- [x] `TEST2-004` 实现复杂度/覆盖率合并报告；验收：能输出每个选定函数的 `CC`、`Cov`、CRAP、风险等级和测试关联，公式结果可复算。
- [x] `TEST2-005` 接入 Python 和 TypeScript 的非阻断报告入口；验收：只运行显式范围，既有 `pytest`、Vitest、typecheck 和构建入口结果不变。
- [x] `TEST2-006` 增加报告回归校验和生成物清理；验收：工具失败、空范围、路径错误和敏感字段均有明确结果，不静默生成伪报告。

### Phase 2：变异测试

- [x] `TEST2-007` 在确定性 Python 核心模块建立 Mutmut 基线；验收：报告区分 killed/survived/timeout/error/equivalent 等状态，运行不访问真实配置或用户存储。结果：60/60 killed，0 个未检查项。
- [x] `TEST2-008` 在确定性 TypeScript 核心模块建立 Stryker 基线；验收：报告与 Vitest 入口边界一致，未执行未授权目录，运行时间和失败原因可追踪。结果：29 个可执行变异全部 killed，另有 1 个 compile error 单独记录。
- [x] `TEST2-009` 处理首轮存活变异；验收：每个存活项都有补测试、等价证明、范围调整或生产修复结论，并通过对应专项测试。结果：首轮 8 个存活变异对应补充了边界断言，最终复跑存活数为 0。
- [x] `TEST2-010` 对权限、确认门、文件覆盖/删除、上下文顺序和消息生命周期补充行为级变异回归；验收：关键变异能被测试杀死，不能用降低断言或 `skip` 达成绿色。结果：本轮选定的安全和状态边界变异均被专项测试杀死。

### Phase 3：趋势与周期性手动评审

- [x] `TEST2-011` 记录至少一轮稳定基线和复跑趋势；验收：同一范围的复杂度、覆盖率、mutation score、耗时和错误率可比较。结果：相同 26 个 CRAP 函数的复杂度/覆盖率指标完全一致；Python/TypeScript mutant ID 与状态完全一致，耗时和异常状态已记录于 Phase 3 趋势报告。
- [x] `TEST2-012` 根据多次基线整理定期人工复核清单；验收：记录责任人、复核节奏、时间预算和误报处理，不创建自动 CI 提醒或门禁。结果：已定为仓库维护者统筹、模块责任人复核、季度执行、重大变更前加跑；报告长期保留，临时产物季度检查。
- [x] `TEST2-013` 完成 PRD、测试约定和 devlog 的实现结果同步；验收：实际状态、唯一 TODO、手动运行入口和报告目录一致，明确 CRAP/变异测试不由自动 CI 触发，旧方案和死入口已清理或说明保留原因。结果：PRD、testing skill、质量脚本 README 和本次 devlog/趋势报告已同步；自动 workflow 未添加 CRAP/变异任务。
