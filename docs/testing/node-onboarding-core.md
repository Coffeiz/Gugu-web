# 新用户引导的 Core 边界

注册后的示例项目、日历事件、欢迎文件、可选音频和引导状态由 `packages/core/src/onboarding/registration-seed.ts` 生成。语言、日期和随机选项沿用已有行为；注册提交后播种失败不改变注册结果。Web Host 负责注册接线、可选音频读取，以及通过 PostgreSQL 事务和本地文件操作应用计划；失败时回滚数据库并补偿已写文件。

`apps/web-host/tests/onboarding/registration-seed.test.ts` 验证完整计划、本地化、可选文件与失败语义；`registration-seed-postgres.test.ts` 使用数据库替身和临时文件验证适配器的提交、重放及失败补偿，不能作为真实 PostgreSQL 验收。真实注册 HTTP、PostgreSQL 与 Vite 代理链路由 `apps/web-host/tests/host/vite/auth/register.integration.test.ts` 验证，并读取实际写入文件确认中文 UTF-8 内容；临时 Vite 环境只验证 API 代理，不验证页面构建。

当前 Core 共享的是计划生成和用例编排，SQLite 的项目、日历、文件和状态原子应用端口及 Desktop 调用尚未接入；不能据此声称注册播种已具备桌面双库支持。


引导状态读取、更新和重新打开的完整用例由 Core 提供；Web Host 注入认证后的 owner 并负责 HTTP 适配。相同用例通过 SQLite 和 PostgreSQL 状态仓储验证，并保留已有播种数据与用户隔离。
