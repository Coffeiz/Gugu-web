---
name: 定时任务
description_short: 用户要设置独立定时任务、周期任务或到点执行时使用；日程自带提醒直接用日历工具。
description_long: "要设定时/周期执行任务时，怎么用 *_scheduled_task 建任务、单次、cron 或精确 interval 怎么写、可选开始结束时间和渠道怎么选；并区分日历活动自带提醒。"
category: scheduling
related_tools: list_scheduled_tasks, create_scheduled_task, update_scheduled_task, delete_scheduled_task, create_event, list_events, update_event
emoji: ⏰
---

# 定时任务技能

## 1. 先判断提醒对象

先判断用户要提醒的是“一个日程活动”，还是“到点执行一件独立的事”：

- 创建日程/活动并提醒，或给已有日程设置提前提醒 → 使用日程自己的提醒。
- 到点查询、汇总、发消息、执行复杂流程，或每天/每周重复执行 → 使用独立定时任务。
- 单纯“日程 + 提醒”不要拆成两个对象；只有用户明确要求“日程 + 独立执行任务”时才同时创建。

## 2. 日程活动提醒

- 新建活动：在 `create_event` 的 `reminders` 字段中传提醒配置数组，每项包含 `lead_minutes`，可选 `channels` 和 `delivery_mode`；不要再调用 `create_scheduled_task`。
- 查看活动与提醒：使用 `list_events`，提醒配置随活动一并返回。
- 更新或删除活动提醒：使用 `update_event` 的 `reminders` 字段传完整配置数组；省略该字段表示不改提醒，传 `[]` 会删除全部提醒。不能只传增量项，需保留仍要使用的提醒配置。
- 修改活动日期或开始时间且省略 `reminders` 时，启用提醒会保留原提前分钟数并按新活动时间重排。
- 活动提醒绑定 `event_id`，跟随活动管理和删除，不属于独立定时任务列表。
- 每条活动提醒可独立设置渠道。QQ 投递到私聊用 `delivery_mode="owner_private"`，投递到当前 QQ 群用 `delivery_mode="current_group"`。群聊中配置 QQ 渠道时必须先明确投递位置；不要让用户或模型手填 QQ openid。

## 3. 创建独立定时任务

- `create_scheduled_task` 一次带齐 `name`、`instruction`、`schedule_kind`、对应的调度字段和 `channels`，不要多轮试探。
- 建立前复述“几点、做什么、发哪个渠道”；用户确认后再创建。
- 只执行一次使用 `schedule_kind="once"` 和 `start_at`，例如今晚 18:30：`{"schedule_kind":"once","start_at":"2026-09-05T18:30:00"}`；单次任务成功投递后自动移除，失败会保留供重试。
- 每日/每周/工作日等日历型重复使用 `schedule_kind="cron"`，例如每天 09:00 是 `cron="0 9 * * *"`。
- 精确分钟窗口使用 `schedule_kind="interval"` 和 `interval_minutes`（1–60）；例如从 18:30 起每 10 分钟到 19:30：`{"schedule_kind":"interval","interval_minutes":10,"start_at":"2026-09-05T18:30:00","end_at":"2026-09-05T19:30:00"}`。间隔从 `start_at` 锚定，不按整点重新对齐，`end_at` 命中时执行，超过后不补发。
- `start_at` 和 `end_at` 都是可选的，可以只设置其中一个，也可以都不设置；没有用户明确要求时不要自行添加边界。时间按 Asia/Shanghai 解释，传 ISO 日期时间字符串。
- “到某天结束”按用户时区当天 23:59:59 处理；含糊的“最近一周”“月底”等日期先用当前时间/日历确认，不能自行猜日期。
- cron 由咕咕生成，但回复用户时只说人话时间，不要展示 cron 字符串。

## 4. 参数与渠道

- `channels` 必须是字符串数组，例如 `channels=["email"]`、`channels=["qq"]` 或 `channels=["web", "email", "qq"]`；不要传字符串、对象或额外的 `item` 字段。
- 错误示例：不要传 `channels="qq"` 或 `channels={"item":"qq"}`。
- `email` 发送到用户注册邮箱并使用 `reminder` 模板；默认 `web` 站内通知最稳。
- 定时任务不支持工具组或上下文裁剪配置；不要传 `tool_groups` 或 `context_config`。所有任务统一使用完整工具集和完整业务上下文。需要预先授权的自动工具只通过 `authorized_tools` 设置，目前仅支持 `send_email`。
- 定时任务中的 Shell 始终运行在任务绑定的 workspace 和沙盒边界内；不支持交互式确认，需要确认的危险命令不得执行。
- 使用 `feishu` / `qq` / `wechat` 前，先确认对应 IM 已绑定，否则不要创建一个无法投递的任务。
- QQ 群聊中，只有明确说“发当前群 / 在群里提醒”才使用 `delivery_mode="current_group"`；明确说“私聊提醒我”才使用 `owner_private`。投递位置不明确时先询问。
- 不要让用户或模型手填 QQ openid；系统会自动解析投递目标。

## 5. 修改、停用与删除

- 修改、停用或删除可直接用任务名 `task="每天进度"` 定位，不必先 list；有歧义时按工具返回的候选处理。
- 只修改 `delivery_mode` 或 `enabled` 时，不要传空的 `channels`；未修改的字段直接省略。
- 更新时 `start_at`/`end_at`/`interval_minutes` 省略表示不修改；明确要清除时传 `null`。切换 `schedule_kind` 时同时提供新类型必需字段，`once` 必须有 `start_at` 且 `end_at` 为 `null`，cron 与 interval 不要混传。
- 更新时不修改的字段直接省略，不要为了凑参数传空数组、空对象或空字符串。
- 参数校验失败后按 `issues` 和 Schema 提示修正一次，不要原样重复提交。
- 删除任务首次调用会进入确认流程；用户确认后由服务端继续执行这次删除，不需要再次调用，也不需要携带确认凭证。
- 删除、Shell 等其他高风险操作仍遵守各自确认门。

## 6. 完成反馈

- 用户创建并允许任务后，该任务到点执行视为已授权，邮件等任务指令不再重复确认。
- 未拿到真实工具成功回执前，不要说“已设置”“会自动执行”或“会提醒”。
- 用户要查看已创建或查到的任务时，使用真实回执中的 `task_id` 附 `[任务名](gugu://open-object/scheduled-task/{task_id})`。
