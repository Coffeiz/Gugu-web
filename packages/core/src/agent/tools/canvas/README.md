# 画布工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

分页快照区分节点和独立关系。布局及移除视图保留业务来源，正文修改限定画布便签。批量写入最多 20 项，按输入顺序执行，失败整批回滚；删除、断开连接和包含删除的批处理需要真实确认端口。

## 工具契约

### `canvas_list`

分页查询画布列表、节点数与视图。

实现与返回契约见 [createCanvasReadTools](./index.ts#L36)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `project_id` | 否 | `type='integer'` |
| `limit` | 否 | `type='integer'` |
| `offset` | 否 | `type='integer'` |

### `canvas_get`



[字段契约](./index.ts#L59) · read。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `z.number().int().safe()` |
| `include_content` | `z.boolean().optional()` |
| `limit` | `z.number().int().min(1).max(20).optional()` |
| `include_nodes` | `z.boolean().optional()` |
| `include_relations` | `z.boolean().optional()` |
| `offset` | `z.number().int().min(0).optional()` |

### `canvas_search`



[字段契约](./index.ts#L60) · read。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `z.number().int().safe()` |
| `include_content` | `z.boolean().optional()` |
| `limit` | `z.number().int().min(1).max(20).optional()` |
| `query` | `z.string().optional()` |
| `q` | `z.string().optional()` |
| `queries` | `z.array(z.string()).optional()` |
| `types` | `z.array(z.enum(['canvas_note','project','file','event'])).optional()` |
| `mode` | `z.enum(['OR','AND']).optional()` |

### `canvas_focus_node`

生成用户可点击的画布卡片定位链接。

实现与返回契约见 [createCanvasFocusTools](./index.ts#L79)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `canvas_id` | 是 | `type='integer'` |
| `item_id` | 是 | `type='integer'` |

### `canvas_search_placeable`

搜索当前用户可放入画布的项目、文件和日历活动。提供 query 或 queries，可同时用 types 筛选，types 只接受 project、file、event。

实现与返回契约见 [createCanvasPlaceableSearchTool](./index.ts#L99)。执行类型为 `read`。

| 参数 | 校验规则 |
| --- | --- |
| `query` | `z.string().optional()` |
| `q` | `z.string().optional()` |
| `queries` | `z.array(z.string()).optional()` |
| `types` | `z.array(z.enum(['project','file','event'])).optional()` |
| `canvas_id` | `z.number().int().safe().optional()` |
| `mode` | `z.enum(['OR','AND']).optional()` |
| `limit` | `z.number().int().min(1).max(20).optional()` |
| `offset` | `z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 21).optional()` |

### `canvas_create`

按用户要求创建指定标题和可选项目的画布。

实现与返回契约见 [createCanvasCreateTool](./index.ts#L161)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `title` | `z.string().min(1).refine(value=>[...value].length<=300).meta({maxLength:300})` |
| `project_id` | `z.number().int().safe().nullable().optional()` |

### `canvas_delete_note`

删除一个或多个画布专属便签并移除其画布视图，最多 20 个；执行前必须一次性展示影响并获得可信确认。

实现与返回契约见 [createCanvasDeleteNoteTool](./index.ts#L314)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `node_id` | 否 | `type='integer'` |
| `notes` | 否 | `type='array'`，`minItems=1`，`maxItems=20`，`items={type:'object',properties:{node_id:{type:'integer'}},required:['node_id'],additionalProperties:false}` |

### `canvas_disconnect`

删除指定画布中的一条或多条关系；批量最多 50 条，执行前需可信目标确认。

实现与返回契约见 [createCanvasDisconnectTool](./index.ts#L376)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `canvas_id` | 是 | `type='integer'` |
| `relation_id` | 否 | `type='integer'` |
| `relation_ids` | 否 | `type='array'`，`maxItems=50`，`items={type:'integer'}` |

### `canvas_delete`

删除一张或多张画布及其所有内容；批量最多 20 张，执行前需可信目标确认。

实现与返回契约见 [createCanvasDeleteTool](./index.ts#L445)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `canvas_id` | 否 | `type='integer'` |
| `canvas_ids` | 否 | `type='array'`，`maxItems=20`，`items={type:'integer'}` |

### `canvas_batch`

在一个事务中按顺序批量编排画布节点、便签和连接，最多 20 项；任一操作失败则整批回滚，request_id 用于安全重放。update_item 可用 x/y 或 position 锚点移动；删除便签须经过可信目标确认。

实现与返回契约见 [createCanvasBatchTool](./index.ts#L520)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `id` |
| `request_id` | `z.string().refine(value=>[...value].length<=120)` |
| `operations` | `z.array(operation).min(1).max(20)` |

### `canvas_update_node`



[字段契约](./index.ts#L574) · write。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `id` |
| `item_id` | `id.optional()` |
| `x` | `number.optional()` |
| `y` | `number.optional()` |
| `z` | `id.optional()` |
| `collapsed` | `z.boolean().optional()` |
| `width` | `number.min(180).max(520).optional()` |
| `height` | `number.min(100).max(420).optional()` |
| `updates` | `z.array(layoutEntry).min(1).max(20).optional()` |

### `canvas_remove_node`



[字段契约](./index.ts#L574) · write。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `id` |
| `item_id` | `id.optional()` |
| `item_ids` | `z.array(id).min(1).max(20).optional()` |

### `canvas_update_note`



[字段契约](./index.ts#L574) · write。

| 参数 | 校验规则 |
| --- | --- |
| `node_id` | `id.optional()` |
| `title` | `z.string().refine(value=>[...value].length<=300).meta({maxLength:300}).optional()` |
| `content` | `z.string().optional()` |
| `color` | `z.enum(PROJECT_COLOR_KEYS).optional()` |
| `updates` | `z.array(noteEntry).min(1).max(20).optional()` |

### `canvas_create_note`



[字段契约](./index.ts#L609) · write。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `id` |
| `title` | `z.string().refine(value=>[...value].length<=300).meta({maxLength:300}).optional()` |
| `content` | `z.string().optional()` |
| `color` | `z.enum(PROJECT_COLOR_KEYS).optional()` |
| `position` | `position.optional()` |
| `width` | `finite.min(180).max(520).optional()` |
| `height` | `finite.min(100).max(420).optional()` |
| `notes` | `z.array(noteEntry).min(1).max(20).optional()` |

### `canvas_add_node`



[字段契约](./index.ts#L609) · write。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `id` |
| `node_id` | `id.optional()` |
| `ref_type` | `z.enum(['project','file','event']).optional()` |
| `ref_id` | `z.union([id,z.string().regex(/^(path\|drop)-[A-Za-z0-9_-]{1,24000}$/u)]).meta({'x-coerce-ref-id':true}).optional()` |
| `position` | `position.optional()` |
| `nodes` | `z.array(refEntry).min(1).max(20).optional()` |

### `canvas_update_anchor`

修改画布关系端点，保留其他视图数据及关系语义。

实现与返回契约见 [createCanvasAnchorTool](./index.ts#L635)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `z.number().int().safe()` |
| `relation_id` | `z.number().int().safe()` |
| `source_side` | `z.enum(['left','right'])` |
| `target_side` | `z.enum(['left','right'])` |

### `canvas_connect`

连接同画布节点，默认related幂等关系；按实际几何保存端点，自定义端点必须显式声明。

实现与返回契约见 [createCanvasRelationTools](./index.ts#L644)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `canvas_id` | `z.number().int().safe()` |
| `source_node_id` | `z.number().int().safe()` |
| `target_node_id` | `z.number().int().safe()` |
| `type` | `z.literal('related').optional()` |
| `source_side` | `z.enum(['left','right']).optional()` |
| `target_side` | `z.enum(['left','right']).optional()` |
| `allow_custom_anchor` | `z.boolean().optional()` |
