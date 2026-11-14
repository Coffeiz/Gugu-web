# Node WebUI 注册与 onboarding 配额闭环

## 当前路径

`POST /api/v1/auth/register` 已挂到 Node Host，并注入 PostgreSQL 注册事务、Redis 限流/验证码校验、Local 默认 Workspace ACL 与注册后 onboarding seed。邮箱验证关闭时，此注册主路径此前曾由浏览器确认成功。

复核发现 Node 播种文件写入会直接更新 `storage_quota_ledgers`，但新注册事务没有初始化账本；有限全局额度时，上传容量读取也会因账本缺失失败。onboarding seeder 会按 Python 的 best-effort 边界吞掉异常，因此用户仍能注册，却没有引导项目、活动和示例文件。

现已在播种事务中幂等初始化新用户 `file_library` 账本和 `initialize` 审计事件，使用用户覆盖额度或 Host 配置的默认额度；之后再以同一账本核验和记账播种文件。生产组合根将 `storageDefaultLimitBytes` 传给播种适配器。零额度仍拒绝播种文件，账本和项目/事件/文件回滚，不绕开用户额度。

## Node 与 PostgreSQL 回归

devserver Node 26.13.1 原生执行以下 8 个测试文件：

- `gugu-webui/tests/auth/auth-register-postgres.test.ts`
- `gugu-webui/tests/auth/auth-route.test.ts`
- `gugu-webui/tests/auth/auth-registration-code-route.test.ts`
- `gugu-webui/tests/auth/registration-email-flow.test.ts`
- `gugu-webui/tests/onboarding/registration-seed-postgres.test.ts`
- `gugu-webui/tests/onboarding/registration-seed.test.ts`
- `gugu-webui/tests/files/file-upload-postgres.test.ts`
- `gugu-webui/tests/host/auth-registration-vite.integration.test.ts`

结果为 **26/26 通过、0 失败、0 跳过**。注册 PostgreSQL adapter 的 4 项事务集成均在随机隔离 schema 中执行，覆盖初始用户/偏好/工作区写入、Local 根目录准备失败回滚、验证码被替换和提交失败后验证码 TTL 恢复。上传 PostgreSQL 用例也实际通过隔离 schema 验证 Local 写入与配额更新。`gugu-webui` TypeScript 检查通过。

Vite 用例从代理进入 Node Host，在随机隔离 schema 注册合成用户并运行真实 seeder，**1/1 通过、0 跳过**。验证 201、Cookie 会话、`/auth/me`、默认工作区/偏好、引导项目、首日活动、两份 Local 文件、播种状态、配置的 1 MiB 默认额度及 `used_bytes == sum(files.size_bytes)`；临时 Local 文件可从记录中的 key 读取。没有调用真实邮件或 Redis。

## Python 基线与未验收项

使用 devserver 现有 pytest 环境串行执行 `backend/tests/storage/test_storage_quota_ledger.py` 与 `backend/tests/platform/auth/test_onboarding_state.py`，**28/28 通过**。它们覆盖 Python 文件库额度解析、首次账本初始化/幂等、审计事件、配额限制与引导状态归一；Python 仓库当前没有直接调用 `onboarding.seed.seed_for_user` 的注册集成用例。

Vite 用例通过依赖注入的 `createApp`，实际接入 PostgreSQL seeder 与 Local 写入；尚未在该测试内通过生产 `startServer` 组合根完成注册。真实 SMTP 投递、Redis 跨进程限流/验证码共享以及生产部署配置读入仍待验收。

未使用 Docker，未修改运行配置，未触发 CI，未创建真实用户，未提交。
