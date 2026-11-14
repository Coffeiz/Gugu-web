# Node WebUI 注册当前树复验

## 当前路径

`POST /api/v1/auth/register` 已挂到 Node Host，并注入 PostgreSQL 注册事务、Redis 限流/验证码校验、Local 默认 Workspace ACL 与注册后 onboarding seed。邮箱验证关闭时，此注册主路径此前曾由浏览器确认成功。

本轮从 devserver 的 Vite 入口发送空 JSON，请求返回 **422 字段校验错误**，确认请求已由 Vite 转发到 Node 注册路由；无用户数据写入。

## Node 与 PostgreSQL 回归

devserver Node 26.13.1 原生串行执行以下 6 个测试文件：

- `gugu-webui/tests/auth/auth-register-postgres.test.ts`
- `gugu-webui/tests/auth/auth-route.test.ts`
- `gugu-webui/tests/auth/auth-registration-code-route.test.ts`
- `gugu-webui/tests/auth/registration-email-flow.test.ts`
- `gugu-webui/tests/onboarding/registration-seed-postgres.test.ts`
- `gugu-webui/tests/onboarding/registration-seed.test.ts`

结果为 **23/23 通过、0 失败、0 跳过**。注册 PostgreSQL adapter 的 4 项事务集成均在随机隔离 schema 中执行，覆盖初始用户/偏好/工作区写入、Local 根目录准备失败回滚、验证码被替换和提交失败后验证码 TTL 恢复。测试后检查没有遗留 `gugu_registration_*` schema。`gugu-webui` TypeScript 检查通过。

## Python 基线与未验收项

devserver 当前没有仓库内 `backend/.venv`。尝试使用已有 pytest 环境执行注册安全、SMTP 和 onboarding 相邻基线时，测试收集因缺少 `gugu_core` Python 依赖而中止；本轮 Python pytest **未通过也未计为通过**。

Vite 空体校验与 Node adapter 的隔离 schema 测试没有覆盖生产 Host 使用真实运行配置完成一次成功注册。真实 SMTP 投递、Redis 实时共享和生产组合根注册后的 PostgreSQL/onboarding 写入仍待验收。

未使用 Docker，未修改运行配置，未触发 CI，未创建真实用户，未提交。
