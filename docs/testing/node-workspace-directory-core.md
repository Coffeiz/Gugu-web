# 工作区目录共享边界

目录显示名称的规范化、非法字符限制和系统保留名规则位于 Core `workspaces/directory-name.ts`；Web HTTP 与 PostgreSQL 目录操作复用同一规则。HTTP 仍执行请求格式和原始字段长度检查。

工作区绑定与声明删除的 Kysely 适配器已归入 `packages/core/src/workspaces/`，通过 `@gugu/core/workspaces` 导出；通用 `data/` 不再转发这两个工作区适配器。正式 SQLite 文件模型与 Local 目录身份限制仍按下文处理。

目录创建、绑定、预览和删除的 PostgreSQL 事务以及本地目录、ACL、PTY 操作目前仍由 Web Host 协调；这不代表 SQLite 或 Desktop 已具备同等能力。隔离 PostgreSQL 的实际目录 CRUD、归属、绑定、删除事务和文件操作测试，以及认证和路由错误映射测试均已通过。

当前 PostgreSQL 删除流程直接操作旧 `files`、`folders`、`workspace_directories` 和终端会话表；正式 SQLite schema 没有这些对应表。架构说明要求本地文件以授权根与相对路径定位，因此不能把该 SQL 原样搬入双库 Core，也不能以空操作模拟文件清理。需先有符合该身份模型的 FS 与引用解绑能力，才能安全共享包含物理删除的完整流程。
