# Node WebUI Mind 画布便签创建与编辑

## 用户路径

Node Host 已接入画布便签的创建和版本化编辑：

- `POST /api/v1/mind/canvases/{cid}/notes`：在自有活动画布中创建 `canvas_note` 节点和初始摆放项；默认标题/正文、标题裁剪、四种色板、便签尺寸限制与 Python 一致。
- `PATCH /api/v1/mind/nodes/{nid}`：只允许更新自有活动画布便签；正文会刷新纯文本、SHA-256 索引哈希并清空 `indexed_at`；版本不匹配返回 409。
- 节点、画布项和 Undo 在同一 PostgreSQL 事务提交；live 事件仅在提交后发布。
- 画布便签保留 `kind='canvas_note'`，列表仍只返回普通 `kind='note'`，不会进入记录时间流。

实现入口：

- Host 和生产组合根：`gugu-webui/src/app.ts`、`gugu-webui/src/main.ts`
- 行为：`gugu-webui/src/domains/mind/application/mind-canvas-note-mutations.ts`
- PostgreSQL：`gugu-webui/src/domains/mind/persistence/mind-canvas-note-mutations-postgres.ts`
- 路由：`gugu-webui/src/domains/mind/routes/mind-canvas-note-mutations.ts`

## Python 行为基准

行为基准是 `backend/app/api/v1/mind.py` 的 `create_canvas_note`、`update_canvas_note`，以及 `backend/tests/mind/test_mind_api.py::test_canvas_note_is_independent_from_record_timeline`、`test_canvas_mutations_publish_canonical_mind_events`。本轮整个 Python Mind 模块 **36/36 通过**。

## 验证

所有验证在 devserver 原生运行，未使用 Docker：

- Mind Node 定向套件：**17/17 通过，0 跳过**。
- Vite → Node Host → 随机隔离 PostgreSQL schema 集成：创建画布、创建便签、编辑内容/标题/颜色、版本冲突、跨 owner 拒绝、重读，以及 Undo 行为均通过。
- 隔离 Mind PostgreSQL 读取用例通过；测试后 `gugu_mind_canvas_read_*` / `gugu_mind_canvas_http_*` 临时 schema 数量为 0。
- `corepack pnpm run typecheck`：通过。
- Python 基线：**36/36 通过**；随后清理了 `backend/` 下 `__pycache__` 和 `.pytest_cache`，剩余 0 个。

Vite 配置在无 `.git` 元数据的 Mutagen 目标上查短 SHA 时会输出 Git 提示并回退到时间戳；该提示不影响测试路由或 PostgreSQL 请求。

## 尚未迁移

便签现在能创建、编辑并在刷新后读取；当前没有拖动/尺寸更新或从画布移除接口，也不能从普通便签/项目/文件/活动引用创建画布卡片。关系增删与画布删除仍走 Python。真实 Node 生产启动组合下的 Redis live 广播仍未验收。
