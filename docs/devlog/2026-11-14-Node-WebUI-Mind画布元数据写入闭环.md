# Node WebUI Mind 画布元数据写入闭环

## 范围

Node Host 接入画布列表、创建和更新链路：

- `GET /api/v1/mind/canvases`：当前用户的活动画布，可按 `project_id` 过滤，最多返回 200 条。
- `POST /api/v1/mind/canvases`：创建画布，保留默认标题、空白标题归一化和 owner 项目校验。
- `PATCH /api/v1/mind/canvases/{cid}`：只更新提供的标题或视图数据；显式空值按 Python 行为归一化。
- Undo 与画布写入处于同一 PostgreSQL 事务；live 事件在提交后发布，失败按 best-effort 处理。

实现入口：

- Host 注册：`gugu-webui/src/app.ts`
- 生产组合根：`gugu-webui/src/main.ts`
- 领域行为：`gugu-webui/src/domains/mind/application/mind-canvas-mutations.ts`
- PostgreSQL 事务：`gugu-webui/src/domains/mind/persistence/mind-canvas-mutations-postgres.ts`
- HTTP 路由：`gugu-webui/src/domains/mind/routes/mind-canvas-mutations.ts`

## Python 行为基准

兼容基准为 `backend/app/api/v1/mind.py` 中的 `list_canvases`、`create_canvas`、`update_canvas`，以及 `backend/tests/mind/test_mind_api.py` 的画布归属、默认值、live event 和持久化回归。本轮 Python Mind 模块在 devserver **36/36 通过**。

Node 行为还覆盖：未认证拒绝、按已验证 owner 查询、隐藏其他用户画布、写入 Undo 快照、提交后发布，以及更新时间和视图数据重读。

## 验证

所有测试均在 devserver 原生运行，未使用 Docker：

- Mind Node 定向套件：**14/14 通过，0 跳过**。
- 其中 `tests/host/mind-canvas-mutations-vite.integration.test.ts` 通过 Vite 代理、Node Host 和随机 PostgreSQL schema，覆盖创建、更新、列表重读、owner 隔离和 Undo 落库。
- Mind PostgreSQL 读取集成在随机 schema 中执行；测试后清理由各集成测试执行。
- `corepack pnpm run typecheck`：通过。
- `backend/tests/mind/test_mind_api.py`：**36/36 通过**。
- pytest 后清理了 `backend/` 下的 `__pycache__` 与 `.pytest_cache`；用户配置、全局包缓存和运行数据未触碰。

## 未覆盖边界

本切片只闭环画布列表和画布元数据创建/编辑。画布删除、画布便签创建与编辑、条目位置/层级更新、从画布移除节点、关系创建与删除仍待迁移；因此这不是完整的 Mind 画布编辑工作流。真实 Node `startServer` 组合根的生产数据库配置与 Redis 广播尚未在此切片单独验收；集成测试使用 Host 路由和随机隔离 schema。
