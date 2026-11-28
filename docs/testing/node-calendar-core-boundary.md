# 日历写入迁移边界

Web 生产入口将创建、更新和删除装配到 Core 的日历用例及 Kysely PostgreSQL 存储；Core 另有 SQLite 实现。提交后的通知仍由 Web Host 提供。

旧 PostgreSQL 创建、更新和删除适配器已移除。原有日历测试改用真实 Core PostgreSQL 存储，覆盖所有权、事务、幂等、Undo、并发和提交后副作用；Vite API 代理集成通过独立 Core 连接与生产 Host 验证并发索引任务。临时 Vite 环境仅验证 API 代理，不代表前端构建验收。

Core 创建、更新、删除与读取的 SQLite/PostgreSQL 定向测试共 12 项通过，覆盖数据隔离、版本竞争、提醒和 Undo 回滚。
