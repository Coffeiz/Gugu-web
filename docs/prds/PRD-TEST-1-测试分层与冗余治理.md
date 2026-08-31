# PRD-TEST-1 测试分层与冗余治理

## 1. 背景

当前 Gugu-web 后端 pytest 收集约 1760 个用例，前端 Vitest 收集 393 个用例，另有 10 个 Playwright E2E 文件。数量增长主要来自上下文、IM、存储、工具安全、模型适配和迁移回归功能持续补充，并不等于存在同等数量的重复测试。

现有测试已经覆盖了多个不同责任层：

- 领域服务和存储策略；
- API 路由、参数校验和异常映射；
- Agent Loop、上下文、缓存和 provider adapter；
- IM 会话、群聊/私聊隔离和消息协议；
- 前端纯逻辑、交互状态、样式回归和 E2E。

本 PRD 的目标是让测试数量可解释、执行层级可选择、重复用例有明确处置依据，并降低日常开发的反馈时间。目标不是单纯压低测试数字，也不是把不同边界的测试合并成一个“大测试文件”。

## 2. 目标

### 2.1 主要目标

1. 建立后端、前端和 E2E 的统一测试目录清单，记录每个文件的责任边界、执行层级、是否进入 CI 和最近维护状态。
2. 将测试分为快速门禁、常规回归、慢速/环境相关和人工验收四个执行层级。
3. 清理没有行为价值的重复夹具、重复断言、失效的 `skip` 和无人维护的历史命名。
4. 保留领域层与 API 层、旧实现与新策略迁移层之间必要的双层契约测试。
5. 让 CI 能按变更范围和执行层级运行，完整测试仍然保留为发布前门禁。
6. 用可审计的清单和删除记录证明每个被合并或移除的测试为何安全。

### 2.2 非目标

- 不为了减少数字删除安全、越权、数据隔离、缓存边界、上下文顺序和迁移兼容测试。
- 不把真实模型、真实第三方 IM、真实数据库数据接入单元测试。
- 不以降低断言数量替代测试分层；文件合并本身不算测试优化成果。
- 不在没有覆盖证据的情况下修改生产代码或测试断言。
- 不把所有测试移动到单一目录，避免失去代码所有权和模块边界。

## 3. 当前基线

| 类型 | 当前规模 | 当前入口 | 说明 |
|---|---:|---|---|
| 后端 pytest | 1761 个收集用例 | `cd backend && PYTHONPATH=. .venv/bin/pytest -q` | 参数化用例会展开计数 |
| 前端 Vitest | 394 个用例 / 57 个文件 | `cd frontend && npm run test:run` | `src/**/*.test.ts` 与 `test/**/*.test.ts` 并存 |
| 前端静态回归 | CSS、弹窗、i18n 等脚本 | `npm run test:css-glass`、`npm run test:ui-dialogs`、`npm run i18n:scan` | 不计入 Vitest 数量 |
| Playwright E2E | 10 个文件 | CI 当前执行 8 个稳定关键文件 | 2 个文件保留为实验入口 |
| 后端安全守卫 | ownership、confirm gate、ORM 边界 | 独立脚本 | 属于发布门禁，不应被普通 pytest 合并吞掉 |

最近一次完整基线：后端 `1761 passed`，前端 `394 passed`；许可证策略仍有既有依赖审查项，不属于本 PRD 的测试冗余问题。

## 4. 目标目录树

第一阶段不大规模移动业务测试，只增加清单和执行分层；后续按领域批次迁移，保持模块边界清晰：

```text
Gugu-web/
├── docs/prds/
│   └── PRD-TEST-1-测试分层与冗余治理.md
├── scripts/tests/
│   ├── collect-test-inventory.mjs       # 生成前端/后端/E2E清单
│   └── check-test-boundaries.mjs        # 检查命名、skip、入口一致性
├── backend/
│   ├── pytest.ini                       # 统一 markers 与默认执行约定
│   └── tests/
│       ├── conftest.py
│       ├── test_*.py                    # 第一阶段保持现状
│       └── test_catalog.json             # 生成物，不手工维护
├── frontend/
│   ├── vitest.config.ts
│   ├── test/                            # 共享纯逻辑契约
│   ├── src/**/*.test.ts                 # 与实现同目录的局部回归
│   └── e2e/
│       ├── *.spec.ts
│       └── e2e-catalog.json             # 生成物，不手工维护
└── .github/workflows/
    └── runtime-integration.yml          # 分层执行矩阵
```

