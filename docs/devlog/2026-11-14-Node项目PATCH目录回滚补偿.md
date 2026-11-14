# Node 项目 PATCH 目录回滚补偿

## 问题

项目改名会在 PostgreSQL 事务内先移动 Local 项目目录，再更新项目字段、文件 `storage_key` 和 Undo。若之后的数据库写入或事务提交失败，数据库会回滚，但文件系统无法参加 PostgreSQL 回滚，目录可能留在新名称而数据库仍指向旧路径。

## 修复

项目更新应用服务在目录移动前记录旧、新前缀。事务失败时用同一 Local 目录移动入口反向移动整棵目录树；原始事务错误保持原样返回。若反向移动本身失败，则返回经过控制的 `busy` 错误，避免把异常细节暴露给调用方。

## 验证

- devserver Node 项目 PATCH、Local 目录与 route 定向套件：18 项中 17 通过、0 失败、1 个隔离 PostgreSQL 用例跳过。
- 新回归验证 Undo 写入失败后数据库状态未变、Local 目录移动被反向执行；另验证目录树可按相同 Local 操作完整移回。
- devserver Python 基线 `test_projects_core.py` 与 `test_projects_live_events.py`：28/28 通过。
- devserver WebUI `typecheck`：通过。
- `git diff --check`：通过。

本轮没有可用的隔离 PG 测试 URL，因此未重跑认证 Vite→Node Host→PostgreSQL 路径。此前完整项目/日历 PG/Vite 验收仍是当前树的最近一次真实数据库证据。项目删除/恢复的多文件物理移动补偿仍需单独收尾并在最终集中回归中验证。
