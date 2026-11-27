# 元工具工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

工具发现只返回当前授权目录。Skill 正文加载依赖当前 Run 的可加载目录；普通澄清等待回复，授权及危险操作使用独立确认链。

## 工具契约

### `call_tool`

调用当前已授权的业务工具。

实现与返回契约见 [createCallToolAdapter](./call-adapter.ts#L57)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `tool_name` | 是 | `type='string'`，`minLength=1`，`maxLength=80` |
| `arguments` | 是 | `type='object'` |

### `choose_no_reply`

选择本轮不回复。可以先阅读上下文；确定不需要回应时单独调用。已经输出正文后不能改为静默。

实现与返回契约见 [createChooseNoReplyTool](./tools.ts#L13)。执行类型为 `read`。

无输入字段。

### `use_skill`

按技能 ID 读取技能正文。

实现与返回契约见 [createUseSkillTool](./tools.ts#L44)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `id` | 是 | `type='string'` |

### `search_tools`

在当前已授权工具中按用途搜索，或按精确名称读取完整 Schema。查询指定 MCP 时同时传 query 和 mcp_server。query 的 limit 默认 10，最多 20，返回候选及扁平参数摘要，唯一命中时附完整 Schema。已知工具名称、或结果标记 requires_full_schema 时，用 names 查询，一次最多传 20 个名称。

实现与返回契约见 [createSearchToolsTool](./tools.ts#L104)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `mcp_server` | 否 | `type='string'`，`minLength=1`，`maxLength=200` |
| `query` | 否 | 见输入契约 |
| `names` | 否 | 见输入契约 |
| `limit` | 否 | 见输入契约 |

### `ask_user`



实现与返回契约见 [createAskUserTool](./tools.ts#L166)。执行类型为 `read`。

输入契约由 `schema` 定义，包含类型、必填和运行时校验。
