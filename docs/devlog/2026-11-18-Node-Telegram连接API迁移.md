# Node Telegram Bot 连接与试投递 API 迁移

## 范围

迁移 `POST /api/v1/me/telegram/connect/`、`PUT /api/v1/me/telegram/connect/{bot_id}` 与 `POST /api/v1/scheduled-tasks/test-notify` 的 Telegram 纯文本投递。Python 基线为 `backend/app/api/v1/telegram_connect.py`、`backend/app/services/telegram_connections.py`、`backend/app/services/telegram_bot_api.py`、`backend/app/api/v1/scheduled_tasks.py`、`backend/app/scheduled_tasks.py` 和 `backend/tests/im/telegram/test_telegram_connect.py`。保留 Token 格式校验、`getMe`/`getWebhookInfo` 顺序、无效 Token/Webhook/身份冲突语义、每 owner 单 Bot、跨 owner Bot ID 唯一、密文持久化、替换验证失败不改旧凭据、替换不同 Bot 时清除旧 owner 绑定，以及提交后渠道刷新。试投递按 owner 和当前启用 Bot 解析私聊/群会话，拒绝异主群，验证后返回发送状态且不创建任务。

IM-15 PRD 已记录针对 Telegram 官方固定 HTTPS API 的窄范围 Token URL 例外。Host 只把 Token 放入 `https://api.telegram.org` 请求路径；Node 传输不跟随重定向，Core API 适配器把底层网络/解析异常转换为不含 URL 与响应正文的错误。其他 host、应用自身 HTTP 路由和凭据仍不允许放入 URL。管理员安全出站配置每次运行时读取；启用代理后使用固定目标的受控代理出口，代理失败不回退直连。

## 结构与接线

- `packages/core/src/im/telegram-connect.ts`：Token/平台规则、owner 与 Bot 冲突检查、PostgreSQL 事务锁、密文写入、绑定清理、提交后快照失效与资源通知；提供使用 Host 注入 `ProviderTransport` 的 Telegram 官方 API 校验适配器。
- `apps/web-host/src/modules/im/telegram-connect.ts`：Fastify DTO、认证上下文转交、错误映射，以及读取热更新安全出站配置的 Host 适配。
- `apps/web-host/src/app.ts`、`apps/web-host/src/main.ts`：注册认证路由并把 Core connector、密钥加密、动态平台配置和资源刷新发布器接入生产组合根。
- `apps/web-host/src/modules/scheduled-tasks/telegram-delivery.ts`：复核 owner/Bot/群会话、解密现存 Token，调用 Core `sendMessage`；Host 复用连接 API 的受控动态代理出站。测试提醒仍由已有 Fastify 路由和 Core 消息规则调度，并在成功后复用 IM 推送历史。

## TDD 与验证

- 先增加 Core 行为测试；首次运行时 connector 模块尚不存在，因 `ERR_MODULE_NOT_FOUND` 失败。补入实现后，Core 测试 7/7 通过：加密存储及无密文响应、每 owner 单 Bot、跨 owner Bot ID 冲突、失败替换保留旧凭据、换 Bot 清理旧 owner 绑定、格式/owner 拒绝及固定 HTTPS/无重定向。
- Host 路由行为测试 1/1 通过，覆盖未认证拒绝、DTO 校验、可信 owner、公开响应与错误脱敏。
- Telegram 试投递用例先因 Host adapter 模块缺失而红；接入后私聊、已验证群、平台/Bot 停用拒发及认证 Fastify 路由 3/3 通过。Core 官方 `sendMessage` 与连接用例 8/8 通过。
- Core 构建通过；Web Host `tsc -p tsconfig.build.json` 通过。连接/试投递目标 Node 回归共 12/12，Core 测试 suite 清单与测试元数据校验通过。当前 Gugu 2.0 checkout 不属于已配置的 Mutagen 源目录，因此本轮未同步 devserver。
- Python 对照文件和测试已阅读，但当前本机 `python3 -m pytest` 因未安装 pytest 无法执行；未据此声称 Python pytest 通过。

## 验收边界

Core 测试使用临时 SQLite 表表达共享业务/SQL 合同，不等于正式 SQLite schema 接通。生产组合根显式使用 PostgreSQL，但本轮未运行隔离 PostgreSQL 集成、真实代理、Telegram 官方服务或部署验收。试投递仅迁移纯文本；Telegram 任务 Worker 的执行门控与附件发送仍未迁移，不据此声称完整定时 Telegram 结果投递已完成。Token 全部为合成值；未读取或使用任何真实凭据。
