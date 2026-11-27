---
name: 思维笔记
description: 用于查找、创建、编辑、恢复普通时间流 Markdown 笔记，并引用文件、项目或活动。
category: notes
related_tools: note_search, note_get, note_create, note_update, note_delete, note_restore, note_undo, open_item
emoji: 📝
---

# 思维笔记技能

## 能力边界与工具路由

本 Skill 只处理普通思维笔记，也就是思维面板的时间流 `note`：写笔记、写日记、更新正文和读取已有笔记。

- 搜索普通笔记或全局查找笔记/画布便签：使用固定工具名 `note_search`，传 `query`。
- 读取搜索结果的完整正文：使用固定工具名 `note_get`，传 `node_id`。
- `related` 是已建立关系边的一跳邻居；正文中的 @ 引用由 `references` 返回。项目和活动携带真实 ID，文件携带路径引用。桌面的 `note_get` 会返回可访问文件的真实绝对路径，供后续读取。
- 创建、更新或删除普通时间流笔记：使用本 Skill 的 `note_create`、`note_update`、`note_delete` 等工具。
- 指定画布、搜索画布节点、创建画布便签、放置项目/文件、连接节点：改用 `canvas` Skill，不要用 `note_create` 代替 `canvas_create_note`。
- `canvas_search` 只搜索指定画布内容，需要 `canvas_id`；它不是普通笔记搜索工具。
- 工具名必须逐字使用 canonical name，不要把 `note_search` 改写成 `search_notes`，也不要猜测 `list_notes`、`read_note` 等别名。

普通笔记统一使用 Markdown。创建用 `markdown`，追加用 `append_markdown`。标题写在首行 `# 标题`，待办用 `- [ ]` 和 `- [x]`，加粗、列表、引用和围栏代码按 Markdown 书写。

- 引用文件时，先通过文件工具查到目标，调用 `open_item` 并传 `reference_only: true`，使用返回的 `link` 写成 `[文件名](链接)`。工作区使用路径引用，桌面宿主机文件遵循本机授权。不要自己编码引用，也不要填数字文件 ID。桌面回执同时有真实绝对路径 `location.value` 时，把它原样作为行内代码写在文件引用旁，方便以后读取；点击仍使用 `link`。
- 引用项目或活动时，使用工具确认过的 ID 写成 `[名称](gugu://open-object/project/ID)` 或 `[名称](gugu://open-object/event/ID)`。保存后会显示可点击的引用。
- 颜色参数只传 `amber`、`sage`、`teal`、`sky`、`indigo`、`lavender`、`rose` 或 `null`。

## 更新前先读取最新正文

- 更新已有正文必须先调用 `note_get` 获取最新 `numbered_content`，再选择追加、按行编辑或原文替换；不要使用几轮之前缓存的行号。
- 指定行编辑使用 `line_edits`。数字目标必须带对应的 `expected` 原文；校验失败就重新读取，不能猜行号。
- 正文更新方式互斥。原文只有一个匹配时优先用 `find_replace`，从 `content_md` 复制原文。
- `target_lines` 支持 `8`、`8-11`、`8,11`，整篇使用 `all`；`content: ""` 表示删除。多个范围不能重叠，工具会按倒序处理行号变化。
- 删除旧内容应直接使用行编辑，不要在末尾追加“作废说明”冒充删除。

## 标题与结果链接

- 用户可见标题写入 Markdown 正文首行。独立的 `title` 只用于搜索和列表索引。
- 更新前用 `note_search` 和 `note_get` 确认目标，`note_update` 必须传真实的 `node_id`。
- 用户需要回到笔记时，回复里附 `[笔记标题](gugu://open-object/note/{node_id})`，使用本轮返回的 ID。

## 长内容与结果核验

长笔记可先用 `note_create` 保存标题和第一段，再用 `note_update` 的 `append_markdown` 分段追加。每次根据工具回执确认写入结果。