不要求将 `backend/tests` 立即拆成大量子目录。只有当同一批测试完成归类、导入路径和 CI 入口验证后，才允许使用 `git mv` 做目录整理。

### 4.1 当前实际分布

当前测试文件实际分布如下：

```text
frontend/
├── src/**/*.test.ts                  # 29 个：实现附近的局部纯逻辑/样式契约
├── test/**/*.test.ts                 # 28 个：跨模块共享纯逻辑契约
├── e2e/*.spec.ts                     # 10 个：Playwright 浏览器流程
└── scripts/*regression*.mjs          # CSS/UI 静态回归脚本

backend/
├── tests/test_*.py                   # 196 个：Python/FastAPI/Agent 主测试集
├── scripts/diagnostics/test_*.py     # 18 个：诊断/观测脚本，不纳入 pytest 主门禁
├── ts/api/*.test.ts                  # TS API 测试
├── ts/packages/*/test/*.test.ts      # TS 共享包测试
└── ts/workers/*/test/*.test.ts       # TS Worker 测试

loopscope/
└── **/*.test.ts                       # 15 个：独立 LoopScope 运行时测试
```

此外，`scripts/licenses/check-licenses.mjs` 和 `frontend/scripts/check-*.mjs` 是静态检查脚本，均纳入清单但不计入 pytest/Vitest。诊断脚本和静态检查脚本是可执行质量资产，不计入标准测试声明总数。

### 4.2 分布判断

| 位置 | 是否需要整体移动 | 判断 |
|---|---|---|
| `frontend/src/**/` | 否 | 与实现同目录便于维护，适合局部纯逻辑、样式和 composable 回归 |
| `frontend/test/` | 否 | 跨模块共享契约集中管理，当前目录职责清楚 |
| `frontend/e2e/` | 否 | Playwright 配置已以此为 testDir，不应与 Vitest 混放 |
| `frontend/scripts/` | 可整理 | 可统一命名为 `scripts/checks/` 或保留现状，但要在清单中单独标记为静态检查，不当作单测 |
| `backend/tests/` | 暂不整体移动 | 196 个 Python 文件虽多，但仍由同一个 pytest 基座和 fixture 管理；先做领域清单，再按批次归类 |
| `backend/ts/**/test/` | 否 | 这是 Node/TypeScript 独立包测试，必须跟随各包的构建和依赖边界 |

结论：需要整理的是“索引、命名和执行入口”，不是把所有测试强行搬到一个目录。`backend/tests` 可以在后续领域批次中拆成子目录，但必须先验证 pytest 的递归发现、导入路径、fixture 作用域和 CI 命令。

## 5. 测试分层设计

### 5.1 L0：快速门禁

目标是开发者提交前几分钟内反馈，内容包括：

- 前端 typecheck、strict typecheck、纯函数 Vitest；
- 后端无外部服务的纯逻辑、schema、ownership、confirm gate 和关键安全测试；
- i18n、CSS、UI 对话框静态回归；
- Python compileall。

L0 必须确定性强，不读取真实运行配置，不访问真实模型、数据库或用户存储。

### 5.2 L1：常规回归

目标是每次 PR 的完整业务回归，包含：

- 后端全量 pytest；
- 前端全量 Vitest 和构建；
- provider、上下文、IM、存储、文件、Mind、定时任务等集成测试。

L1 允许使用内存 SQLite、临时文件系统和 mock 客户端，但仍不得使用真实用户数据或真实 API Key。

### 5.3 L2：慢速或环境相关

包括 Docker runtime、PTY、WebSocket、真实 Redis/Postgres、文件视频处理和需要系统进程的测试。它们必须有明确 marker，并在本地或 CI 的专用 job 执行，不应拖慢每次纯前端提交。

### 5.4 L3：E2E 与人工验收

Playwright 只保留稳定、可重复、无真实第三方账号依赖的关键路径。依赖长期测试账号、已有数据或 `test.skip()` 兜底的用例必须标记为本地实验，不得伪装成 CI 覆盖。

