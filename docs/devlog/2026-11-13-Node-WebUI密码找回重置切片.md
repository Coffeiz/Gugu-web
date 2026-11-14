# Node WebUI 密码找回与重置切片

## 改动

- 将 `/api/v1/auth/forgot-password` 和 `/api/v1/auth/reset-password` 接入 Node Host，邮件发送使用 SMTP；找回请求保持未知账户与发送失败的统一响应，并只向已注册账户返回掩码邮箱。
- 重置 token 使用 Redis 一次性认领，密码变更事务递增 `security_version`，提交后发布认证状态变化并清理认证 cookie。凭据事务失败时恢复仍有效的 token。
- Redis 已保留请求冷却键但 token 写入失败时，释放冷却键，避免一次基础设施写失败阻断用户后续重试。
- 增加配置、SMTP、找回/重置行为和 Vite→Node Host 回归。没有修改 OSS 路径；OSS 移除由另一会话处理。

## devserver 验证

- Node 26 下密码找回、配置、SMTP 和 Vite→Host 定向回归：12 项通过，0 失败；隔离 PostgreSQL Vite 集成 1 项跳过，因为没有配置专用测试库。
- Python 行为基线 `test_auth_token_revocation.py` 与 `test_review_security_regressions.py`：21 项通过。
- 切片文件定向 TypeScript 检查通过。全包 `pnpm typecheck` 被无关的 `tests/agent/agent-group-mentions.test.ts` 语法错误阻断（第 53–57 行）；没有修改该并行模块。
- devserver 没有 PostgreSQL 服务端二进制，且 `pg_isready` 未发现运行中的服务器；未连接或写入应用数据库，也未使用 Docker。因此 PostgreSQL 事务和完整 Vite→Host→PostgreSQL 路径仍未验收。

## 未覆盖边界

- 未进行真实 SMTP 发信；邮件内容和 TLS 配置通过注入 mock transport 验证。
- 桌面端操作收据恢复界面属于 Electron Host 范围，不在本 Web 迁移切片内。
