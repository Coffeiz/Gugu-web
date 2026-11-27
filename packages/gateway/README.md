# @gugu/gateway · IM Gateway

Desktop 和 Web Host 共用这里的平台连接、收发和事件契约。各宿主装配凭据、绑定、持久化与 Agent 调度。

本包处理 IM 消息，与规划中的 SaaS Model Gateway 分属消息交付和托管推理两个领域。

## 当前公开入口与消费方

| 入口 | 公开能力 | 消费方 |
|---|---|---|
| `@gugu/gateway` | `createGatewaySupervisor` 管理连接生命周期。消息 IR、`imAdmissionKeys`、入站预检和交互契约用于消息解析、去重与控制分流 | Web Host 和 Desktop 网关 |
| `@gugu/gateway/qq`、`/feishu`、`/wechat`、`/telegram` | 各平台连接、授权、解析、发送与平台回执处理 | 两端的平台适配器 |
| `@gugu/gateway/media` | 共享入站媒体处理能力 | 两端的附件和媒体接线 |

Core 决定消息是否触发 Agent、绑定哪个会话、使用哪些场景权限，并管理 Run 生命周期。Host 提供可信身份、连接凭据、存储和进程装配。Database 提供表结构、事务和原子持久化能力。当前 Web 在可信准入后封装消息并写入 PostgreSQL inbox，Desktop 经 IPC 写入 SQLite inbox。两端已复用平台 sender，入站交接和部分投递编排仍由宿主分别实现。

## 平台实现

| 平台 | 连接与发送 | 授权与消息解析 |
|---|---|---|
| 微信 | [轮询](src/platforms/wechat/polling.ts)、[iLink 客户端](src/platforms/wechat/client.ts) | [扫码授权](src/platforms/wechat/pairing.ts)、[消息解析](src/platforms/wechat/message.ts) |
| 飞书 | [长连接](src/platforms/feishu/connection.ts)、[发送](src/platforms/feishu/sender.ts) | [设备授权](src/platforms/feishu/pairing.ts)、[消息解析](src/platforms/feishu/message.ts) |
| QQ | [长连接](src/platforms/qq/connection.ts)、[发送](src/platforms/qq/sender.ts) | [扫码授权](src/platforms/qq/pairing.ts)、[消息解析](src/platforms/qq/message.ts) |
| Telegram | [轮询](src/platforms/telegram/polling.ts)、[对话回复](src/platforms/telegram/sender.ts)、[定时投递](src/platforms/telegram/delivery.ts) | [Token 与 Webhook 校验](src/platforms/telegram/pairing.ts)、[消息解析](src/platforms/telegram/message.ts) |

- [IR](src/ir/) 定义消息、交互回调和回复。平台载荷中的身份需与宿主提供的连接对照。
- [连接监督](src/runtime.ts) 管理连接生命周期。[入站预检](src/runtime/inbound/preflight.ts) 处理交互、绑定与控制消息。宿主在发起 Agent 或发送回复前复核当前绑定。
- Desktop 的[连接设置](../../apps/desktop/src/main/im/connect/)与[网关](../../apps/desktop/src/main/im/gateway/)使用本机加密凭据和 SQLite。Web Host 的[连接设置](../../apps/web-host/src/modules/im/connect/)与[网关](../../apps/web-host/src/modules/im/gateway/)装配账户、PostgreSQL 和 Redis。
- 微信的桌面入口可从[扫码绑定](../../apps/desktop/src/main/im/connect/platforms/wechat/index.ts)追到[轮询和回复](../../apps/desktop/src/main/im/gateway/platforms/wechat/index.ts)，再查看[扫码测试](../../apps/desktop/tests/wechat-pairing.test.ts)和 [Web Host 平台测试](../../apps/web-host/tests/im/gateway/wechat/)。

## 入站 API

Gateway 拥有消息 IR 和入站、投递的状态语义。Web 的 PostgreSQL 仓储位于 Web Host IM 模块，Desktop 的 SQLite 仓储位于 Core IM 模块。Database 提供两端共用的结构与事务基础设施。见 [数据库基础层实施计划](../../docs/architecture/database-implementation.md)。

`receiveMessage(connection, event, store)` 接收平台适配器产出的 `ImReceivedMessage`，核对可信连接后，通过 `ImInboundStore.recordInbound` 写入。回执为 `queued`、`recorded`、`duplicate` 或 `ignored`。写入失败或提交结果未知时由适配器抛出错误。

Web Host 将 QQ、飞书、微信写入 PostgreSQL 收件表。Telegram 在同一个事务中写入收件并推进长轮询游标，已有 Redis 游标用于首次切换。新消息的去重键与待处理状态一起提交。Web 仍消费切换前遗留的 Node Redis Stream 消息，新连接写入 PostgreSQL。群注意力从 PostgreSQL 收件和已持久化的会话历史读取短期消息。

| 消费端口 | Web Host | Desktop |
|---|---|---|
| `claimInbound` | 设置 PostgreSQL 租约。租约到期后可以重新领取原收件 | 从 SQLite 读取当前连接的待准入收件，通过稳定客户端消息 ID 找回已登记的 Run。已关联的收件由投递恢复路径读取 |
| `settleInbound` | 会话与 Run 调度事务提交后，用仍有效的租约确认 | 发现对应的 Run 已持久登记后，将收件关联到该 Run。最终投递通过独立回执确认 |

Web 定期扫描数据库补领，未确认的收件须等原租约到期（默认 120 秒）。完成的收件保留去重键，后台清理超过 30 分钟的密封载荷。Desktop 的收件与附件元数据原子提交，发送中的回复继续使用已有的投递收据。两端使用独立数据库，去重作用域限于各自数据库。

## 后续 API

| API | 调用方 | 结果与保证 |
|---|---|---|
| `sendMessage(command)` | Agent 回复、IM 主动发送工具和宿主通知 | 按幂等键登记投递，返回 `deliveryId`。平台已受理由投递结果单独表示 |
| `getDeliveryStatus(scope, deliveryId)` | Agent 工具和诊断界面 | 在可信作用域内查询排队、已受理、失败或结果未知 |

首阶段保留群聊只记录、控制命令和交互回执分流。消费前复核绑定、会话、发送者与附件归属。出站迁移时保留 QQ 主动发送、被动回复和平台序号约束。平台可能已受理而回执丢失时保留未知状态，按平台能力核对后再决定是否重试。

## 验收

QQ 入站共享链路需覆盖重复事件、提交后未唤醒、领取后重启、同一会话的消息顺序，以及群聊只记录。PG 与 SQLite 运行相同的契约用例。Core 已登记 Run 后重领同一事件，应返回原 Run。

修改平台后，先运行 [Gateway IR 测试](tests/)，再运行对应的[桌面测试](../../apps/desktop/tests/)和 [Web Host 测试](../../apps/web-host/tests/im/gateway/)。真实平台验收覆盖授权、绑定、私聊收发和桌面重启。支持平台按钮时，同时验证有效回调、重复回调和撤权后拒绝。
