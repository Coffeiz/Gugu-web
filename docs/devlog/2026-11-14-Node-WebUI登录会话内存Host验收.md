# Node WebUI 登录会话 Host 验收

## 范围

验收登录、认证 Cookie、当前用户读取和注销后的会话撤销是否能通过 Vite 代理到 Node Host。测试使用合成账号与内存适配器，不触碰真实用户数据。Python 的认证 Cookie 与 token 撤销 pytest 作为行为基准。

## 结果

- devserver Python 基准：`tests/platform/auth/test_auth_cookies.py` 与 `tests/platform/auth/test_auth_token_revocation.py`，10/10 通过。
- devserver Node 定向回归：登录、注销、`/auth/me` 与 Vite Host 新用例合计 10 项通过。
- devserver Node 类型检查：通过。
- Vite→Node Host 实际请求验证：未认证 `/auth/me` 返回 401；Cookie 登录后 `/auth/me` 返回合成账号；带 CSRF Cookie/header 注销后，旧 Cookie 再请求返回 401。
- 既有 Vite→Node Host→隔离 PostgreSQL 会话集成用例因未设置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，不能计为通过。devserver 本地 PostgreSQL 检查无响应，故本轮没有验收 PostgreSQL 用户查询与撤销存储。

## 当前边界与后续条件

Node Host 的会话 HTTP 路径与撤销行为已通过内存适配器验证；`main.ts` 使用 PostgreSQL 用户仓库的真实数据路径仍未验收。下一步需要 devserver 提供专用隔离 PostgreSQL URL，且测试账号具备创建/删除随机 schema 的权限，再运行 `tests/host/auth-session-vite.integration.test.ts` 及对应 PostgreSQL 适配器回归。没有使用 Docker，也没有连接生产或用户数据库。
