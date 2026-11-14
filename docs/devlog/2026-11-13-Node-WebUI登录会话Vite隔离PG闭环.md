# Node WebUI 登录与会话 Vite/隔离 PostgreSQL 闭环

## 前端路径与 Host 行为

前端 `useAuthStore.login()` 以 `X-Auth-Transport: cookie` 调用 `/api/v1/auth/login`，随后读取 `/api/v1/auth/me` 恢复会话。Node Host 根据账户凭据签发 HttpOnly access cookie 与可读 CSRF cookie；用户记录、最近活跃状态和登录事件由 PostgreSQL repository 提供。

新增 `gugu-webui/tests/host/auth-session-vite.integration.test.ts`，以随机 schema 和合成用户启动真实 Node Host，再启动 Vite 并通过实际代理完成登录、会话读取和退出。测试验证响应不泄漏 bearer token、cookie 属性符合浏览器契约、`web_login` 事件持久化、CSRF 保护的退出清除两枚 cookie、security version 增加且旧会话立即失效；测试结束后关闭服务、删除隔离 schema。

## Python 行为基准

devserver 原生串行 pytest：

- `backend/tests/platform/auth/test_auth_cookies.py`
- `backend/tests/platform/auth/test_account_status.py`
- `backend/tests/platform/auth/test_auth_token_revocation.py`

共 **11/11 通过**。Python 源路由为 `backend/app/api/v1/auth.py` 的 `login`；pytest 覆盖 cookie/CSRF、活跃账户与会话撤销语义，仓库当前未发现 Python 登录 handler 的专门 route test。

## 验证结果

- Node `auth-login.test.ts`、`auth-route.test.ts`、`auth-logout.test.ts`：**9/9 通过**。
- `auth-revocation.test.ts` + Vite → Node Host → 随机 PostgreSQL schema 登录/会话/退出集成：**2/2 通过，0 跳过**。
- `@gugu/webui` typecheck：通过。
- 测试均在 devserver 原生运行；未使用 Docker、未触及运行配置、未触发 CI、未提交。

Vite 启动时版本脚本在无 `.git` 元数据的同步目录打印 Git 错误后回退时间戳；不影响测试。Vite 项目配置属于另一会话当前改动范围，本切片没有改动该配置。

## 边界

这证明前端所用的 cookie 登录、会话恢复与退出撤销能经 Vite 到达 Node Host 并读写隔离 PostgreSQL，不代表生产 Redis 限流和跨进程实时广播或邮箱验证码注册可用；这些基础设施和邮件路径仍需独立验收。