## 6. 已发现候选与处置原则

| 候选 | 表面现象 | 结论 |
|---|---|---|
| `test_folder_tree.py` / `test_folders_api.py` | 创建、重命名、移动异常场景名称相似 | 保留。前者锁定领域服务，后者锁定 REST 参数和异常映射 |
| `test_key_strategy.py` / `test_storage_keys.py` | 都验证路径和冲突解析 | 保留。前者验证新策略与旧实现等价，后者保护旧函数迁移兼容 |
| `src/components/common/gugu-chat/markdown.test.ts` / `frontend/test/markdown.test.ts` | 文件名相同 | 保留。前者是聊天表格转义，后者是全站 Markdown 消毒和 XSS 边界 |
| `test_preferences_*_contract.py`、`test_*_contract.py` | 历史 phase/P2-b 测试已按行为改名 | 保留 Git 历史，文件名直接表达偏好、Schema、I/O、QQ 错误和脱敏契约 |
| 低数量测试文件 | 一个文件只有 1～2 个用例 | 不因数量删除。安全回归和边界回归可以独立存在 |
| E2E 中的 `test.skip()` | 可能出现全绿但未执行 | 纳入单独清理批次，必须改为确定性夹具、明确实验标记或移出 CI |

## 7. 分批实施清单

### Phase 0：基线与清单

- [x] 新增 `pnpm test:inventory`，生成后端、前端、TS、E2E、诊断脚本和静态检查文件清单。
- [x] 清单记录文件位置、测试类型、推断层级、领域、源码声明用例数、CI 状态、skip/外部依赖提示和最近修改时间。
- [x] 将实际分散在 `backend/tests`、`backend/scripts/diagnostics`、`backend/ts/**/test`、`loopscope/**`、`frontend/src`、`frontend/test`、`frontend/e2e`、`frontend/scripts` 和 `scripts/licenses` 的文件纳入同一输出。
- [x] 为每个测试文件生成 `L0/L1/L2/L3`、领域和责任 owner；无法自动确认的领域保留“待复核”状态。
- [x] 记录完整测试基线耗时、失败数和警告，不把依赖许可证失败混入测试统计。
- [x] 将自动推断结果人工复核，补充 owner 和例外说明，`other=0`，仅保留 3 个明确 skip 例外。
- [x] 新增 `pnpm test:boundaries`，阻断未知测试目录并列出含 `skip` 的文件供人工复核。
- [x] 自动清单输出已覆盖 `backend/scripts/diagnostics`、`loopscope/**` 和 `scripts/licenses`。
- [x] 将自动推断结果写入可审查的 `docs/reports/2026-08-31-TEST-INVENTORY.json` 快照。
- [x] 人工复核快照中的“待复核”领域和 3 个实际 skip 例外说明；注释中的 skip 不计入。

验收：`node scripts/tests/collect-test-inventory.mjs` 可重复生成清单；文件数与仓库实际测试文件一致；参数化展开数和源码声明数的差异有说明；无真实配置和真实存储写入。

### Phase 1：快速门禁分层

- [x] 在 `backend/pytest.ini` 中定义统一 marker，至少包括 `slow`、`external_service`、`process` 和 `e2e_support`。
- [x] 通过测试收集钩子给 Docker、PTY、WebSocket、进程和外部 I/O 依赖测试自动补 marker。
- [x] 增加前端按目录或显式 include 的快速 Vitest 入口，不改变默认全量入口。
- [x] 将 compileall、ownership、confirm gate、Agent ORM 严格守卫、后端快速 pytest、前端 Vitest、i18n 和对话框静态检查纳入统一 `test:fast` 编排。
- [x] 记录快速门禁耗时和适用场景；新增 Agent ORM 边界违规由快速门禁和 CI 同时阻断。

验收：L0 不启动 Docker、不访问真实模型、不修改用户运行配置；L1 全量结果与当前基线一致。

### Phase 2：后端领域归类与重复审查

