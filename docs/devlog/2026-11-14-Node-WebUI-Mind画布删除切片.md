# Node WebUI Mind 画布删除切片

## 迁移范围

- 迁移 `DELETE /api/v1/mind/canvases/{cid}` 到 Node Host/PostgreSQL。
- 删除事务 owner-scoped 锁定活动画布，软删画布及该画布的全部条目，并软删活动连线。画布便签节点与普通全局节点正文保留。
- 请求包含 Undo context 时，在同一事务内记录画布、全部条目、关系和画布便签节点的完整前后快照。删除事件只在事务提交后发布。
- 补充认证 Host 行为测试及生产 Vite→Node Host→随机 PostgreSQL schema 集成，覆盖 owner 隔离、子项/连线状态、便签正文保留和 Undo 快照。

## 验证

- devserver Node Mind 单元、Host 与 Vite/隔离 PostgreSQL 集合：`51/51` 通过，0 失败、0 跳过。
- devserver Python Mind API、画布工具、布局和 Undo 对照基线：`68 passed`；有 12 条既存 Redis `setex` 弃用警告。
- `@gugu/webui` typecheck 通过。
- Mind 测试 schema 残留为 0；Python `__pycache__` / `.pytest_cache` 清理后目录数为 0。
- Vite 集成启动仍输出非致命的 Git 元数据探测错误，Node 同时输出 `module.register()` 弃用提示；它们未影响验收结果。

## 边界

- 本轮没有验证 Redis 跨进程广播；只验证 Host 提交后的事件调用边界。
- 工作区仍有其他并行切片和既有改动，本轮未提交。
