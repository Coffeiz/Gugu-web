# PRD-IM-12：QQ 消息格式兼容策略

## 状态

代码与自动化回归已完成；真实 QQ 客户端兼容性仍需人工验收

## 背景

QQ Bot v2 同时支持纯文本（`msg_type=0`）和原生 Markdown（`msg_type=2`）。当前 QQ 网关默认优先发送 Markdown；部分旧版 QQ 客户端可能无法正常展示原生 Markdown，导致同一条机器人消息在 QQNT 可见、旧版 QQ 不可见。

参考：[QQ Bot v2 官方开发文档](https://bot.q.qq.com/wiki/develop/api-v2/)。

## 目标

- 群聊和私聊分别配置消息格式策略。
- 不要求模型额外填写格式字段；由群聊或私聊的会话策略决定 QQ 消息类型。
- 兼容模式下约束模型不要生成 Markdown 标记，避免纯文本客户端出现 `**`、代码围栏等串字符。
- 保留 Markdown 排版，满足需要富排版的场景。

## 用户配置

群聊、私聊各提供两种模式：

1. `compat`：兼容格式，始终发送纯文本 `msg_type=0`。
2. `markdown`：Markdown 排版，始终发送 `msg_type=2`；接口拒绝时回退纯文本。

默认值：群聊 `compat`，私聊 `markdown`。历史 `smart` 配置通过数据库迁移统一改为 `markdown`。

## 实现边界

- 设置持久化在 `user_bots`，按用户绑定的 Bot 隔离。
- IM 请求把当前会话格式传入 `AgentRequest`。
- `context.builder` 负责拼装兼容模式的输出约束。
- QQ gateway 负责最终的 `msg_type=0/2` 选择与权限失败回退。
- 图片、文件、引用等富媒体消息不受本文策略影响。

## 验收标准

- 群聊兼容模式下，普通回复和带 Markdown 字符的回复均不向 QQ API 发送 `msg_type=2`。
- Markdown 排版下普通文本和 Markdown 内容均使用 `msg_type=2`。
- Markdown 排版保持现有富排版行为，并保留无权限时的纯文本回退。
- 兼容模式提示词只影响模型输出格式，不改变工具调用和业务内容。
