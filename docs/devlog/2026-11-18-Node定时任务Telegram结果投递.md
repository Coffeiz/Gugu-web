# Node 定时任务 Telegram 结果投递

本切片对照 `backend/app/scheduled_tasks.py` 的 `deliver_to_channels`、`_persist_push_im`、`_deliver_im_files`，以及 `backend/tests/scheduling/tasks/test_scheduled_delivery_targets.py` 的渠道与附件失败语义。旧实现将 Telegram 列为显式 IM 渠道，文字发送成功后继续发送 `send_file` 产生的附件；任一附件未送达会返回“文字已发送，附件发送失败”，避免一次性任务被当作成功删除。

## 实现

- Core Telegram Bot API 新增固定官方 HTTPS `sendPhoto`/`sendDocument` multipart 调用，限制单个文件 50,000,000 字节；JPEG/PNG 在 10,000,000 字节内按照片发送，仅收到 400 时回退为文件，校验收件人、文件名和 MIME，固定源站且不跟随重定向。Telegram Bot API 的 Token 仅按已单独评审的范围置于官方 URL 路径；不记录完整 URL 或底层响应。
- Host 定时投递适配器通过 owner-scoped 既有文件读取端口读取结果附件，并在读取前后、发送前复核动态平台开关、owner Bot、群会话、绑定收件人及任务租约。
- `main.ts` 将安全出站 `sendDocument` 和附件读取器接入共享的立即运行、一次性 Worker、周期 Worker 结果投递。移除仅对 Telegram 的整任务拒绝条件；其他工作区、文件系统授权和邮件能力限制保持原有策略。
- 部分附件失败仍返回渠道失败状态，保留 Python 的一次性任务重试语义。

## TDD 与验证

新增 Host 附件投递回归后，首次运行因适配器没有 `sendAttachment` 而失败；Core API 和 Host 投递接入后定向 Node 测试 **5/5**。覆盖 owner 文件读取及 50,000,000 字节上限、平台停用/Bot 失效后不外连、文本成功但附件失败的结果状态。Core Telegram Bot API Vitest **9/9**，覆盖固定路径、multipart 字段、响应回执及超限拒绝。Web Host production TypeScript build 通过。

生产立即运行集成测试被跳过，因为本地没有配置测试用隔离 PostgreSQL 与 Redis；本轮未在 devserver 同步/运行，也未连接真实 Telegram 或代理。Python 基线源码与对应测试已核对，pytest 未运行，因此不声称 Python 实测通过。正式 PG/Redis Worker、推送历史写入、SQLite Worker、真实服务和部署仍未验收。
