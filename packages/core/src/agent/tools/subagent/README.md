# 子 Agent工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

输入参数只定位当前父子关系，身份取自可信 Run。spawn 返回子运行记录及状态；inspect 分别返回运行清单或轮次活动；inbox 返回当前会话的未读消息与报告。

## 工具契约

### `agent_message`（子 Agent）

向委派当前任务的父 Agent 发送消息。

输入为 `sendToParentInput`，执行类型为 `write`。见 [工具定义](./index.ts#L43)。

### `agent_message`（父 Agent）

用 spawn 创建目录中的子 Agent（Searcher 的 agentId 为 builtin:searcher），用 send 向短 ID 对应的子运行追加消息。委派文件或目录时，在 resourceRefs 中提供本轮已授权的路径引用键。

输入为 `messageInput`，执行类型为 `write`。见 [工具定义](./index.ts#L48)。

### `agent_inbox`

检查当前会话的未读子 Agent 消息和报告。立即返回，收件箱为空时也不会等待。

输入为 `z.strictObject({})`，执行类型为 `read`。见 [工具定义](./index.ts#L52)。

### `agent_cancel`

请求取消指定子运行。

输入为 `childInput`，执行类型为 `write`。见 [工具定义](./index.ts#L54)。

### `agent_inspect`

列出子运行，或查看指定子运行的当前活动。可用 round 精查单轮，或用 lastRounds 查看最近 1 至 5 轮。

输入为 `inspectInput`，执行类型为 `read`。见 [工具定义](./index.ts#L56)。
