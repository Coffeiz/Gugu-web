# Node WebUI 项目与日历当前树复验

## 范围

复核项目 PATCH、DELETE/restore、Local 回收站路径、日历创建事务与提交后副作用，以及 Vite 到 Node Host 的受保护路由。测试在 devserver 执行，不使用 Docker。

## 验证

- devserver Node 26.13.1 下，项目/日历定向套件及两条 Vite 集成路径共 102 项：102 通过、0 失败、0 跳过。PostgreSQL 测试只在随机临时 schema 中运行，结束后查询残留数为 0。
- Python 兼容基线串行运行 10 个文件：项目 Core、项目回收站、Undo、项目 live events、创建幂等、live origin、事件原子更新、事件提醒更新、事件总线、日历提醒，共 87 passed、0 skipped。通过仓库 `compat/core-python/src` 加载 Python Core。
- `@gugu/webui` typecheck 与 build 均通过。测试实际启动 Vite，并分别验证注入适配器路径和 `src/main.ts` 生产组合根路径。
- `project-calendar-main-vite.integration.test.ts` 通过 Vite 请求生产 `startServer` 组合根，以合成用户和隔离 PostgreSQL schema 验证项目 PATCH、Local 目录改名、DELETE/restore 与关联文件物理往返，以及日历创建、Undo 和 durable RAG job 持久化。使用临时配置文件与临时 Local 目录，没有修改真实用户记录或运行配置。
- 集成运行输出中出现 `fatal: not a git repository` stderr；测试仍完成并通过。当前源码检索未定位到发出该信息的调用点，需在后续确认是否来自测试进程或开发工具初始化。

## 未验收项

- Redis 跨进程实时广播及 Node durable RAG job 到 Python Worker 的同库消费仍未做端到端验收。

## 后续复验

- 当前树在 devserver 重跑项目/日历 Node 套件为 102 项：73 通过、0 失败、29 个依赖 PostgreSQL 的用例因当前 shell 未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过。此结果不能替代上面的 102/102 全通过记录。
- 项目/日历 Python 基线在 devserver 串行重跑仍为 87/87。项目/日历 Vite 隔离 PostgreSQL 主流程本轮未能重跑；此前记录的 Vite→生产 Node 组合根→隔离 schema 验收仍是最后一次已完成的 PG 证据。
- 项目/日历集成测试及 Agent RunStore 测试的定向 TypeScript 检查通过。Local 文件归档适配器的先前类型错误已由并行工作区修复；最新 devserver 全量 `@gugu/webui` typecheck 通过。

## 2026-11-14 主路径补偿与日历当前树复跑

- 项目切片：devserver Node 26.13.1 项目套件 58 项，54 通过、4 个 PostgreSQL 用例因隔离测试库 URL 未配置跳过、0 失败；项目 PATCH/DELETE/restore 的 Python 核心、live events、trash 对照 33/33；WebUI typecheck 通过。DELETE/restore 事务提交失败时新增文件系统反向移动补偿。详见[项目删除/恢复事务回滚补偿](./2026-11-14-Node项目删除恢复事务回滚补偿.md)。
- 日历切片：当前 devserver Node 日历/Host/Vite 定向集合 47 项，22 通过、25 个 PostgreSQL/Vite 集成用例因隔离测试库 URL 未配置跳过、0 失败；Python 幂等、live origin、事件更新/提醒/总线基线 32/32；当前 WebUI typecheck 通过。
- 运行态烟测：当前 Vite 首页与 Node `/health/ready` 均返回 200；经 Vite 请求未认证 `/api/v1/events`、`/api/v1/projects` 均返回 401。这证明代理到 Node Host 且路由受认证保护，不证明认证后的 Core/PG 写入。
- 旧的完整 Vite→生产组合根→随机 PG schema `102/102` 是此前工作树证据。本轮 PostgreSQL 测试均被跳过，不能把旧结果作为当前树数据库验收；Redis 跨进程广播与 durable RAG job 被 Python Worker 消费仍未验收。

## 2026-11-14 当前树真实 PostgreSQL/Vite 复验

- Node 26.13.1 在 devserver 对 `tests/projects/*.test.ts`、`tests/calendar/*.test.ts`、`tests/host/project-calendar-main-vite.integration.test.ts` 与 `tests/host/project-calendar-vite.integration.test.ts` 执行定向回归：`105/105` 通过、0 失败、0 跳过。测试进程临时把只读运行配置中的 DB 地址传给 `GUGU_WEBUI_TEST_DATABASE_URL`，每项 PostgreSQL 集成使用随机隔离 schema；没有改写运行配置。
- 两条 Vite 集成均成功：一条启动生产 `startServer` 组合根并验证项目 PATCH、Local 目录改名、DELETE/restore 和日历创建；另一条验证项目、日历和正文保存主链路。测试通过后各自执行 schema/临时目录清理。
- Python 兼容基线在 devserver 串行运行 10 个文件：`tests/projects/test_projects_core.py`、`tests/projects/test_projects_live_events.py`、`tests/projects/test_project_trash.py`、`tests/projects/test_undo_phase4.py`、`tests/api/test_create_idempotency.py`、`tests/agent/test_live_write_origins.py`、`tests/scheduling/events/test_event_atomic_update.py`、`tests/scheduling/events/test_event_update_reminders.py`、`tests/scheduling/events/test_event_bus.py`、`tests/scheduling/calendar/test_calendar_reminders.py`，共 `66 passed`。
- `corepack pnpm run typecheck` 通过。集成输出仍有 `fatal: not a git repository` stderr 和 Node `module.register()` 弃用提示；它们未使测试失败，stderr 来源尚未定位。
- 本轮补齐了项目 PATCH、DELETE/restore、Local 文件系统补偿，以及日历创建事务和提交后效果在 Vite→生产 Node Host→随机 PostgreSQL schema 的当前树证据。Redis 跨进程广播与 durable RAG job 被 Python Worker 消费仍待验收。
