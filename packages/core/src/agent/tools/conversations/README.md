# 历史对话工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

搜索返回可读的会话标识和摘要；读取按该标识获取消息。会话读取、搜索与私聊绑定由可信宿主端口执行，不能用参数指定 owner。

## 工具契约

### `bind_web_session`

将当前账号的私聊绑定到本人已有网页会话，之后在此私聊继续该对话。

实现与返回契约见 [createImOwnerSessionBindTool](./index.ts#L16)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `session_id` | 是 | `type='integer'`，`minimum=1`，`maximum=2147483647` |

### `read_conversation`

读取指定历史对话的最近消息；先通过历史搜索确定会话 ID。

实现与返回契约见 [createConversationReadTool](./index.ts#L31)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `session_id` | 是 | `type='integer'` |
| `limit` | 否 | `type='integer'`，`minimum=1`，`maximum=100` |

### `search_conversations`

搜索历史对话；不传关键词时列出最近对话。

实现与返回契约见 [createConversationSearchTool](./index.ts#L91)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `query` | 否 | `type='string'` |
| `keyword` | 否 | `type='string'` |
| `queries` | 否 | `type='array'`，`items={type:'string'}` |
| `mode` | 否 | `type='string'`，`enum=['OR','AND']` |
| `limit` | 否 | `type='integer'` |
