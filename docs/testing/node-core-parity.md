# Node Core 同逻辑回归与分层映射

本清单覆盖已经迁移的项目/联系人 Core、SQLite/PG、Worker/传输与桌面 Host。未迁移的 Web 事务、撤销、文件联动、Agent/Provider 不以 Node 对照用例冒充完成。整体状态见 [迁移清单](../refactor/Gugu-2.0-架构与迁移任务清单.md)。

| 行为与边界 | Python 参考 | Node 回归（路径相对 Core） | 分类 |
| --- | --- | --- | --- |
| 项目字段、日期、阶段/待办身份 | `backend/tests/projects/test_projects_core.py`；Python Core `domain/projects.py` | `unit/domain/domain.test.ts`、`fields.test.ts`；42 组共享语料 | 快速 L0；跨语言语料另为 process / slow |
| 联系人创建/部分更新/null/长度/删除与不存在 | `backend/tests/core/test_data_runtime.py`、`test_core_data_bridge.py` | `fixtures/data-contract.ts` 在 `unit/data/contract.test.ts` 与 `integration/postgres/contract.test.ts` 共用 | SQLite 快速 L1；PG external_service / slow / L2 |
| 项目更新公开字段、跨 owner/墓碑、空补丁、完成时间、CAS 与失败回滚 | `backend/app/api/v1/projects.py`、`test_projects_core.py`、`test_projects_live_events.py`；Core `domain/projects.py` | 同一 `fixtures/data-contract.ts` 调用 `createProjectUpdater` 与真实 Kysely 事务；桌面命令另验证改名、联系人更新/删除和重开收据 | 正式 SQLite 已实测；本轮 PG 因无可用隔离实例未运行，文件计数/目录联动不在该合同内 |
| 全仓储 owner 隔离、CAS、完成时间与回滚 | `test_data_runtime.py`、`test_postgres_projects.py`、`test_core_project_bridge.py` 的已迁移规则 | 原 data/postgres 断言保留；共用契约补联系人越权、跨域修改回滚、归档/墓碑、稳定排序和关闭终态 | 同一数据契约双库执行；Web Session 接缝仍待 N3 |
| SQLite 初始化、坏库拒绝、备份升级与重开 | `test_local_runtime.py`、`test_data_runtime.py` | `unit/data/data.test.ts`、`exclusive.test.ts`、`golden/python-interop.test.ts` | 临时 SQLite 快速 L1；Python 重读/恢复为 process / slow |
| Worker、stdio、取消/关闭、崩溃与未知提交状态 | `test_desktop_ipc.py`、`test_local_runtime.py` | `integration/runtime/local-ipc.test.ts`、`transport.test.ts`；桌面 `core-host.test.ts` | process / slow / L2；保留满队列、并发关闭及旧协议安全断言 |
| 收据与执行策略等 Node 新边界 | Python 无同款 schema v3 收据/Executor | 收据、端口对照、Executor 授权/确认/不降级/限额/取消、Host 脱敏 | 独立契约，不为机械对照删除保护 |
| 相同维护序列的结果与错误类别 | `backend/tests/core/fixtures/node_golden.py` 使用冻结 Python Core | `golden/service-sequence.test.ts` 的 16 步维护序列 | process / slow / parity，另有独立终态断言 |
| Electron 进程、Preload、来源与更新 | 复用的 Host 安全与恢复契约 | `gugu-desktop/tests/` 与真实目录包 `scripts/smoke.ts` | Host 契约及三平台真实制品；不把 mock 当 OS 隔离证明 |

Node 路径均在 `gugu-core/tests/`，桌面行除外。`layer` 与依赖 marker 分开；Golden 是用途，不替代 process 标记。只使用合成输入、新建临时目录/隔离 schema，不连接用户配置、数据库或真实 Provider。

## 联系人模块的实际调用方

- 共享校验和数据用例位于 Core；`fixtures/data-contract.ts` 对 SQLite 与 PostgreSQL 共用联系人创建、更新、删除、owner 隔离及失败回滚契约。Web API 由 `apps/web/src/services/api.ts` 调用，Host 的 `modules/clients/routes/clients.ts` 从认证上下文取 owner，并通过 `modules/clients/persistence/clients.ts` 进入 Core 数据服务；API 清单和隔离 PG/Python 结果见 `docs/refactor/Gugu-2.0-Node-WebUI-API迁移清单.md` 联系人三行。
- 桌面 Preload/Renderer bridge 提供联系人读取和创建，Main 将其转为 `clients.list` / `clients.create` Core 命令；`apps/desktop/tests/core-host.test.ts` 覆盖同一 SQLite 实例的写入、关闭后重开和回读。桌面未暴露删除入口，不把未暴露的操作记为桌面调用方接通。
- Web Host Agent 联系人注册器直接使用 Core `createClientTools`；仅供旧 Host 单测调用的 `agent-client-tool.ts` 创建/更新转发层及对应测试已删除，Core 侧 SQLite 工具回归覆盖这些调用行为。当前树在 devserver 的定向结果：Core 临时 SQLite 数据合同 11/11、Core Agent 联系人工具 16/16、Web Host 联系人路由 4/4、Python `test_core_data_bridge.py` 3/3；运行前相关本地与远端源码 SHA-256 一致。PostgreSQL 测试 URL 当前未提供，本轮未重跑隔离 PG；既有 PG 证据保留在 Node WebUI 联系人 devlog。桌面 CoreHost 回归本轮未启动：devserver 桌面包缺少 Vitest，不能计入本轮通过。
- 因此，联系人规则、双库适配、Web 调用方和现有桌面读写调用方已有代码与回归；项目文件计数、跨文件恢复和 Undo 仍是独立未完成缺口，不能由联系人完成状态推断。

