# 日历工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

读取返回活动及 `reminders`；日期解释依赖可信时区。创建、修改和删除由宿主分别装配。删除确认锁定 owner、目标及版本，变更与 Undo 通过共享日历服务提交。

## 工具契约

### `list_events`

查询日历事件，可按日期范围和类型筛选；from/to 传日期字符串。每个活动都会带 reminders 数组，元素可直接用于 update_event 的完整提醒配置。用户查看日程且结果跨至少 3 个日期并有至少 4 项活动时，首轮答复默认附 Mermaid timeline；单日或少量活动用清单，图表日期和时间必须来自查询结果。

实现与返回契约见 [createListEventsTool](./index.ts#L28)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `from` | 否 | `type='string'` |
| `to` | 否 | `type='string'` |
| `type` | 否 | `type='string'`，`enum=['event', 'deadline']` |

### `create_event`

创建日历活动或截止提醒；全天活动传 all_day=true，定时活动需提供 time；reminders 可设置提前时间和通知渠道；到点直接发送活动标题和时间，不调用模型。

实现与返回契约见 [createCalendarEventCreateTool](./index.ts#L188)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `title` | 是 | `type='string'` |
| `date` | 是 | `type='string'` |
| `time` | 否 | `type='string'` |
| `end_time` | 否 | `type='string'` |
| `type` | 否 | `type='string'`，`enum=['event', 'deadline']` |
| `project_id` | 否 | `type='integer'` |
| `description` | 否 | `type='string'` |
| `all_day` | 是 | `type='boolean'` |
| `reminders` | 否 | `type='array'`，`maxItems=20`，`items={ type: 'object', properties: { lead_minutes: { type: 'integer', minimum: 0 }, channels: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['web', 'feishu', 'qq', 'wechat', 'telegram'] } }, delivery_mode: { type: 'string', enum: ['owner_private', 'current_group'] }, enabled: { type: 'boolean' }, }, required: ['lead_minutes'], additionalProperties: false }` |

### `update_event`

修改日历事件及其提醒；按 event_id 或标题 event（可附 on_date）定位。reminders 省略表示不改，提供数组表示整体替换，空数组清除提醒。活动提醒到点直接发送活动标题和时间，不调用模型。

实现与返回契约见 [createCalendarEventUpdateTool](./index.ts#L344)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `event_id` | 否 | `type='integer'` |
| `event` | 否 | `type='string'` |
| `on_date` | 否 | `type='string'` |
| `title` | 否 | `type='string'` |
| `date` | 否 | `type='string'` |
| `time` | 否 | `type='string'` |
| `end_time` | 否 | `type='string'` |
| `type` | 否 | `type='string'`，`enum=['event', 'deadline']` |
| `project_id` | 否 | `type='integer'` |
| `description` | 否 | `type='string'` |
| `all_day` | 否 | `type='boolean'` |
| `reminders` | 否 | `type='array'`，`maxItems=20`，`items={ type: 'object', properties: { lead_minutes: { type: 'integer', minimum: 0 }, channels: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['web', 'feishu', 'qq', 'wechat', 'telegram'] } }, delivery_mode: { type: 'string', enum: ['owner_private', 'current_group'] }, enabled: { type: 'boolean' }, }, required: ['lead_minutes'], additionalProperties: false }` |

### `delete_event`

软删除一个或多个日历事件及其提醒；执行前需确认，可在当前对话撤销。单项支持 event_id 或事件标题 event，批量传 event_ids。

实现与返回契约见 [createCalendarDeleteTool](./index.ts#L556)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `event_id` | 否 | `type='integer'` |
| `event_ids` | 否 | `type='array'`，`maxItems=50`，`items={ type: 'integer' }` |
| `event` | 否 | `type='string'` |
| `on_date` | 否 | `type='string'` |
