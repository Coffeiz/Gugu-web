# Node WebUI 资料设置 Vite 与 PostgreSQL 闭环

## 范围

将登录后的资料与密码设置作为 Node Host WebUI 迁移切片，沿真实 Vite 代理请求验证 `/auth/me` 和 `PATCH /auth/profile`。本次只覆盖登录用户的显示名称、时区、邮件订阅和密码更新；不涉及 OSS，2.0 已确定移除 WebUI 对 OSS 的支持。

## 回归保护

新增 `gugu-webui/tests/host/auth-profile-vite.integration.test.ts`，通过 Vite 代理、Node Host 和随机隔离 PostgreSQL schema 验证：

- Cookie 会话可读取当前用户资料，资料更新只改变当前用户字段。
- 时区提交后，revision 通知观察到已提交值。
- 密码更新校验当前密码、持久化新哈希、递增 `security_version`，并在提交后发布认证状态变更。
- 密码更新后旧会话失效，新发 Cookie 会话仍可读取当前资料。

该测试防止 Vite 路由、Cookie/CSRF 边界、PostgreSQL 持久化和密码轮换在迁移时脱节；断言用户可观察行为和提交顺序，不依赖具体路由内部实现。

## 验证

所有命令在 devserver 原生环境执行，未使用 Docker：

- Node Host 与 Vite 隔离 PostgreSQL 集成及资料路由回归：5 passed，0 failed，0 skipped。
- Python 会话撤销和 Cookie 基线：10 passed。
- `gugu-webui` TypeScript 全量检查仍失败于并行文件夹切片：`tests/files/folder-writes-postgres.test.ts` 的 5 处 fixture 未实现新增的 `FolderWriteRuntime.capturePathMirrorDirectoryKeys`。该类型错误位于另一会话正在修改的文件，本切片未改动它；待该切片收敛后重跑全量检查。

## 当前路由归属

资料读取与更新由 Node Host 处理，前端仍通过 Vite `/api/v1` 代理访问。此记录只证明隔离 PostgreSQL 下的端到端行为，不代表真实部署数据库或邮件发送基础设施已验收。
