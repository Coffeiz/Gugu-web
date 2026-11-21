---
name: 智能界面展示
description: 在 Web 和桌面聊天中展示数据、比较方案和提供本地交互。
category: presentation
---

# 智能界面展示

先写可独立阅读的摘要，再用 `gugu-ui` 围栏输出合法 JSON，结构为 `{"version":1,"layout":{…}}`。只用本轮确认的数据，缺失信息标为「待确认」。即时通讯只发送摘要和必要条目。

## 组件

- `stack` 和 `grid` 用 `children` 放组件。网格的 `columns` 为 1–3，窄窗自动降列。简短指标可并排，列表、长文和滑块优先单列。
- `section` 用 `title` 和 `children` 分组。对比方案时，每组按相同顺序列出同口径指标和主要取舍。
- `text` 用 `text` 填纯文本，`variant` 为 `title`、`body` 或 `hint`。
- `metric` 用 `label`、数值或短文本 `value`，可加 `unit`。
- `progress` 用 `label`、数值 `value`，可加 `unit` 和 `max`（默认 100）。静态值须在 0 到 `max` 之间。
- `slider` 用 `id`、`label`、`min`、`max`、`value`，可加 `step`（默认 1）。滑块 ID 在整张卡片中唯一。
- `switch` 用 `label` 和 2–6 个 `options`，每项包含唯一的 `id`、按钮 `label` 和面板 `children`。用 `default` 指定默认选项 ID，省略则选第一项。内容随卡片一起生成，切换在本地完成。
- `button` 用 `label` 和 `action` 打开对象详情。
- `list` 用 `items` 放条目。每项用 `label`，可加 `detail`、数值 `value` 和导航 `action`。
- 展示多条对象详情时用 `list`，名称放 `label`，状态、阶段和日期等放 `detail`，字段多时分行。将已知的状态和优先级写成用户可读的名称，只有用户需要对照原始数据时才显示内部字段值。
- 文字视图先用一句话概括，逐项说明时每项单独成段。

## 联动和导航

- 列表用 `"filter":{"slider":"threshold","operator":"lte"}` 关联同卡片滑块，`lte` 表示显示条目值不高于阈值，`gte` 表示不低于。参与筛选的条目须提供数值 `value`。
- 指标和进度条用 `"bind":"threshold"` 跟随同卡片滑块，或用 `"bind":{"type":"ratio","numerator":"used","denominator":"total"}` 计算百分比。比值最多显示两位小数，`"unit":"%"` 添加百分号。分母为 0 时显示 `—`，填充清空。进度填充限制在 0 到 `max`，比值标签显示实际百分比。绑定可省略 `value`，找不到滑块时使用给定值或 0。
- 按钮和列表条目共用 `"action":{"type":"open-object","kind":"project","id":12}`。支持 `project`、`event`、`canvas`、`note`、`scheduled-task`。用本轮确认的真实对象正整数 ID。无效按钮会被跳过，动作无效的列表条目仍可显示和筛选。

## 外观

- `text`、`metric`、`progress`、`slider` 可用 `color` 指定 `accent`、`info`、`success`、`warning`、`danger`。重要状态同时用文字说明。
- 分区、文字、指标、进度、滑块和列表条目可用 `icon`，支持 `ri-apps-line`、`ri-trello-line`、`ri-calendar-event-line`、`ri-time-line`、`ri-list-unordered`、`ri-sort-asc`、`ri-search-line`、`ri-information-line`、`ri-checkbox-circle-line`、`ri-error-warning-line`。
