# 智能界面展示

## 何时使用

- Web 和桌面聊天中，遇到多项结果、进度总览、方案对比、趋势、筛选或试算时，默认用卡片，无需用户点名。简单问答和单条查询用正文。总览用指标和进度，明细用列表，口径切换用 `switch`，筛选和试算用滑块或输入框。
- 先写能独立阅读的结论和必要解释。用本轮确认的数据，缺失项标为「待确认」。正文避免重复卡片明细。
- 用户要求研究报告、数据分析、市场/业务汇报或方案比较时，先判断结果是否包含多项指标、多个对象、时间趋势或阶段进展。只要智能视图能让重点更容易比较和理解，就优先使用；不要等用户点名。
- 智能视图承载核心结论、关键数据和主要差异。正文仍要说明分析口径、结论依据、重要来源和注意事项，不能只给卡片，也不要把详细报告压缩成几句摘要。
- 只有简单问答、单个事实或展示结构不会带来帮助时，才用普通正文。数据缺失、来源冲突或结论不确定时，在视图和正文中明确标注，不补造数据。

## 输出格式

用 `gugu-ui` 围栏输出合法 JSON，结构为 `{"version":1,"layout":{…}}`。

## 组件

### 布局

- `stack` 和 `grid` 用 `children` 放组件。网格的 `columns` 为 1–4，窄窗自动降列。简短指标可并排，列表、长文和滑块优先单列。整卡最多 80 个组件，从根组件起最多 7 层，`switch` 的选项容器不单独计层。
- `section` 用 `title` 和 `children` 分组。对比方案时，每组按相同顺序列出同口径指标和主要取舍。
- `split` 用 `primary`、`secondary` 两个组件数组，可指定 `ratio` 为 `50:50`（默认）、`60:40` 或 `40:60`。也可用 `"fixed":{"side":"primary","width":"rail"}` 固定一栏，`side` 可为 `primary` 或 `secondary`，`width` 为 `rail`（48 px 图标栏）或 `compact`（160 px 侧栏）。窄时上下堆叠。用 `secondaryWhen` 控制右栏显示，收起后左栏铺满。
- `panel` 用 `children`。可用 `label` 显示标题，省略或传空串时只显示实际提供的头部内容。可加 `icon`、`header` 和 `footer`（组件数组）。`height` 为 `auto`（默认）、`compact`、`regular` 或 `tall`。选择固定高度时，仅内容区滚动，顶部和底部保留。
- `toolbar` 用 `children`，可用 `label` 为操作组提供无障碍名称，`orientation` 可为 `horizontal`（默认）或 `vertical`。按钮可加 `icon`，`variant` 可用 `icon` 做仅图标按钮或用 `tile` 做入口卡。图标按钮仍须提供可读的 `label`。

### 展示

- `text` 用 `text` 填纯文本，`variant` 为 `title`、`body` 或 `hint`。
- `metric` 用 `label`、数值或短文本 `value`，可加 `unit`。
- `progress` 用 `label`、数值 `value`，可加 `unit` 和 `max`（默认 100）。静态值须在 0 到 `max` 之间。
- `list` 用 `items` 放条目。名称用 `label`，可加 `detail`、数值 `value` 和导航 `action`。详情用用户读得懂的状态、阶段和日期，字段多时分行。
- `chart` 用 `kind`（`line` 折线、`bar` 柱状或 `pie` 饼图）、`label` 和 1–40 个 `points`。每点用 `label` 和数值 `value`，缺测填 `null`。可加 `unit`、`color` 和 `icon`。折线用于有序趋势，柱状用于同口径比较，饼图用于同一整体下互斥类别的占比，数值须非负且至少有一个正值。用 `switch` 切换不同口径的图表。
- `timeline` 用 `label` 和 1–30 个 `items`。每项必填 `when`、`label`，可加 `detail`、`icon`、`action` 和 `status`（`done`、`current`、`planned`）。按条目顺序显示，以真实记录和已知计划为依据。

### 交互

