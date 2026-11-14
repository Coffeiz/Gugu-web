# Node WebUI Local 单文件删除 Host 与 PostgreSQL 验收

## 当前实现

`DELETE /api/v1/files/{fid}` 已由 Node Host 挂载在用户认证域。Host 从认证上下文传递 owner；PostgreSQL adapter 以事务读取当前用户的活动文件，移入 Local 回收站、更新 `storage_key`/`deleted_at`/version、写入 Undo 状态并在提交后发布资源更新。

## 验证

- devserver Node 26 类型检查通过。
- Node 文件删除、Host 接线及隔离 PostgreSQL 定向测试 **23/23 通过，0 跳过**；随机 schema PostgreSQL 用例确认文件被移入回收站、版本递增、Undo 快照保存，并由另一个数据库连接验证资源事件只在事务提交后发布。测试清理 schema 和临时存储。
- Python 参考基线 `tests/storage/trash/test_trash_folders.py` 与 `tests/storage/files/test_files_api.py` 在 devserver 串行 **53/53 通过**。
- 常驻 Node Host readiness 返回 200；Vite 未认证 DELETE 返回 401，确认代理请求进入认证门。没有用真实账户经常驻 Vite 完成删除。
- 未使用 Docker，也未修改运行配置。

## 未完成差异

Python 在文件删除前取得 filesync path advisory lock，Node 当前没有该锁。启用文件目录同步并发生并发更新时，仍可能缺少 Python 路径的协调语义。需要与 filesync 迁移一起闭合；认证后的常驻 Vite 写入也尚未验收。
