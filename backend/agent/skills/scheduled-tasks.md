---
name: 定时任务
description_short: 用户要设置定时提醒、周期任务或到点执行时使用。
description_long: "要设定时/周期任务、或要「到点提醒/提前X分钟叫我」时，怎么用 *_scheduled_task 建任务、cron 怎么写、渠道怎么选、日历提醒怎么配。场景：create/update/delete scheduled_task、一次性 @once、提醒。"
category: scheduling
related_tools: list_scheduled_tasks, create_scheduled_task, update_scheduled_task, delete_scheduled_task
emoji: ⏰
---

# 定时任务技能

## 建 / 改 / 删
- `create_scheduled_task` **一次带齐** name + instruction + cron + channels，别多轮试探。
- 参数必须遵守工具 schema：`channels` 是字符串数组，不是字符串，也不是对象。邮件示例：`channels=["email"]`；QQ 示例：`channels=["qq"]`；多渠道示例：`channels=["web", "email", "qq"]`。不要写 `channels="qq"`、`channels={"item":"qq"}` 或额外添加 `item` 字段。
- 创建示例：`{"name":"GTA6 首播提醒","instruction":"提醒我查看首播资讯","cron":"@once:2026-08-28T08:50:00","channels":["qq"]}`。修改渠道时同样传数组，例如 `{"task":"GTA6 首播提醒","channels":["qq"]}`。
- **cron 你直接生成**（「分 时 日 月 周」，Asia/Shanghai）：每天 9 点 `0 9 * * *`、每周一 `* * * * 1`、只跑一次 `@once:2026-06-30T09:00`。
- **对用户只说人话时间**（「每天早上 9 点」「6 月 30 号 9 点」），**绝不把 cron 串甩给用户**——那是内部格式。
- 改 / 停 / 删**直接用任务名**定位（`task="每天进度"`），不用先 list；歧义时工具会回候选。
- 建 / 改前把「几点、做什么、发哪个渠道」**复述确认**再落（到点无人值守自动跑）。
- 用户创建并允许任务后，任务到点执行视为已授权：邮件等任务指令不再重复弹确认；删除、Shell 等其它高风险操作仍遵守各自确认门。
- 如果只修改 `delivery_mode` 或 `enabled`，不要为了凑参数传空的 `channels`；不修改的字段直接省略。参数校验失败后先按 `issues` 和 schema hint 修正一次，不要原样重复提交。
- 删除任务收到确认后，`confirm` 必须传 JSON 布尔值 `true`，不是字符串 `"true"`；同时保留 `confirm_token`。工具参数中的数组、布尔值和数字都不要包成字符串。

用户要查看刚创建或查到的任务时，在回复中附 `[任务名](gugu://open-object/scheduled-task/{task_id})`；只使用本轮真实结果中的 `task_id`。

## 渠道
- `email` 会发送到当前用户注册邮箱，使用咕咕 `reminder` 邮件模板和用户主题/配色；页面创建并授权的任务到点不会再次弹邮件确认。SMTP 未配置或发送失败时，结果会显示脱敏失败原因。
- 设 `feishu` / `qq` / `wechat` 渠道前，先确认用户绑了对应 IM，否则到点投递不到、白设；**默认 `web` 站内通知最稳**。
- QQ 投递目标按语义选择：**网页创建的任务固定私聊绑定用户**；QQ 私聊中默认私聊当前用户。在 QQ 群聊中，明确说“发当前群 / 在群里提醒”才用 `delivery_mode=current_group`，明确说“私聊提醒我”才用 `owner_private`；只说“提醒我”这类没有指明位置的话，先问清楚再创建或修改。
- 不要让用户或模型手填 QQ openid；系统会从当前群会话或已绑定的 owner 身份自动保存目标。群聊中如果没有明确投递模式，工具会要求先确认，不会静默选择地址。

## 日历提醒 = 必须建一次性定时任务
- **日历事件本身不会主动提醒**（系统不到点通知）。用户要「提前 X 分钟提醒 / 到点叫我 / 记得提醒我」时：
  - 建完事件**必须**再 `create_scheduled_task` 建一次性提醒：`cron="@once:<提醒时刻>"`（= 事件时间减提前量，Asia/Shanghai；提前量没说默认提前 30 分钟；**事件时间没说清就先问、别瞎定**），instruction 写要提醒的话（如「提醒用户：20:46 跟徒弟交换意见」），channels 默认 `web`。
