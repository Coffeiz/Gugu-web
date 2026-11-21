# Node 工具搜索与按需 Schema 边界

桌面和 Web Host 共用 Core 工具注册器。工具简介模式优先向模型公开 `search_tools`，执行入口仍为 `call_tool`。旧 `get_tool_schema` 入口已移除。

## 搜索契约

| 输入 | 返回 |
| --- | --- |
| `{"query":"在日历里安排会议"}` | 按工具名、公开描述和常用中英文同义词排序，最多 5 个候选 |
| `{"query":"create_event"}` | 精确名称在当前目录存在时优先返回该工具及完整 Schema |
| `{"names":["create_event","list_events"]}` | 最多 12 个精确名称，返回已授权结果及无法解析的 `rejected` 项 |

每个结果包含 `name`、简短的 `description`、扁平 `parameters` 以及 `requires_full_schema`。参数摘要只保留前 24 个顶层字段的 `name`、`type` 和 `required`。嵌套对象、数组、枚举、条件或约束无法完整用摘要表达时，`requires_full_schema` 为 true。

按用途搜索只有一个命中时，或使用 `names` 查询时，结果附完整 Schema，并发出既有 `tool-discovery` 与 `tool-schema` 事件。模型工具结果中的 `schema_in_context` 表示完整定义已由 Canonical 事件带入下一轮上下文。重复定义沿用 Schema 摘要去重，多候选摘要不会加载所有完整定义。没有匹配时返回空 `results`。

## 授权与调用

- 每次查询从当前运行的可信目录读取定义，遵循平台能力、账号、会话、工具停用和 MCP 发现限制。搜索不会执行候选工具。
- `search_tools` 不接受模型提交的 Schema、通配符名称或身份参数。精确查询只能访问该运行可发现的定义。
- 模型拿到名称和参数后，用 `call_tool` 传入 `tool_name` 和 `arguments`。执行端再次校验目标、原始 Schema 和确认权限。
- 桌面与 Web Host 的授权范围由各自宿主端口决定。限定工具目录的会话继续使用其现有工具范围。

## 回归验证

Core 验证中文用途排序、扁平摘要、精确查询、撤权和 Canonical 事件。桌面 sidecar 的简介模式覆盖搜索后在下一轮接收完整定义，再通过 `call_tool` 执行。Web Host 的授权和工具装配测试覆盖已启用工具的精确 Schema；HTTP/SSE 集成测试使用隔离的 PostgreSQL 与 Redis。
