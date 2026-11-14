# Node WebUI Mind 关系与引用节点写入切片

## 范围

将画布关系创建/删除和业务引用节点创建接入 Node WebUI。没有修改 OSS 支持；OSS WebUI 移除由另一会话负责。

## 行为

- `POST /api/v1/mind/relations` 只接受归属当前用户、且两端都已放入同一活动画布的节点。无向 `related` 关系按节点 ID 归一，默认幂等；`allowParallel` 可创建独立平行边。自连接、缺少画布条目和越权/缺失资源沿用 Python 的 422/404 语义。
- `DELETE /api/v1/mind/canvases/{canvasId}/relations/{relationId}` 同时校验活动画布、关系归属和画布 ID，关系以软删除保留主键；以后重复创建同一默认边时恢复该关系。
- 关系变更和 Undo 写入同一 PostgreSQL 事务；只有事务提交后才发送 Mind 资源变更通知。幂等创建仍按 Python 路由行为记录 Undo 并发送创建通知。
- `POST /api/v1/mind/nodes/ref` 支持项目、文件和活动。目标和复用的引用节点按用户归属读取；项目快照保存联系人、状态和日期，文件快照保存扩展名，活动快照保存日期与起止时间。已有活动引用节点直接复用；只有首次创建会写 Undo 并发送通知。

## 验证

全部在 devserver 原生运行，没有使用 Docker。

- `corepack pnpm --dir gugu-webui run typecheck`：通过。
- Mind Node 定向套件及生产 `main.ts` Vite→Node Host→隔离 PostgreSQL 集成：49/49 通过，0 跳过。覆盖关系幂等、平行边、自连接拒绝、跨画布删除隔离、软删除恢复；覆盖三类引用快照、重复引用复用、跨用户隐藏及 Undo 只记一次。
- Python 对照 `test_mind_api.py`、`test_mind_canvas_tools.py`、`test_canvas_layout.py`、`test_undo_mind.py`：68 通过；出现 12 条既有 Redis `setex` 弃用警告。
- 集成测试后的 Mind 随机 PostgreSQL schema 数为 0；backend 的 `__pycache__` 和 `.pytest_cache` 已清理。

Vite/Node 启动日志仍会出现非致命的 Git 仓库探测错误（devserver 同步目录不带 `.git`）；隔离数据库行为测试均通过。尚未验证 Redis 跨进程实时通知。本切片没有迁移旧的非画布 `DELETE /api/v1/mind/relations/{rid}`。
