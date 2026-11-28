# Node WebUI 邮箱变更切片

## 改动

- 将请求、重发、取消和公开验证四条邮箱变更路由接入 Node Host；受保护写入使用 Host 认证上下文提供的 owner id。
- PostgreSQL store 在事务内撤销旧申请并写入新 token 摘要；重发只轮换未过期申请。完成验证时按 user→request 锁顺序串行化邮箱变更与新申请，原子更新正式邮箱、递增 `security_version`、标记已用并撤销其它申请。
- 通过 SMTP 发送新邮箱验证邮件及旧/新邮箱安全通知；消息内容不回显 token 或新邮箱。系统邮件可用时，偏好接口同步返回 `emailChangeEnabled`，使现有资料设置 UI 显示入口。
- 增加路由规则、认证守卫、Vite→Node Host、SMTP 内容、偏好能力和隔离 PostgreSQL 集成测试。未改 OSS 路径；OSS 移除由另一会话处理。

## devserver 验证

- Node 26 全包 `pnpm typecheck` 通过。
- Node 邮箱变更、SMTP、偏好和 Vite→Host 定向回归：16 项通过、0 失败；随机 schema PostgreSQL 测试因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，不计为通过。
- Python `test_email_change.py`、`test_auth_token_revocation.py` 与 `test_review_security_regressions.py`：23 项通过。
- devserver 未安装 PostgreSQL 服务端二进制且没有运行中的服务器；未使用 Docker，也未连接应用数据库。Node→PostgreSQL SQL/锁事务的真实执行仍待隔离 PG 环境验收。
- SMTP 使用注入 mock transport；未发送真实邮件。Vite 闭环使用合成 store，验证 Host 认证和路由，不代表真实数据库验收。
