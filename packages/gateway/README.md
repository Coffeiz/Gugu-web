# IM Gateway

Desktop 和 Web Host 共用这里的平台连接、收发和事件契约。各宿主装配凭据、绑定、持久化与 Agent 调度。

| 平台 | 连接与发送 | 授权与消息解析 |
|---|---|---|
| 微信 | [轮询](src/platforms/wechat/polling.ts)、[iLink 客户端](src/platforms/wechat/client.ts) | [扫码授权](src/platforms/wechat/pairing.ts)、[消息解析](src/platforms/wechat/message.ts) |
| 飞书 | [长连接](src/platforms/feishu/connection.ts)、[发送](src/platforms/feishu/sender.ts) | [设备授权](src/platforms/feishu/pairing.ts)、[消息解析](src/platforms/feishu/message.ts) |
| QQ | [长连接](src/platforms/qq/connection.ts)、[发送](src/platforms/qq/sender.ts) | [扫码授权](src/platforms/qq/pairing.ts)、[消息解析](src/platforms/qq/message.ts) |
| Telegram | [轮询](src/platforms/telegram/polling.ts)、[对话回复](src/platforms/telegram/sender.ts)、[定时投递](src/platforms/telegram/delivery.ts) | [Token 与 Webhook 校验](src/platforms/telegram/pairing.ts)、[消息解析](src/platforms/telegram/message.ts) |

- [IR](src/ir/) 定义消息、交互回调和回复。平台载荷中的身份需与宿主提供的连接对照。
- [连接监督](src/runtime.ts) 管理连接生命周期。[入站预检](src/runtime/inbound-preflight.ts) 处理交互、绑定与控制消息。宿主在发起 Agent 或发送回复前复核当前绑定。
- Desktop 的[连接设置](../../apps/desktop/src/main/im/connect/)与[网关](../../apps/desktop/src/main/im/gateway/)使用本机加密凭据和 SQLite。Web Host 的[连接设置](../../apps/web-host/src/modules/im/connect/)与[网关](../../apps/web-host/src/modules/im/gateway/)装配账户、PostgreSQL 和 Redis。
- 微信的桌面入口可从[扫码绑定](../../apps/desktop/src/main/im/connect/platforms/wechat/index.ts)追到[轮询和回复](../../apps/desktop/src/main/im/gateway/platforms/wechat/index.ts)，再查看[扫码测试](../../apps/desktop/tests/wechat-pairing.test.ts)和 [Web Host 平台测试](../../apps/web-host/tests/im/gateway/wechat/)。

修改平台后，先运行 [Gateway IR 测试](tests/)，再运行对应的[桌面测试](../../apps/desktop/tests/)和 [Web Host 测试](../../apps/web-host/tests/im/gateway/)。真实平台验收覆盖授权、绑定、私聊收发和桌面重启。支持平台按钮时，同时验证有效回调、重复回调和撤权后拒绝。
