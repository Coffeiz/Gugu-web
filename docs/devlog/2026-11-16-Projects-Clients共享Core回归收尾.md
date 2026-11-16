# Projects/Clients 共享 Core 回归收尾

本轮以当前源码和 Python 参考行为重新核对，补充 6 项回归；没有修改业务实现、Python 后端、Host 组合根或桌面页面。已有联系人 CRUD 双库仓储及项目数据更新路径可复用，无需增加仓储或单 API 适配层。

## 当前实现及实际调用者

| 领域/调用者 | 当前路径 | 本轮结论 |
| --- | --- | --- |
| 项目基础数据更新 | `packages/core/src/projects/service.ts` → `repository.ts`，由共享数据运行时限定 owner 和事务 | PostgreSQL/SQLite 共用；版本递增、CAS、完成时间及日期/阶段校验均在 Core |
| Web 项目 PATCH | `apps/web-host/src/main.ts` 装配公开 `@gugu/core/project-update` 的 `createProjectUpdater`，注入现有 Host PG/Local 适配器 | 已调用 Core 公开用例；HTTP、文件目录和提交后通知留在 Host。本轮未运行完整 Web Host/PG |
| SQLite 项目更新用例 | `createProjectUpdater` → `createKyselyProjectUpdateTransaction` → `SqlProjectRepository` | 新增合同使用 `initializeSqlite` / `openSqliteRuntime` 创建正式 schema 17，未补造项目表 |
| 联系人 CRUD | `packages/core/src/clients/service.ts` → `repository.ts` | 两种适配器共用字段规则、owner 限定、创建时间/ID 倒序、部分更新与显式 null；联系人无版本 CAS，沿用 Python 契约 |
| Web 联系人 | `modules/clients/persistence/clients.ts` → 公开 Core `SqlDataRuntime.transaction` / `DataServices.clients` | 实际 GET/POST/DELETE 都委托 Core；Python 同样没有联系人 HTTP 更新路由，本轮不新增 API |
| 桌面项目/联系人 | Preload 具名 IPC → `apps/desktop/src/main/core-host.ts` → Core Worker 的 `projects.rename`、`clients.create/update/delete/list` | 实际 CoreHost/独立 Node/Worker/正式 SQLite 的 3 个定向用例通过；没有绕过 Core 的接线需要修改 |

## 新增保护及 Python 对照

- `packages/core/tests/fixtures/data-contract.ts` 增加 5 项，同一合同由现有 SQLite 和 PostgreSQL 测试入口调用。项目覆盖公开字段、camelCase 映射、显式 null、阶段持久化、归档、完成时间的设置/保留/清空、owner/墓碑拒绝、缺版本/非法更新、仅 version 的空补丁、同版本竞争和外层事务失败回滚。联系人覆盖 Unicode 码点长度边界、空白保留、可空字段清空、同值更新、删除与收据失败回滚及成功收据重放。
- `packages/core/tests/unit/data/contract.test.ts` 增加 1 项：使用实际桌面命令分派和持久收据更新项目名称及联系人，关闭并重开正式 SQLite，验证字段、版本、删除结果和收据仍在。
- 项目参考 `backend/app/api/v1/projects.py`、`backend/tests/projects/test_projects_core.py`、`test_projects_live_events.py`、`test_project_read_api.py`，以及 `compat/core-python/src/gugu_core/domain/projects.py`。仅带 version 的 PATCH 即使版本陈旧也返回当前记录，不写入或发布；桌面基础服务的空 fields 则明确拒绝，两种入口分别保留既有语义。
- 联系人参考 `backend/app/api/v1/clients.py`、`app/services/clients.py`、`backend/tests/projects/test_core_data_bridge.py`、`backend/tests/core/test_data_runtime.py` 及 Python Core 的 `application/clients.py`、`data/clients.py`、`domain/clients.py`。名称不自动 trim、以码点计长度、contact/email/phone 可空而 notes 不可空；只改提交字段，失败事务不留下部分写入。
- 新增断言验证数据库重读结果和可观察错误，不检查 SQL 字符串。去掉 owner/CAS、错误处理或事务回滚会破坏相应结果；语义等价的仓储重构无需改变断言。

