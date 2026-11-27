# 知识工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

精确读取以已授权知识 ID 定位；搜索限定可信目录和索引。写入与删除使用宿主事务及确认端口，调用重放不扩大资源范围。

## 工具契约

### `save_knowledge`

保存或更新可复用知识；保存前先通过 read_knowledge 查重，已存在时优先使用 update_knowledge。

实现与返回契约见 [createKnowledgeWriteTools](./index.ts#L169)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `title` | 是 | `type='string'` |
| `content` | 是 | `type='string'`，`maxLength=3000` |
| `topic` | 否 | `type='string'` |
| `keywords` | 否 | `type='array'`，`items={ type: 'string' }` |
| `description` | 否 | `type='string'`，`maxLength=150` |
| `source_type` | 否 | `type='string'`，`enum=[...sourceTypes]` |
| `source_ref` | 否 | `type='string'` |
| `source_label` | 否 | `type='string'` |
| `confidence` | 否 | `type='string'`，`enum=['confirmed', 'probable', 'unverified']` |
| `capture_mode` | 否 | `type='string'`，`enum=['explicit', 'tool_result', 'automatic']` |

### `update_knowledge`

更新一条知识；content 省略时只更新元数据，必须使用 read_knowledge 返回的 knowledge_id。

实现与返回契约见 [createKnowledgeWriteTools](./index.ts#L194)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `knowledge_id` | 是 | `type='string'` |
| `content` | 否 | `type='string'`，`maxLength=3000` |
| `title` | 否 | `type='string'` |
| `topic` | 否 | `type='string'` |
| `keywords` | 否 | `type='array'`，`items={ type: 'string' }` |
| `description` | 否 | `type='string'`，`maxLength=150` |
| `confidence` | 否 | `type='string'` |

### `read_knowledge`

按 knowledge_id 精确读取知识，或用 keyword 通过 BM25 搜索知识条目。

实现与返回契约见 [createKnowledgeReadTool](./index.ts#L243)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `knowledge_id` | 否 | `type='string'` |
| `keyword` | 否 | `type='string'` |
| `scope` | 否 | `type='string'` |
| `limit` | 否 | `type='integer'`，`minimum=1`，`maximum=25` |

### `delete_knowledge`

删除指定知识条目，保留历史并停止检索，执行前需确认。

实现与返回契约见 [createKnowledgeDeleteTool](./index.ts#L308)。执行类型为 `write`。 执行前需要确认。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `knowledge_id` | 是 | `type='string'` |
