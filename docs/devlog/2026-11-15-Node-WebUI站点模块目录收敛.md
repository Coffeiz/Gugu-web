# Node WebUI 站点模块目录收敛

将站点公开配置和前端埋点从旧 `domains/site` 迁至 `modules/site`。更新 Fastify 路由注册、配置投影、PostgreSQL 装配和持久化集成测试的真实导入；旧目录已删除，仓库内无旧路径引用。

公开配置与埋点依赖 Web HTTP、认证和 PostgreSQL，属于 Host 专属模块，不导出到 `@gugu/core`。API 路径、请求/响应、认证归属和持久化语义未改变。

devserver 定向站点路由回归 6/6 通过，覆盖公开配置默认值、认证用户绑定、Python 兼容截断、输入拒绝及持久化失败不确认。Web Host 全量类型检查通过。PostgreSQL 组合测试未运行，因此埋点适配器的隔离数据库执行未在本切片复验。
