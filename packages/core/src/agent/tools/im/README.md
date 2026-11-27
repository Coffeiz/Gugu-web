# 即时通讯工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

群检索以可信群范围为准。表情工具使用当前消息的可信标识，绑定工具限定当前 owner 私聊。链接按钮由宿主提供 Web artifact 或渠道投递能力；需要按调用收据恢复投递结果。

## 工具契约

### `group_context_search`

只搜索当前 QQ、飞书或 Telegram 群消息，可按关键词或发言人筛选；不会读取其他群、私聊或网页历史。

实现与返回契约见 [createGroupContextSearchTool](./group-context.ts#L49)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `query` | 否 | `type='string'` |
| `keyword` | 否 | `type='string'` |
| `queries` | 否 | `type='array'`，`items={ type: 'string' }` |
| `mode` | 否 | `type='string'`，`enum=['OR', 'AND']` |
| `speaker` | 否 | `type='string'` |
| `limit` | 否 | `type='integer'` |

### `send_link_buttons`

向当前会话发送导航链接，不等待点击。buttons 直接传含 1–5 个按钮对象的数组。

实现与返回契约见 [createLinkButtonsTools](./link-buttons.ts#L137)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `message` | `limited(2000)` |
| `buttons` | `z.array(z.object({id:limited(64),label:limited(40),url:limited(2048)}).strict()).min(1).max(5)` |

### `react`

给当前飞书消息添加表情回应。

实现与返回契约见 [reactionTool](./tools.ts#L49)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `mood` | 是 | `type='string'`，`enum=moods` |

### `bind_web_session`

将当前 owner 私聊绑定到属于自己的 Web 对话。

实现与返回契约见 [bindSessionTool](./tools.ts#L74)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `session_id` | 是 | `type='integer'` |

### `group_context_search`

搜索当前 QQ、飞书或 Telegram 群的短期消息，可按发言人筛选。

实现与返回契约见 [groupSearchTool](./tools.ts#L140)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `query` | 否 | `type='string'` |
| `keyword` | 否 | `type='string'` |
| `queries` | 否 | `type='array'`，`items={ type: 'string' }` |
| `mode` | 否 | `type='string'`，`enum=['OR', 'AND']` |
| `speaker` | 否 | `type='string'` |
| `limit` | 否 | `type='integer'` |