- [x] 生成七个核心领域的审查报告，记录文件、类型、层级、owner、声明数、依赖和 skip 状态。
- [x] 单独登记 `backend/ts`、`loopscope` 的 Node/TypeScript 测试，保持独立统计和边界。
- [x] 完成上下文/会话领域的首轮分组，区分缓存/前缀、历史、compaction、session 快照和续接恢复。
- [x] 完成 IM 领域的首轮分组，区分平台网关、身份成员、会话、媒体去重、交互确认和通知投递。
- [x] 完成存储/文件领域的首轮分组，区分字节存储、清理、key/路径迁移、文件夹服务、回收站/对账、附件/视频生命周期和前端投影。
- [x] 完成存储/文件领域专项验证：后端相关测试 `294 passed`，未发现因分组造成的回归。
- [x] 完成 Agent/provider 领域的首轮分组，区分 provider/history、loop/stream、工具 schema/隔离、能力注入、模型 API 和诊断入口。
- [x] 完成 Agent/provider 领域专项验证：后端相关测试 `305 passed`，未发现因分组造成的回归。
- [x] 完成 RAG/memory 领域的首轮分组，区分记忆写入/迁移、注入预算、RAG 索引/缓存、召回排序、搜索入口和 TS sidecar。
- [x] 完成 RAG/memory 领域专项验证：后端相关测试 `162 passed`，未发现因分组造成的回归。
- [x] 完成 Mind/项目的首轮分组，区分项目服务、Mind API/工具、画布运行时、前端几何状态和项目阶段纯逻辑。
- [x] 完成系统安全的首轮分组，区分认证、ownership、配置密钥、确认门、上传/URL、脱敏和风险策略。
- [x] 完成 Mind/项目与系统安全后端专项验证：`234 passed`，未发现因分组造成的回归。
- [x] 生成按领域展开的逐文件测试明细，包含 owner、层级、依赖、skip 和测试名称；原 `TEST-INVENTORY-DETAILS.md` 继续专门登记 skip 例外。
- [x] 完成第一轮 fixture/构造器审查，登记同名 fake 的方法集合和处置结论；当前不抽取行为不同的万能 fake。
- [x] 抽取已确认无状态且函数体完全重复的 provider 结果构造器和异步适配器到 `backend/tests/helpers/agent_provider.py`，清除最后一组跨文件 exact duplicate。
- [x] 补充函数级 helper 审查，区分跨文件同名与实际重复实现；重复名称仅登记为后续对拍候选。
- [x] 单独登记 `backend/ts/api`、`backend/ts/packages/*/test`、`backend/ts/workers/*/test`，不与 Python pytest 合并统计或移动。
- [x] 对相邻文件逐个记录“保留、合并、改名、删除”的理由，不以文件名相似作为删除依据；领域报告每个文件均有处置依据。
- [x] 对上下文、IM、存储/文件的相邻文件记录首轮“保留/合并/删除”依据；当前没有满足三项相同条件的安全删除候选。
- [x] 继续审查其他重复测试夹具和构造器；除已抽取的 provider helper 外，未发现满足抽取条件的重复实现，保持每个测试的断言直接表达领域契约。
- [x] 仅在两个测试验证同一生产入口、同一输入边界和同一结果时合并用例；本轮没有额外合并项，分层不同的测试均保留。
- [x] 将历史 phase/P2-b 文件改成按领域和行为命名，保留 Git 历史，并保留文件头中的 PRD/迁移来源说明。

验收：每个被合并/删除的用例都有替代覆盖位置；后端全量通过；越权、缓存、上下文顺序和错误脱敏测试数量不得无理由下降。

### Phase 3：前端测试归类与 E2E 清理

- [x] 保留“与实现同目录”的局部纯逻辑测试，保留 `frontend/test` 的跨模块契约测试。
- [x] 将 `frontend/src/assets/styles/*regression.test.ts`、组件回归测试和跨模块纯逻辑测试分别登记，避免把样式回归误计入业务单测。
- [x] 统一 `frontend/scripts` 静态检查脚本的命名和入口说明，不强行改成 Vitest。
- [x] 为同名或相似文件补充测试目标说明，确认不是重复后再决定是否移动；详见 `docs/reports/2026-08-31-FRONTEND-TEST-AUDIT.md`。
- [x] 将当前含长期账号/环境数据依赖的文件 E2E 移出稳定 CI，改由 `test:e2e:experimental` 显式执行；确定性 fixture 化继续作为后续工作。
- [x] 对每个实际 `skip` 记录触发条件、当前状态和下一步；禁止无期限 skip。
- [x] 将稳定 E2E 与实验 E2E 分开执行，保持 CI 只跑确定性关键路径；新增 `test:e2e:stable` 和 `test:e2e:experimental`。