## 文件读取适配测试边界

Core 的 `openAuthorizedRelativeFile` 只依赖 Host 注入的文件打开端口；使用 `packages/fs` 真实本地文件适配器的组合测试位于 `apps/web-host/tests/files/local-file-read.test.ts`，不让 Core 测试直接导入其他 workspace 包的源码。该测试拒绝越界路径和符号链接，并确认系统读取错误原样传播。2026-11-15 devserver 验证：Core 测试 TypeScript 项目 `tsc -p tsconfig.tests.json` 通过，Web Host 全量类型检查通过，文件读取定向回归 1/1 通过；运行前 Core/Web Host 源码与测试树本地、远端哈希一致。

## 已有语义差异

| 差异 | Python 参考 | Node 处理 |
| --- | --- | --- |
| 名称超过 200 个 Unicode 码点 | 纯 Core helper 可原样接受，HTTP/界面另有限制 | 既有 Node 规则拒绝；`project-name-limit` 分别锁定两端结果 |
| 数字 `archived: 1` | 旧 helper 原样保留 | 既有 Node 规则只接受布尔；`archive-boolean` 单独断言，不归一化为相等 |
| 布尔进度、非法列值、超安全整数编号 | Python 类型/整数范围不同 | 保留 Node 明确拒绝和原有回归，不为绿色放宽规则 |
| schema v3 收据、Worker 生命周期 | Python 没有同款 API | 独立契约；v2 互读后显式备份升级，旧 Python 不写 v3 |
| Web 撤销、文件事务、完整 Agent | 尚未切换 Node 写路径 | 待功能迁移，继续保留 Python 生产路径和回归 |

服务序列只归一化两个独立库生成的 owner 和动态时钟；ID、版本、排序、错误类别、null 和副作用保留。固定时钟下的微秒、隔离与时间边界由双库/编码回归独立保护。

## 选择与验收

`tests/suites.json` 是 Core 的显式分类事实源。快速表达式为 `not slow and not external_service and not process and not e2e_support`；集成为四项并集，process / external_service 自动包含 slow。回归证明 unit 与 integration 无交集、并集完整，ipc 不含 PG/Python。空选择、未登记文件、所需服务/参考解释器缺失都失败。

`test:all` 每个文件只执行一次；Linux Core job 运行完整 SQLite/PG/进程/parity，桌面矩阵运行 unit、ipc、Host 契约及真实制品。不同平台不能相加成“业务覆盖数”。根 fast/affected 选择快速和必要边界子集，不自动接真实服务。

最终精确提交的两项 CI 结果记录在 [PR #118](https://github.com/Coffeiz/Gugu-web/pull/118)。测试实现、CI 通过、PR 合并和正式发行分别验收。

## 文档约束的补充行为回归

| 约束来源 | 新增可观察断言 | 执行位置与层级 |
| --- | --- | --- |
| 架构清单 §3：相同操作 ID/内容重读原结果，内容不一致冲突 | 字段顺序变化仍返回原收据；方法或值变化必须冲突，数据库仅保留原记录与原收据 | 共用 `fixtures/data-contract.ts`；SQLite L1 / PG L2 |
| N1：所有者隔离及持久收据 | 不同用户使用相同操作 UUID 可各自提交；提交前看不到另一用户收据，提交后查询只得到自己的数据与收据 | 同一契约在 SQLite/真实 PG 执行 |
| N1：CAS、错误终态与恢复 | 过期版本失败不留下收据、不修改数据；重读后同 UUID 可成功提交，重放成功操作不再次递增版本 | 同一契约在 SQLite/真实 PG 执行 |
| N2：同一数据库仅有一个桌面运行时 | 第二个真实 Host 启动明确拒绝，原 Host 仍可读写；释放后新 Host 能接管并重读原项目/联系人 | `gugu-desktop/tests/core-host.test.ts`，真实 Node 进程 / L2 |
| N2：未知提交状态不自动重放修改 | 真实 Worker 提交并保存收据后，故障 Host 不发送回包就退出；客户端得到操作 UUID，重启仅查询收据即可恢复，数据库只有一条记录 | 同上；不以伪造成功响应替代持久化证明 |

这批收据行为属于 Node schema v3 的独立契约，Python 没有对应 API，不作为跨语言等价数量。原有安全及失败断言保留。对字段顺序规则做了可逆故障抽查：临时移除规范化排序后，新用例如期失败，随后原样恢复生产源码；探针不进入提交或 CI。
