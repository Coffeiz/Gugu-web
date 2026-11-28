# 项目工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

目标优先使用 `project_id`，名称定位允许返回歧义候选。读写均限定当前 owner。创建与修改由宿主注入端口；阶段写入与撤销、调用收据同事务。删除前冻结目标及关联资源，经确认后软删。提交状态未知时通过原调用收据恢复。

`list_projects` 默认只读未归档项目，返回 `id`、`name`、`status`、`color`、`deadline`、`start_date`、`client`、`stages_done`、`stages_total`。

`get_project` 另返回 `priority`、`summary`、`files`、`current_stage`、`archived`、`stages`。每个阶段包含 `key`、`label`、`done` 和 `todos`，待办包含 `id`、`text`、`done`。仅在目录可定位时返回 `location`，存在关联工作区时返回 `workspaces`。

`create_project` 返回 `success`，成功时可带 `project_id`、`name`、`stages`、`stage_details`、`current_stage` 和 `idempotent_replay`；失败可带 `error` 与 `error_code`。修改时省略字段表示保持原值；`summary: null` 清除摘要，`priority: "none"` 清除优先级。

示例：`get_project({"project_id":42})`；`update_project({"project_id":42,"summary":null})`。

## 工具契约

### `list_projects`

查询项目；支持按状态和归档状态筛选。

实现与返回契约见 [createListProjectsTool](./tools.ts#L30)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `status` | 否 | `type='string'`，`enum=['pending', 'active', 'done']` |
| `archived` | 否 | `type='boolean'` |

### `get_project`

读取项目结构。目录可定位时返回 location；已关联工作区在 workspaces 中单独列出；sandbox 表示 Web 沙箱路径，host_absolute 表示本机绝对路径。沙箱 Shell 无法读取桌面目录；宿主机 Shell 仍须遵循当前授权。未返回相应字段时不要根据项目名称推导路径。

实现与返回契约见 [createGetProjectTool](./tools.ts#L104)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `project_id` | 否 | `type='integer'` |
| `project` | 否 | `type='string'` |

### `create_project`

创建项目，填写名称、开始日期、截止日期，可设置颜色、优先级和阶段。

实现与返回契约见 [createProjectTool](./tools.ts#L165)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `project_name` | `z.string()` |
| `start_date` | `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` |
| `deadline` | `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` |
| `client` | `z.string().optional()` |
| `summary` | `z.string().refine(value => length(value) <= 200).meta({ maxLength: 200 }).nullable().optional()` |
| `status` | `z.enum(['pending', 'active', 'done']).optional()` |
| `priority` | `z.enum(['high', 'medium', 'low']).optional()` |
| `color` | `z.enum(PROJECT_COLOR_KEYS).optional()` |
| `stages` | `z.array(z.union([z.string().min(1), z.object({ label: z.string().min(1), todos: z.array(z.string().min(1)).optional() }).strict()])).min(1).optional()` |

### `update_project`

修改项目状态、日期、优先级或项目摘要；优先级传 none 可清除。

[字段契约](./tools.ts#L233) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `status` | `z.enum(['pending', 'active', 'done']).optional()` |
| `start_date` | `date.optional()` |
| `deadline` | `date.optional()` |
| `client` | `z.string().optional()` |
| `project_name` | `z.string().optional()` |
| `summary` | `z.string().nullable().optional().refine(value => value == null \|\| [...value].length <= 200)` |
| `priority` | `z.enum(['high', 'medium', 'low', 'none']).optional()` |

### `set_color`

设置项目颜色。

[字段契约](./tools.ts#L233) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `color` | `z.enum(PROJECT_COLOR_KEYS)` |

### `archive_project`

归档或取消归档项目，省略时默认归档。

[字段契约](./tools.ts#L233) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `archived` | `z.boolean().optional()` |

### `add_stage`

给项目新增阶段；position指定插入位置。阶段键是稳定标识，同名阶段请用键定位。

[字段契约](./tools.ts#L317) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `label` | `stageText` |
| `position` | `z.number().int().safe().min(0).optional()` |

### `remove_stage`

按key或唯一名称删除阶段及其待办；至少保留一个阶段，删除当前阶段后切换到剩余首项。

[字段契约](./tools.ts#L318) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `stage` | `stageText` |

### `rename_stage`

按key或唯一名称重命名阶段；同名阶段必须使用key。

[字段契约](./tools.ts#L319) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `stage` | `stageText` |
| `new_label` | `stageText` |

### `set_stages`

整体声明阶段；省略todos保留原待办，提供todos则重建为未完成；同名阶段须提供key。

[字段契约](./tools.ts#L320) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `stages` | `z.array(z.union([stageText,stageEntry])).min(1)` |

### `update_stage`

只传stage切换当前阶段；add新增待办；todos按id、精确文本或唯一模糊文本批量勾选、改名、移动或删除。带 add 时 stage 指定新增阶段，修改待办时 todos[].stage 或外层 stage 限定源阶段，to_stage 指定移动目标；失败项零副作用，成功项一次提交。

[字段契约](./tools.ts#L321) · write。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().safe().optional()` |
| `project` | `z.string().optional()` |
| `stage` | `stageText.optional()` |
| `add` | `z.array(stageText).optional()` |
| `todos` | `z.array(z.object({text:stageText,stage:stageText.optional(),done:z.boolean().optional(), new_text:stageText.optional(),to_stage:stageText.optional(),remove:z.boolean().optional()}).strict()).optional()` |

### `delete_project`

确认后将一个或多个项目及其文件移入回收站。单项传 project_id 或 project，批量传 project_ids。

实现与返回契约见 [createProjectDeleteTool](./tools.ts#L493)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `project_id` | 否 | `type='integer'` |
| `project` | 否 | `type='string'` |
| `project_ids` | 否 | `type='array'`，`maxItems=20`，`items={ type: 'integer' }` |