## 本轮实际验证

用户明确允许当前工作环境/WSL 的隔离验收，替代 devserver。所有业务数据库、文件和测试配置使用临时路径或内存合成数据；没有读取或覆盖仓库运行配置。Python 从当前 Git 跟踪源码生成隔离副本，排除 `.env`、`config.override.json` 和数据库，显式设置 `GUGU_ENV_FILE` / `GUGU_CONFIG_OVERRIDE_FILE` 到测试专用路径，串行运行。

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| Core Node 26 定向回归 | 6 文件、71/71 通过 | `unit/data/{contract,client-name-query,data,project-create-usecase}.test.ts`、`golden/{service-sequence,python-interop}.test.ts`；后两者含真实 Python 参考进程与临时库互读 |
| 桌面实际调用者 | 3/3 通过 | `apps/desktop/tests/core-host.test.ts` 按项目改名、联系人改名/删除选择；其余 26 项未选择，不计通过 |
| Python pytest | 57/57 通过、无跳过 | `tests/projects/{test_core_data_bridge,test_projects_core,test_projects_live_events,test_project_read_api}.py`、`tests/core/{test_data_runtime,test_local_runtime}.py`；一条既有 Sudachi 弃用警告 |
| Core 生产构建 | 通过 | `node packages/core/scripts/build.mjs`，含 Sandbox 和 Core TypeScript 编译 |
| Projects/Clients 源码与合同定向 TypeScript 构建 | 通过 | 临时 tsconfig 继承 Core 配置，选择 projects、clients、SQLite/PG 适配器和两种数据库合同入口，含新断言类型检查 |
| PostgreSQL | **未实测** | 无显式隔离连接变量；当前 Windows/WSL 未发现可用 PG 二进制或标准安装目录。没有安装/连接未知数据库，没有用 SQLite 或 mock 替代 PG 结果 |

本机依赖目录仍在旧位置；只恢复忽略目录中的查找链接，构建缺少的已声明 XML 依赖安装到临时目录。依赖声明和 lockfile 未修改；验收后已移除本轮新建的依赖查找链接，保留原有依赖和文件。SQLite 实际使用本机已有 `better-sqlite3 13.0.3`，尚未按声明的 `13.2.0` 重装验证。

标准 Vitest 配置在发现阶段被已有 `tests/agent/skills/user-management-sqlite.test.ts` 未登记阻断。本轮使用测试专用临时配置精确选择上述文件，保留原有 `fileParallelism: false` 和超时；未修改生产测试配置或为恢复绿色改动无关清单。全 Core 测试源码类型检查另被既有 Agent RAG/Skill、IM attention、定时任务等测试错误阻断，不计通过；本切片定向构建通过。

## 保留边界

- SQLite 合同没有装配旧文件库：文件计数端口显式提供 0，不证明真实计数；`createProjectUpdater` 的物理目录改名/文件键联动没有验收。正式 SQLite 无旧 `files`/`project_file_counts` 表，不能把桌面纯数据改名通过写成 Web 文件路径迁移完成。Local 文件生命周期、文件引用/恢复/Undo 仍按原清单另行处理。
- 未实测 PostgreSQL 锁竞争、回滚、排序、时间解析和 Host 组合；共享合同已具备对应执行入口，但只能在可用隔离 PG 上运行后更新为通过。历史 PG 报告不作为本轮证据。
- 未运行 Docker、真实外部 Provider、生产服务或 GitHub CI；未测试 Electron 窗口、跨平台制品和部署。
- 开始时已存在的未跟踪旧目录全部保留；未 reset、clean、提交、推送或格式化无关文件。运行配置和用户数据库保持不动。