验收：前端 Vitest 用例结果不变；CI E2E 不再出现“跳过即通过”的关键路径；失败信息能定位到具体 fixture 或环境依赖。

### Phase 4：CI 矩阵与长期维护

- [x] 增加 `test:fast`、`test:unit`、`test:integration`、`test:e2e` 和 `test:all` 入口。
- [x] PR 默认执行 L0 + 受影响领域的 L1；主分支和发布前执行 L1 + L2 + L3。
- [x] 每月检查一次测试清单、慢测耗时、失败重试和 skip 到期项。
- [x] 新增测试必须填写领域、层级、生产入口和关键回归行为。
- [x] 测试迁移和删除写入 `docs/devlog/`，不只在 commit message 中说明。

验收：CI 失败能区分代码失败、环境失败和测试分类错误；完整测试仍可一键运行；清单没有失联文件。

## 8. 删除与合并决策门

只有同时满足以下条件，才允许删除或合并测试：

1. 能指出被测的同一个生产入口、同一个输入边界和同一个结果断言。
2. 替代测试已经存在，并且在 CI 或发布门禁中执行。
3. 删除后不会失去用户隔离、权限、数据持久化、缓存前缀、上下文顺序或异常脱敏覆盖。
4. 先运行删除前后的收集清单和受影响专项测试。
5. 在变更记录中写明删除原因、替代测试路径和验证命令。

以下情况禁止合并删除：

- 领域服务测试和 API 路由测试仅因异常名称相同；
- 新旧实现迁移对拍测试；
- 参数化测试覆盖不同 provider、渠道、权限或边界值；
- 安全守卫、确认门、越权、路径穿越和敏感信息脱敏测试；
- 依赖真实进程/Redis/Postgres 的测试，仅因为本地执行慢。

## 9. 验证矩阵

| 批次 | 必跑验证 |
|---|---|
| Phase 0 | collect-only、清单一致性、git diff --check |
| Phase 1 | L0 入口、compileall、ownership、confirm gate、前端 typecheck/strict |
| Phase 2 | 受影响领域 pytest、后端全量 pytest、存储隔离检查 |
| Phase 3 | 前端全量 Vitest、构建、i18n/CSS/UI 静态回归、稳定 E2E |
| Phase 4 | 完整 `test:all`、CI workflow dry-run 或真实 CI、耗时对比 |

当前本地完整基线命令：

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q

cd ../frontend
npm run typecheck
npm run typecheck:strict
npm run test:run
npm run build
npm run i18n:scan
npm run test:css-glass
npm run test:ui-dialogs
```

## 10. 风险与处理

### 合并后边界丢失

以生产入口和责任层建立映射表；服务层、API 层和 E2E 层不因断言内容相似而合并。

### 分层导致 CI 漏测

保留 `test:all` 完整入口，并在主分支/发布前执行；每个 L0/L1 测试都必须属于至少一个完整门禁。

### 测试目录迁移造成导入或 fixture 变化

每个领域单独迁移，优先使用 `git mv`，迁移后立即跑该领域专项和 collect-only；不得批量移动后再一次性排错。

### skip 变成永久债务

清单中记录 skip 原因和到期时间；到期必须改造、移出 CI 或删除，并附替代验收路径。

### 测试数据污染

继续遵守 `agentskills/testing/SKILL.md`：只使用临时目录、内存数据库和合成用户；测试结束检查 `git status` 以及仓库外存储目录。

## 11. 最终完成标准

- [x] 所有测试文件都有领域、层级、owner 和 CI 状态。
- [x] 快速门禁可以独立运行，且不依赖 Docker 或真实第三方服务。
- [x] 完整测试仍可一键运行，结果与基线等价或有记录的契约变化。
- [x] 重复测试已经逐项判定，必要的双层契约测试有说明，真正重复项有替代覆盖。
- [x] E2E 的 skip 和长期账号依赖已清理或明确移出 CI。
- [x] CI 失败能区分代码、环境和测试分类问题。
- [x] `docs/devlog/` 留有每批迁移、合并和删除记录。