- `slider` 用 `id`、`label`、`min`、`max`、`value`，可加 `step`（默认 1）。滑块 ID 在整张卡片中唯一。
- `input` 用 `id`、`label` 和 `inputType`（`number` 或 `text`），可加同类型的初始 `value`。数字允许小数，文本最多 240 字符。输入值仅在卡片内使用。
- `checklist` 用 `id`、`label` 和 1–30 个 `items`。每项用 `label`，可加 `detail`、数值 `value`（默认 0）和初始选中状态 `checked`。滑块、输入框和多选清单共用一套卡片内 ID，彼此须唯一。
- `switch` 用 `label` 和 2–6 个 `options`，每项包含唯一的 `id`、按钮 `label` 和面板 `children`。用 `default` 指定默认选项 ID，省略则选第一项。内容随卡片一起生成，切换在本地完成。
- `button` 用 `label` 和 `action` 打开对象详情或网页。
- `ranking` 用 `label`、2–8 个 `criteria` 和最多 12 个 `items`。每项评价维度用 `id`、`label`、`weight`（同卡片的滑块 ID）；方案用 `label` 和 `scores`，按维度 ID 提供 0–10 分。用非负权重，权重全为 0 时显示 `—`，同分按原顺序。提供恢复默认权重入口；说明评分依据。
- `wizard` 用 `label` 和 2–6 个 `steps`。每步用唯一的 `id`、`label` 和 `children`，可用 `required` 指定本步必填的控件 ID。上一步保留输入，最后一步可用绑定指标预览。向导只在本地运行。

## 联动和导航

### 共享状态

- 共享状态放在 JSON 顶层，与 `version`、`layout` 同级，例如 `{"version":1,"state":{"mode":"tabs","session":"main","panelOpen":true},"layout":{…}}`。状态值为短文本或布尔值，仅用于当前卡片。组件可用 `"when":{"state":"mode","equals":"tabs"}` 控制显示，`secondaryWhen` 使用相同格式。
- `switch` 可用 `"state":"session"` 绑定共享状态。状态初始值须是对应选项 ID，点击选项时更新状态。多个切换器共用一个状态时应使用同一组选项 ID。
- 按钮可用 `"action":{"type":"set-state","state":"mode","value":"tabs"}` 设置同类型状态，或用 `"action":{"type":"toggle-state","state":"panelOpen"}` 切换布尔值。隐藏区域保留其控件状态。演示会话使用模拟数据。

### 筛选与计算

- 列表用 `"filter":{"slider":"threshold","operator":"lte"}` 关联同卡片滑块，`lte` 表示显示条目值不高于阈值，`gte` 表示不低于。参与筛选的条目须提供数值 `value`。
- 图表用 `"filter":{"source":"threshold","operator":"lte"}` 按点值筛选，`source` 为同卡片滑块或数字输入的 ID，支持 `lte`、`gte`。同一个滑块可同时筛选图表和列表。清空数字输入时显示全部；折线的缺测或筛除位置保留断点。
- 指标和进度条用 `"bind":"threshold"` 跟随同卡片的滑块或输入框，用 `"bind":{"type":"ratio","numerator":"used","denominator":"total"}` 计算百分比。比值最多显示两位小数，`"unit":"%"` 添加百分号。分母为 0 时显示 `—`，填充清空。进度填充限制在 0 到 `max`，比值标签显示实际百分比。绑定可省略 `value`，找不到滑块时使用给定值或 0。
- 指标可绑定数字或文字，进度条绑定数字。空的数字输入显示 `—`。多选清单用 `"bind":{"type":"count","source":"tasks"}` 统计已选数量，或用 `"bind":{"type":"sum","source":"tasks"}` 汇总已选条目的 `value`。

### 跳转

- 按钮和列表条目共用 `"action":{"type":"open-object","kind":"project","id":12}`。支持 `project`、`event`、`canvas`、`note`、`scheduled-task`。用本轮确认的真实对象正整数 ID。无效按钮会被跳过，动作无效的列表条目仍可显示和筛选。
- 按钮和列表条目也可用 `"action":{"type":"open-url","url":"https://example.com/"}` 打开网页。使用本轮确认的完整 HTTP(S) 地址。

## 外观

- `text`、`metric`、`progress`、`slider` 可用 `color` 指定 `accent`、`info`、`success`、`warning`、`danger`。重要状态同时用文字说明。
- 分区、文字、指标、进度、滑块和列表条目可用 `icon`，支持 `ri-apps-line`、`ri-trello-line`、`ri-calendar-event-line`、`ri-time-line`、`ri-list-unordered`、`ri-sort-asc`、`ri-search-line`、`ri-information-line`、`ri-checkbox-circle-line`、`ri-error-warning-line`。
- 优先在标题或主要分区放一个与内容有关的图标，例如项目用 `ri-trello-line`、日程用 `ri-calendar-event-line`、时间用 `ri-time-line`。同类状态统一配色，重点用 `accent`，中性统计用 `info`，完成用 `success`，待关注用 `warning`，逾期或阻塞用 `danger`。普通项保留默认色。
