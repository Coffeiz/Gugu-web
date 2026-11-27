# 工作区工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

查询返回可用工作区声明。工作区 ID、项目 ID、物理目录分别有独立身份；项目绑定返回输入标识及 `changed`。更新返回完整 owner 限定投影，修改通过事务收据恢复。

## 工具契约

### `list_workspaces`



[字段契约](./index.ts#L19) · read。

参数及返回值见上述契约和工具实现。

### `get_workspace`



[字段契约](./index.ts#L19) · read。

| 参数 | 校验规则 |
| --- | --- |
| `workspace_id` | `workspaceId` |

### `set_project_workspace`

将已登记的文件库工作区关联到项目并设为当前文件目录。bound=false 解除关联，若解除的是当前目录，项目回到内置项目文件目录。先用 list_workspaces 获取 workspace_id。

实现与返回契约见 [createProjectWorkspaceBindingTool](./index.ts#L48)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `project_id` | `z.number().int().positive().safe()` |
| `workspace_id` | `workspaceId` |
| `bound` | `z.boolean()` |

### `create_workspace`

创建文件库顶层工作区。使用 set_project_workspace 将已有工作区绑定到项目。

实现与返回契约见 [createWorkspaceTool](./index.ts#L93)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `workspace_name` | 是 | `type='string'`，`minLength=1`，`maxLength=200` |
| `kind` | 是 | `type='string'`，`enum=['directory']` |
| `enabled` | 否 | `type='boolean'` |

### `update_workspace`

修改工作区显示名或启用状态；目录工作区同步显示名，不改变物理路径或绑定。

实现与返回契约见 [createWorkspaceUpdateTool](./index.ts#L153)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `workspace_id` | 是 | `type='integer'` |
| `workspace_name` | 否 | `type='string'`，`maxLength=200` |
| `enabled` | 否 | `type='boolean'` |
