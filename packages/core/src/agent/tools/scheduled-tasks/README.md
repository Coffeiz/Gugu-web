# 定时任务工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

创建、更新分别消费宿主能力。提醒模式原样投递正文，任务模式启动 Agent Run。可选渠道由宿主收窄；删除确认冻结目标，提交或投递状态未知时使用调用收据恢复。

## 工具契约

### `list_scheduled_tasks`

列出全部独立定时任务，不包含日历活动提醒。

实现与返回契约见 [createListScheduledTasksTool](./index.ts#L25)。执行类型为 `read`。

无输入字段。

### `delete_scheduled_task`

确认后删除一个或多个独立定时任务。单项传 task_id 或任务名 task，批量传 task_ids。

实现与返回契约见 [createScheduledTaskDeleteTool](./index.ts#L198)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `task_id` | 否 | `type='integer'` |
| `task` | 否 | `type='string'` |
| `task_ids` | 否 | `type='array'`，`maxItems=50`，`items={ type: 'integer' }` |

### `create_scheduled_task`



[字段契约](./index.ts#L236) · write。

| 参数 | 校验规则 |
| --- | --- |
| `schedule_name` | `z.string()` |
| `execution_mode` | `z.enum(['reminder', 'instruction']).describe('reminder 到点原样发送，不调用模型；instruction 到点由咕咕执行').optional()` |
| `instruction` | `z.string().describe('提醒模式填写要原样发送的正文，任务模式填写咕咕到时间要处理的任务描述')` |
| `schedule_kind` | `scheduleKind` |
| `cron` | `z.string().nullable().optional()` |
| `interval_minutes` | `z.number().int().min(1).max(60).nullable().optional()` |
| `start_at` | `z.string().nullable().optional()` |
| `end_at` | `z.string().nullable().optional()` |
| `channels` | `z.array(z.enum(['web', 'email', 'feishu', 'qq', 'telegram', 'wechat'])).min(1).refine(unique).optional()` |
| `enabled` | `z.boolean().optional()` |
| `delivery_mode` | `deliveryMode.optional()` |
| `authorized_tools` | `z.array(z.literal('send_email')).max(1).optional()` |
| `email_attachment_file_paths` | `z.array(z.string().max(4096).regex(/^\/(personal\|project\|workspace)\/[^\\\p{Cc}]+$/u)).max(5).refine(unique).optional()` |
| `workspace_id` | `taskId.nullable().optional()` |
| `filesystem_authorized` | `z.boolean().optional()` |

### `update_scheduled_task`



[字段契约](./index.ts#L236) · write。

| 参数 | 校验规则 |
| --- | --- |
| `schedule_name` | `taskInput.schedule_name.optional()` |
| `execution_mode` | `z.enum(['reminder', 'instruction']).describe('reminder 到点原样发送，不调用模型；instruction 到点由咕咕执行').optional()` |
| `instruction` | `taskInput.instruction.optional()` |
| `schedule_kind` | `scheduleKind.nullable().optional()` |
| `cron` | `z.string().nullable().optional()` |
| `interval_minutes` | `z.number().int().min(1).max(60).nullable().optional()` |
| `start_at` | `z.string().nullable().optional()` |
| `end_at` | `z.string().nullable().optional()` |
| `channels` | `z.array(z.enum(['web', 'email', 'feishu', 'qq', 'telegram', 'wechat'])).min(1).refine(unique).optional()` |
| `enabled` | `z.boolean().optional()` |
| `delivery_mode` | `deliveryMode.optional()` |
| `authorized_tools` | `z.array(z.literal('send_email')).max(1).optional()` |
| `email_attachment_file_paths` | `z.array(z.string().max(4096).regex(/^\/(personal\|project\|workspace)\/[^\\\p{Cc}]+$/u)).max(5).refine(unique).optional()` |
| `workspace_id` | `taskId.nullable().optional()` |
| `filesystem_authorized` | `z.boolean().optional()` |
| `task_id` | `taskId.optional()` |
| `task` | `z.string().optional()` |
| `task_ids` | `z.array(taskId.positive()).min(1).max(50).refine(unique).optional()` |
