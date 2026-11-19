# Admin 模块边界

HTTP 路由负责管理员认证、请求解析与响应映射；管理业务和自部署数据操作按功能放在本模块。PostgreSQL、Redis、文件系统和外部服务由 Web Host 装配，自部署专属的配置、运行环境与服务生命周期继续留在 Host。

管理查询包含平台级全局数据；当前仅供自部署管理员使用。普通业务共享的规则留在 Core，例如邮件地址校验和收件人类型。不能通过 Admin 路由或客户端输入绕过业务授权和管理员认证。

## 文件组织

文件按管理功能命名。`users.ts`、`audit.ts`、`logs.ts`、`analytics.ts` 和 `usage.ts` 分别负责用户、审计、日志和统计入口；`auth.ts` 和 `errors.ts` 负责管理员认证及 HTTP 错误映射。

- 模型与语音：`llm.ts`、`llm-settings.ts`、`llm-strategy.ts`、`llm-probe.ts` 和 `voice.ts`。
- 配置与出网：`config.ts`、`prompts.ts`、`prompt-files.ts`、`network.ts`、`network-reader.ts`、`network-update.ts`。
- 邮件与检索：`email.ts`、`smtp.ts`、`search.ts`；存储与执行环境由 `storage.ts`、`runtime.ts`、`sandbox.ts` 和 `ops-monitor.ts` 负责。
- 记忆与索引：`memory.ts`、`memory-preview.ts`、`memory-apply.ts`、`memory-cleanup.ts`、`memory-store.ts`、`index-rebuild.ts`、`embedding.ts`、`embedding-probe.ts`；预览、应用和重建批次与各自功能入口放在一起，Host 提供本地文件、Provider、数据访问和生命周期。感知管理位于 `perception.ts`。

历史实现中同名功能的调用方与契约不完全相同，按实际职责保留独立文件；测试、认证与提交后副作用随原有调用路径维护。`app.ts` 继续挂载现有注册函数，没有新增通用路由转发层。

## 管理业务与平台适配

用户、审计、统计、邮件、记忆和索引任务按功能组织；`user-management.ts` 负责用户管理数据操作，`user-status.ts` 负责账户状态及其事务。Host 负责可信管理员认证和授权、连接生命周期、本地文件、Provider 和任务启停。现有全局查询与固定 Redis 键仅面向自部署平台级管理，不提供 SaaS 租户隔离或租户管理员权限；未来 SaaS 后端及其数据和授权模型独立设计。
