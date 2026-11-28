# Admin 管理能力归入 Web Host

自部署管理业务及 PostgreSQL/Redis 适配从临时独立 Admin 包迁入 `apps/web-host/src/modules/admin/`。Web Host 原有 HTTP 路由、管理员身份、连接装配及生命周期继续调用同一实现；普通业务共用能力保留在 Core。移除独立包的 workspace、构建及容器装配，未来 SaaS 后端在独立仓库设计与维护。

代码位置只决定发布和维护边界，不能替代认证、授权、租户隔离、凭据保护和安全更新。现有自部署全局查询与固定 Redis 键不提供 SaaS 租户隔离。

验证：Web Host 生产源码类型检查与冻结锁文件检查通过；隔离 PostgreSQL 和 Redis 的定向合批 43 项通过，覆盖管理员鉴权、用户冻结/解冻和事务回滚、用量查询、记忆预览/应用、索引任务及配额租约。临时服务和测试目录已清理；真实部署、Docker 镜像以及未来 SaaS 的权限模型未验收。
