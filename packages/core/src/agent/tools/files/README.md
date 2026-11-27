# 文件与附件工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

文件和附件按 owner 限定。读取支持逻辑路径、附件标识及正文读取上限；软删后可恢复。发送与打开走宿主文件呈现能力。

`open_item` 的路径选择、`kind`、`reference_only` 和返回链接见 [文件呈现契约](./tools.ts#L205)。

## 工具契约

### `send_item`



实现与返回契约见 [createScheduledSendFileTool](./send-file.ts#L30)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `file` | 否 | `type='string'`，`description='文件的沙盒绝对路径，例如 /personal/报告.pdf'` |
| `attach_id` | 否 | `type='string'` |
| `url` | 否 | `type='string'` |
| `title` | 否 | `type='string'` |
| `source_type` | 否 | `type='string'`，`enum=[...sourceKeys]` |

### `send_item`

仅在用户明确要求时发送已授权文件或本会话附件；平台结果不明确时不会重发。

实现与返回契约见 [createImSendFileTool](./send-file.ts#L105)。执行类型为 `write`。

输入和结果随能力装配，见上面的工具定义。

### `save_attachment`

把已授权的聊天附件保存到个人、指定项目文件夹或当前会话工作区。已授权的 owner 可以按精确 ID 保存其他会话的附件；latest 只查当前会话。个人文件未指定 folder_path 时保存到 /personal/download；使用 folder_path 指定目标根内的相对目录。工作区目录由会话绑定确定；可精确保存一个或一组 attach_id，也可选择最近的附件；不会覆盖已有文件。

实现与返回契约见 [createSaveAttachmentTool](./tools.ts#L115)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `source` | 否 | `type='string'`，`enum=['latest', 'attach_id', 'attach_ids']` |
| `attach_id` | 否 | `type='string'`，`minLength=1`，`maxLength=128` |
| `attach_ids` | 否 | `type='array'`，`minItems=1`，`maxItems=20`，`items={ type: 'string', minLength: 1, maxLength: 128 }` |
| `space` | 否 | `type='string'`，`enum=['personal', 'project', 'workspace']`，`default='personal'` |
| `project_id` | 否 | `type='integer'`，`minimum=1` |
| `folder_path` | 否 | `type='string'`，`minLength=1`，`maxLength=2048` |

### `list_recent_attachments`

列出当前账号暂存附件和当前会话近期已挂载附件，返回 attach_id 与媒体元数据。

实现与返回契约见 [createListRecentAttachmentsTool](./tools.ts#L279)。执行类型为 `read`。

无输入字段。

### `delete_file`

将指定文件或文件库逻辑路径批量移入回收站（30 天内可恢复）。批量删除会整体校验，缺失文件时不会删除其他项；此操作不会永久删除。路径只接受 /personal、/project、/workspace 文件库路径，不接受宿主机路径。

实现与返回契约见 [createDeleteFileTool](./tools.ts#L433)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `file` | 否 | `type='string'`，`minLength=1`，`maxLength=2048`，`description='/personal、/project 或 /workspace 文件库逻辑路径'` |
| `files` | 否 | `type='array'`，`minItems=1`，`maxItems=50`，`items={ type: 'string', minLength: 1, maxLength: 2048 }` |

### `view_image`



实现与返回契约见 [createViewImageTool](./view-image.ts#L123)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `path` | 否 | `type='string'`，`minLength=1`，`maxLength=2048`，`description='会话沙箱中的图片路径'` |
| `url` | 否 | `type='string'`，`minLength=1`，`maxLength=2048`，`description='公网 HTTP(S) 图片直链'` |
