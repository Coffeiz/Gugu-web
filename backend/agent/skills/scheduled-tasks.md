---
name: 定时任务
description_short: 用户要设置独立定时任务、周期任务或到点执行时使用；日程自带提醒直接用日历工具。
description_long: "要设定时/周期执行任务时，怎么用 *_scheduled_task 建任务、cron 怎么写、渠道怎么选；并区分日历活动自带提醒。场景：create/update/delete scheduled_task、一次性 @once。"
category: scheduling
related_tools: list_scheduled_tasks, create_scheduled_task, update_scheduled_task, delete_scheduled_task, create_event, add_event_reminder, list_event_reminders, remove_event_reminder
emoji: ⏰
---

# 定时任务技能

## 1. 先判断提醒对象

先判断用户要提醒的是“一个日程活动”，还是“到点执行一件独立的事”：

- 创建日程/活动并提醒，或给已有日程设置提前提醒 → 使用日程自己的提醒。
- 到点查询、汇总、发消息、执行复杂流程，或每天/每周重复执行 → 使用独立定时任务。
- 单纯“日程 + 提醒”不要拆成两个对象；只有用户明确要求“日程 + 独立执行任务”时才同时创建。

## 2. 日程活动提醒

- 新建活动：在 `create_event` 中传 `reminders=[提前分钟数]`，可一次传多个提前量；不要再调用 `create_scheduled_task`。
- 已有活动：使用 `add_event_reminder`。
- 查看或删除活动提醒：使用 `list_event_reminders` / `remove_event_reminder`。
- 活动提醒绑定 `event_id`，跟随活动管理和删除，不属于独立定时任务列表。

## 3. 创建独立定时任务

- `create_scheduled_task` 一次带齐 `name`、`instruction`、`cron`、`channels`，不要多轮试探。
- 建立前复述“几点、做什么、发哪个渠道”；用户确认后再创建。
- 创建示例：`{"name":"资讯汇总","instruction":"汇总当天资讯并提醒我","cron":"@once:2026-08-28T08:50:00","channels":["web"]}`。
- 只跑一次使用 `@once:YYYY-MM-DDTHH:MM`；周期任务使用 cron。时区为 Asia/Shanghai。
- cron 由咕咕生成，但回复用户时只说人话时间，不要展示 cron 字符串。

## 4. 参数与渠道

- `channels` 必须是字符串数组，例如 `channels=["email"]`、`channels=["qq"]` 或 `channels=["web", "email", "qq"]`；不要传字符串、对象或额外的 `item` 字段。
- 错误示例：不要传 `channels="qq"` 或 `channels={"item":"qq"}`。
- `email` 发送到用户注册邮箱并使用 `reminder` 模板；默认 `web` 站内通知最稳。
- 使用 `feishu` / `qq` / `wechat` 前，先确认对应 IM 已绑定，否则不要创建一个无法投递的任务。
- QQ 群聊中，只有明确说“发当前群 / 在群里提醒”才使用 `delivery_mode="current_group"`；明确说“私聊提醒我”才使用 `owner_private`。投递位置不明确时先询问。
- 不要让用户或模型手填 QQ openid；系统会自动解析投递目标。

## 5. 修改、停用与删除

- 修改、停用或删除可直接用任务名 `task="每天进度"` 定位，不必先 list；有歧义时按工具返回的候选处理。
- 只修改 `delivery_mode` 或 `enabled` 时，不要传空的 `channels`；未修改的字段直接省略。
- 更新时不修改的字段直接省略，不要为了凑参数传空数组、空对象或空字符串。
- 参数校验失败后按 `issues` 和 Schema 提示修正一次，不要原样重复提交。
- 删除任务首次调用会进入确认流程；用户确认后直接重新调用同一工具，不需要携带确认凭证。
- 删除、Shell 等其他高风险操作仍遵守各自确认门。

## 6. 完成反馈

- 用户创建并允许任务后，该任务到点执行视为已授权，邮件等任务指令不再重复确认。
- 未拿到真实工具成功回执前，不要说“已设置”“会自动执行”或“会提醒”。
- 用户要查看已创建或查到的任务时，使用真实回执中的 `task_id` 附 `[任务名](gugu://open-object/scheduled-task/{task_id})`。
