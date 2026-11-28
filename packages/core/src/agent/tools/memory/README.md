# 记忆工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

搜索与记忆写入依赖宿主端口。群场景由可信来源限定范围，个人与群记忆按场景策略隔离。

## 工具契约

### `search_memory`

搜索个人或已授权群聊记忆；记忆索引更新可能有短暂延迟。

实现与返回契约见 [createMemorySearchTool](./index.ts#L24)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `query` | 是 | `type='string'` |
| `scope` | 否 | `type='string'`，`enum=['auto', 'current_group', 'all_my_groups', 'private_memory']` |
| `source` | 否 | `type='string'`，`enum=['all', 'profile', 'pattern', 'daily', 'memory']` |
| `strategy` | 否 | `type='string'`，`enum=['auto', 'bm25', 'embedding']` |
| `limit` | 否 | `type='integer'`，`minimum=1`，`maximum=25` |

### `remember`

记住或忘记个人信息。默认写入画像，也可写行为模式。可先用 search_memory 查找需要删除的条目。

实现与返回契约见 [createRememberTool](./index.ts#L64)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `text` | 否 | `type='string'` |
| `target` | 否 | `type='string'`，`enum=['profile', 'pattern']` |
| `type` | 否 | `type='string'`，`enum=[...PROFILE_TYPES]` |
| `importance` | 否 | `type='integer'`，`minimum=1`，`maximum=5` |
| `remove` | 否 | `type='array'`，`items={ type: 'string' }` |
