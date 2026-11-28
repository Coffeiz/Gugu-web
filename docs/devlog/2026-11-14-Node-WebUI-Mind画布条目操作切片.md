# Node WebUI Mind 画布条目操作

## 用户路径

Node Host 已接入现有节点加入画布、条目更新、置顶和移除：

- `POST /api/v1/mind/canvases/{cid}/items`：仅允许把当前用户拥有的活动节点加入自有活动画布；重复加入返回已有条目，不重复写 Undo。
- `PATCH /api/v1/mind/canvases/{cid}/items/{iid}`：更新位置、尺寸、层级、折叠状态或画布数据；画布便签尺寸继续遵守 Python 的边界。
- `POST /api/v1/mind/canvases/{cid}/items/{iid}/bring-to-front`：一个事务内重排活动条目的 z 值并更新目标坐标。
- `DELETE /api/v1/mind/canvases/{cid}/items/{iid}`：软删除画布条目、记录需要脱离的关系并提交 Undo；底层便签节点和普通记录时间流保持不变。
- 写入及 Undo 原子提交后才发布 Mind 变更事件，并保留 `x-client-id`、`x-mutation-id` 元数据。

实现入口：

- Host 和生产组合根：`gugu-webui/src/app.ts`、`gugu-webui/src/main.ts`
- 行为：`gugu-webui/src/domains/mind/application/mind-canvas-item-mutations.ts`
- PostgreSQL：`gugu-webui/src/domains/mind/persistence/mind-canvas-item-mutations-postgres.ts`
- 路由：`gugu-webui/src/domains/mind/routes/mind-canvas-item-mutations.ts`

## Python 行为基准

对照 `backend/app/api/v1/mind.py` 的 `add_canvas_item`、`update_canvas_item`、`bring_canvas_item_to_front`、`remove_canvas_item`，以及：

- `backend/tests/mind/test_mind_api.py::test_canvas_item_keeps_note_global_and_duplicate_add_is_idempotent`
- `backend/tests/mind/test_mind_api.py::test_soft_deleted_canvas_item_is_hidden_and_blocks_relations`
- `backend/tests/mind/test_mind_api.py::test_canvas_rejects_other_users_node_and_keeps_canvas_private`
- `backend/tests/mind/test_mind_canvas_tools.py::test_update_and_remove_canvas_item_only_change_view`
- `backend/tests/mind/test_mind_canvas_tools.py::test_removing_canvas_item_detaches_relation_without_deleting_global_relation`

## 验证

所有测试在 devserver 原生运行，未使用 Docker：

- Mind Node 定向套件及两条 Vite 隔离 PostgreSQL 集成：**42/42 通过、0 失败、0 跳过**。
- 一条集成进入依赖注入 Host，验证重复添加幂等、条目更新、置顶后的坐标/z、关系脱离、软删除后便签仍保留，以及 Undo 写入数。
- 另一条集成通过生产 `startServer` 组合根验证未认证请求被拒、画布创建、条目增删改及普通记录仍可读取。
- `corepack pnpm run typecheck`：通过。
- Python Mind API、画布工具、布局与 Undo 基线串行运行：**68 passed**。
- 两种 Vite 集成使用随机隔离 PostgreSQL schema；复查残留数为 0。Python 测试后清理了 `backend/` 下 `__pycache__` 与 `.pytest_cache`。

### 当前树复验

- 修正 `mind-ref-node-create-postgres.ts` 的 adapter 返回类型，使其准确表达 bigint 字符串已规范化为数字；新增 PostgreSQL adapter 回归，保护字符串 ID 的运行时映射。
- devserver Node WebUI typecheck 通过；Mind 画布/引用节点定向 Node 与两条 Vite 隔离 PostgreSQL 集成 **25/25 通过、0 失败、0 跳过**。
- Vite→生产 `startServer`→Node Host→隔离 PostgreSQL 覆盖画布/条目读写、软删保留普通记录、project/file/event 引用、引用幂等、关系创建/删除、owner 隔离；注入 Host 集成覆盖画布便签和置顶操作。
- 对照 Python 基线文件 `test_mind_api.py`、`test_mind_canvas_tools.py`、`test_canvas_layout.py`、`test_undo_mind.py` 串行运行：**68 passed**。测试通过 `compat/core-python/src` 加载仓库自带的 Python Core；使用既有 devserver pytest 环境，未修改运行配置。
- 受影响的项目/日历生产组合根 Vite/隔离 PG 集成补跑：**1/1 通过、0 跳过**；Mind、项目/日历相关随机 schema 复查残留 **0**。
- `ripwire --quality-delta` 在共享 Mind 改动中报告三个 PostgreSQL runtime 工厂共用事务包装的 2 条门禁级重复项；本切片只修复 ID 类型契约，保留该结构债务供后续协调收敛。
- Redis 跨进程广播仍未验收。

Vite 在没有 `.git` 元数据的 Mutagen 目标上输出短 SHA 查询提示并回退到时间戳；两条 Vite/Host/PostgreSQL 集成均完成并通过。

## 当前边界

这条切片覆盖画布元数据、便签、已有节点卡片的放置和生命周期，以及引用节点和关系 API。画布删除、搜索建议与完整前端拖动/尺寸交互仍需单独迁移和验收。Redis 跨进程实时广播未在本轮验证；数据库写入、owner 隔离和 Undo 已通过隔离 schema 的 Vite/Host 集成验证。
