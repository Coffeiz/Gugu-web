---
name: 思维笔记
description_short: 创建、搜索、读取和更新普通时间流笔记；画布便签请用 canvas。
description_long: 处理普通时间流笔记和日记的创建、搜索、读取、更新与结构化编辑；搜索用 note_search，读取用 note_get，画布便签改用 canvas。
category: notes
related_tools: note_search, note_get, note_create, note_update, note_delete, note_restore, note_undo
emoji: 📝
---

# 思维笔记技能

## 能力边界与工具路由

本 Skill 只处理普通思维笔记，也就是思维面板的时间流 `note`：写笔记、写日记、更新正文和读取已有笔记。

- 搜索普通笔记或全局查找笔记/画布便签：使用固定工具名 `note_search`，传 `query`。
- 读取搜索结果的完整正文：使用固定工具名 `note_get`，传 `node_id`。
- 创建、更新或删除普通时间流笔记：使用本 Skill 的 `note_create`、`note_update`、`note_delete` 等工具。
- 指定画布、搜索画布节点、创建画布便签、放置项目/文件、连接节点：改用 `canvas` Skill，不要用 `note_create` 代替 `canvas_create_note`。
- `canvas_search` 只搜索指定画布内容，需要 `canvas_id`；它不是普通笔记搜索工具。
- 工具名必须逐字使用 canonical name，不要把 `note_search` 改写成 `search_notes`，也不要猜测 `list_notes`、`read_note` 等别名。

`blocks` 由工具 Schema 和服务端共同严格校验。**只使用下面的对象层级，不要自行递归或包装数组**。

硬性规则：列表和待办只支持扁平结构；列表项内不能继续出现列表、`content` 或 `paragraphs` 对象。`content` 数组里的每个行内对象都必须带 `type`。`blocks`、`items`、`paragraphs`、`content` 都必须保持数组，禁止改成 `{item:[...]}`。

颜色参数只传语义值：`amber`、`coral`、`blue`、`teal` 或 `null`；不要传“青色渐变”、十六进制值或 CSS。

## 更新前先读取最新正文

- 更新已有正文必须先调用 `note_get` 获取最新 `numbered_content`，再决定使用追加或行编辑；不要使用几轮之前缓存的行号。
- 指定行编辑使用 `mode: "line_edit"` 和 `line_edits`。数字目标必须带对应的 `expected` 原文；校验失败就重新读取，不能猜行号。
- `target_lines` 支持 `8`、`8-11`、`8,11`，整篇使用 `all`；`content: ""` 表示删除。多个范围不能重叠，工具会按倒序处理行号变化。
- 删除旧内容应直接使用行编辑，不要在末尾追加“作废说明”冒充删除。

## 内容 Schema

```json
[
  {"type":"paragraph","content":[{"type":"text","text":"一段普通文字"}]},
  {"type":"heading","content":[{"type":"text","text":"标题"}]},
  {"type":"bullet_list","items":[
    {"content":[{"type":"text","text":"第一项"}]},
    {"content":[{"type":"text","text":"第二项"}]}
  ]},
  {"type":"ordered_list","items":[
    {"content":[{"type":"text","text":"第一步"}]},
    {"content":[{"type":"text","text":"第二步"}]}
  ]},
  {"type":"task_list","items":[
    {"checked":false,"content":[{"type":"text","text":"待办事项"}]}
  ]},
  {"type":"blockquote","paragraphs":[
    {"content":[{"type":"text","text":"引用的话"}]}
  ]},
  {"type":"code_block","code":"print('hi')","language":"python"},
  {"type":"horizontal_rule"}
]
```

**行内内容**（`content` 数组里的元素）只有两种：
- 文本：`{"type":"text","text":"...","marks":[{"type":"bold"}]}`（`marks` 可省略；可选 `bold`/`italic`/`strike`/`code`/`link`，`link` 要带 `{"type":"link","href":"https://..."}`）
- 引用：`{"type":"reference","ref_type":"project"|"file"|"event","ref_id":123,"label":"显示名"}`——**`ref_id` 必填，三种 `ref_type` 都要**，漏传会被拦（`file`/`event` 类型尤其容易漏，因为用得少）。

## 常见 Schema 错误

1. **`bullet_list`/`ordered_list` 的 `items`、`blockquote` 的 `paragraphs`，每一项必须是 `{"content":[行内...]}` 这种对象，不能直接是 `[行内...]` 这种裸数组**。跟 `task_list` 的 `{"checked":...,"content":[...]}` 是同一个套路。
2. **`task_list` 的每一项必须带 `checked`（布尔值）**，漏了会报"待办项必须包含 checked 布尔值"。
3. **`reference` 的 `ref_id` 必须是整数**，不能传字符串（`"60"` 不行，要 `60`）；`ref_type` 只能是小写的 `project`/`file`/`event`。

一旦收到 schema 报错，**重新生成完整的 `blocks`/`append_blocks`**，不要只给某个嵌套对象补字段，也不要把数组改成 `item` 对象。无法确定的内容不要猜，先向用户确认。

## 标题位置

- **用户可见的标题 = `blocks` 里第一个 `heading` 块**，它渲染成便签卡片正文首行的 `# 标题`，用户能看到。
- 用户要查看或回到刚创建/查到的时间流笔记时，在回复中附 `[笔记标题](gugu://open-object/note/{node_id})`；ID 只使用本轮真实结果中的 `node_id`。
- `note_create` / `note_update` 的 `title` 参数**用户看不到**——它只进搜索和列表索引。**不要**把标题只填在 `title` 参数里而不写 heading 块。
- 正确示范：标题用 heading 块，正文用 paragraph 等块跟在后面：

```json
[
  {"type":"heading","content":[{"type":"text","text":"本周复盘"}]},
  {"type":"paragraph","content":[{"type":"text","text":"做了三件事……"}]}
]
```

## 长内容与结果核验

日记、长笔记这种内容多的场景，一次性把所有内容塞进一个巨大的 `blocks` 数组，容易因为输出长度限制被截断（截断后参数解析失败，报错甚至可能整轮出错）。**更稳妥的做法**：

1. 先用 `note_create` 起个头（比如第一段或前几个块），拿到 `node_id` 和 `version`。
2. 再用一次或几次 `note_update` 的 `append_blocks` 往后续写，每次只追加一小段。

这样任何一次调用的参数体量都比较小，不容易撞到输出长度上限，出错了也只影响这一小段、不用整篇重来。
