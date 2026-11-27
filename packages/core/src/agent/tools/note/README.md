# 笔记工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

搜索返回节点标识、标题和摘要；详情附正文、原始物理行号、关系与引用。普通笔记生命周期限定普通节点，删除为软删。事务收据恢复沿用原先确定的目标。

## 工具契约

### `note_search`



[字段契约](./index.ts#L24) · read。

| 参数 | 校验规则 |
| --- | --- |
| `query` | `z.string().optional()` |
| `q` | `z.string().optional()` |
| `queries` | `z.array(z.string()).optional()` |
| `kind` | `z.enum(['note','canvas_note']).optional().describe('普通时间流笔记用 note，画布便签用 canvas_note，省略时搜索两类')` |
| `mode` | `z.enum(['OR','AND']).optional()` |
| `limit` | `z.number().int().safe().optional()` |
| `include_content` | `z.boolean().optional()` |

### `note_get`



[字段契约](./index.ts#L27) · read。

| 参数 | 校验规则 |
| --- | --- |
| `node_id` | `z.number().int().safe()` |

### `note_delete`

软删精确node_id对应的普通便签，可由note_restore恢复；不按关键词模糊删除。

[字段契约](./index.ts#L87) · write。

| 参数 | 校验规则 |
| --- | --- |
| `node_id` | `z.number().int().safe()` |

### `note_restore`

恢复精确node_id对应的已软删普通便签，保留正文。

[字段契约](./index.ts#L87) · write。

| 参数 | 校验规则 |
| --- | --- |
| `node_id` | `z.number().int().safe()` |

### `note_undo`

撤销当前用户最近创建的一条咕咕笔记，不影响用户自行创建的笔记。

[字段契约](./index.ts#L87) · write。

参数及返回值见上述契约和工具实现。

### `note_create`

创建普通时间流笔记。使用 Markdown 字符串。文件引用使用文件工具返回的 gugu://open-object/file/ 路径链接，标题用于索引。captured_at 可指定归属日期。

[字段契约](./index.ts#L105) · write。

| 参数 | 校验规则 |
| --- | --- |
| `title` | `z.string().optional()` |
| `color` | `z.enum(PROJECT_COLOR_KEYS).nullable().optional()` |
| `captured_at` | `z.string().optional()` |
| `markdown` | `z.string().min(1)` |

### `note_update`

更新普通笔记。正文更新方式互斥，一次最多传一个：append_markdown（Markdown 追加）、line_edits（按行编辑）或 find_replace（原文唯一匹配时替换）。数字行编辑以 note_get.numbered_content 的物理行号为准，标题和空行均计入；expected 只传原文，不含行号前缀。局部替换优先从 note_get.content_md 复制原文到 find_replace.find。

[字段契约](./index.ts#L106) · write。

| 参数 | 校验规则 |
| --- | --- |
| `title` | `z.string().nullable().optional()` |
| `color` | `z.enum(PROJECT_COLOR_KEYS).nullable().optional()` |
| `captured_at` | `z.string().optional()` |
| `node_id` | `z.number().int().safe()` |
| `append_markdown` | `z.string().optional()` |
| `find_replace` | `z.object({ find: z.string().min(1).describe('从 note_get.content_md 逐字复制的非空原文，必须唯一匹配'), replace: z.string().describe('替换文字，空字符串删除该处原文'), }).strict().optional()` |
| `line_edits` | `z.array(z.object({ target_lines: z.string().regex(/^(all\|[0-9]+([-,][0-9]+)?)$/u), content: z.string(), expected: z.string().optional() }).strict()).optional()` |
