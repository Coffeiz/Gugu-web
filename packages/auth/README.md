# @gugu/auth

负责验证登录凭据、签发和撤销会话、改密及找回密码。密码哈希和会话凭据由认证服务管理。Web Host 负责 HTTP 鉴权、Cookie/CSRF 和速率限制，Desktop 通过远程 API 登录并在本机安全存储会话凭据。

- `@gugu/auth` 提供登录、账号会话状态校验和撤销流程，由 Web Host 注入凭据验证、令牌签发和持久化端口。
- `@gugu/auth/client` 提供 Desktop 使用的远程登录与会话恢复客户端。
- `@gugu/auth/contracts` 提供现有 HTTP DTO 与桌面会话校验。

Web Host 保留 HTTP 鉴权、Cookie/CSRF 和令牌格式。当前会话按账号安全版本撤销，因此 Web 登出会撤销该账号的旧会话。Desktop 退出远程账号仍清除本机凭据。

[Monorepo 账号架构与 API](../../docs/architecture/account-api.md)

## 服务 API

| 入口 | 作用 |
| --- | --- |
| `login(input, ports)` | 验证凭据，记录登录并向可信宿主交付会话凭据 |
| `authenticateSession(identity, lookup)` | 核对已验签身份对应的账号状态和安全版本 |
| `logout(userId, ports)` | 撤销账号会话，随后发布失效通知 |
| `preparePasswordChange(input, currentHash, ports)` | 验证当前密码，生成新哈希及版本递增指令。宿主在同一事务内读锁定记录并写入 |
| `createRemoteAuthClient(fetch)` | Desktop 登录和恢复远程会话 |
| `validatePasswordReset(token, newPassword)` | 检查重置密码长度与令牌是否缺失 |
| `normalizeEmailChangeAddress(value)`、`validateEmailChange(input, account, verifyPassword)` | 规范化并验证邮箱地址，检查当前密码以及新旧邮箱是否相同 |
| `isRecoveryToken(token)` 和恢复流程时间常量 | 校验生成的令牌格式，统一定义有效期和重发冷却时间 |
| `bindRemoteSession(fetch)` | 为业务客户端绑定远程服务器和凭据，禁止跨源与重定向 |

Web Host 当前提供 `POST /api/v1/auth/login`、`GET /api/v1/auth/me` 和 `POST /api/v1/auth/logout`。设置页使用 `POST /api/v1/auth/password/change`，请求包含 `currentPassword` 和 `newPassword`。成功返回 `204` 并续发当前会话 Cookie。资料写入使用 [Users API](../users/README.md)。找回密码和登录邮箱变更的验证规则已接入 Auth。Web Host 继续负责邮件、限流、令牌持久化与消费、凭据写入事务和会话失效通知。

找回密码使用 `POST /api/v1/auth/forgot-password` 和 `POST /api/v1/auth/reset-password`。登录邮箱变更沿用 `/api/v1/auth/email-change/` 下的申请、重发、取消和验证接口。

Desktop 的账号 IPC 方法由 [Desktop Contracts](../desktop-contracts/README.md) 定义，复用本包的远程账号 DTO。

`@gugu/auth/postgres` 提供 `revokeUserSessions(pool, userId)`，原子递增会话安全版本，在提交后返回新版本。Web Host 提供连接和可信用户身份。
