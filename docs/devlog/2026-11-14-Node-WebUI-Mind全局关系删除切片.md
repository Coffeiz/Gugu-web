# Node WebUI Mind 全局关系删除切片

## 迁移范围

- 接入 `DELETE /api/v1/mind/relations/{rid}`，仅匹配当前用户拥有且 `canvas_id IS NULL` 的活动关系；画布关系仍由画布限定的删除路由处理。
- 删除使用 PostgreSQL 事务写入软删时间和 Undo 前后快照，提交后再发布 Mind 删除事件。跨用户、画布关系、已删除或不存在的记录统一返回 404。
- 扩展关系快照/响应映射，正确保留 `canvas_id: null`。
- 生产组合根 Vite→Node Host→随机 PostgreSQL schema 集成覆盖 owner 隔离、非法 ID、软删和 Undo 快照。

## 验证

- devserver 关系行为单测与生产 Vite/隔离 PostgreSQL 集成：`6/6` 通过，0 失败、0 跳过。
- `@gugu/webui` typecheck 通过。
- 测试使用随机隔离 schema，结束时由用例删除。
- 测试进程有非致命的 Git 元数据探测 stderr 与 Node `module.register()` 弃用提示；未影响结果。

## 边界

- Python Mind 基线已在同一轮画布删除切片中跑过；本切片未修改 Python 实现。
- 本轮没有验证 Redis 跨进程广播。
