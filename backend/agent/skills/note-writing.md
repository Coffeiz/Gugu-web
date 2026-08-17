---
name: 思维笔记
description: 用 create_note / update_note 记笔记、写日记、笔记要带样式（加粗/列表/引用/代码块）或挂关联（项目/文件/日程）时——拿 blocks 正确写法、易错点和长内容分批写的策略
emoji: 📝
---

`blocks` 这个参数没有严格的语法约束，工具描述里的 schema 更多是"帮你看懂形状"，不是"逼你必须"——**照抄下面的正确示范，别自己发挥结构**，越贴着示范写，越不容易被工具拦下来重试。

## 8 种块类型，照抄这几个形状

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

## ⚠️ 三个已知会写错的地方，务必照示范来

1. **`bullet_list`/`ordered_list` 的 `items`、`blockquote` 的 `paragraphs`，每一项必须是 `{"content":[行内...]}` 这种对象，不能直接是 `[行内...]` 这种裸数组**（`items:[[...]]` 这种"数组套数组"的写法是错的，工具会报"行内内容只支持 text 或 reference"）。跟 `task_list` 的 `{"checked":...,"content":[...]}` 是同一个套路——都是"一层数组 + 对象包 content"，别为了省事写成嵌套数组。
2. **`task_list` 的每一项必须带 `checked`（布尔值）**，漏了会报"待办项必须包含 checked 布尔值"。
3. **`reference` 的 `ref_id` 必须是整数**，不能传字符串（`"60"` 不行，要 `60`）；`ref_type` 只能是小写的 `project`/`file`/`event`。

一旦收到报错，**别猜、别绕远路排查**——直接对照上面的示范，逐字核对这次传的结构哪里跟示范不一样，通常是漏了 `checked`、把 `items` 写成了嵌套数组、或者 `reference` 漏了 `ref_id`。

## 标题写在哪（重要）

- **用户可见的标题 = `blocks` 里第一个 `heading` 块**，它渲染成便签卡片正文首行的 `# 标题`，用户能看到。
- `create_note` / `update_note` 的 `title` 参数**用户看不到**——它只进搜索和列表索引。**不要**把标题只填在 `title` 参数里而不写 heading 块。
- 正确示范：标题用 heading 块，正文用 paragraph 等块跟在后面：

```json
[
  {"type":"heading","content":[{"type":"text","text":"本周复盘"}]},
  {"type":"paragraph","content":[{"type":"text","text":"做了三件事……"}]}
]
```

## 内容长就分批写，别一次塞一个大 blocks

日记、长笔记这种内容多的场景，一次性把所有内容塞进一个巨大的 `blocks` 数组，容易因为输出长度限制被截断（截断后参数解析失败，报错甚至可能整轮出错）。**更稳妥的做法**：

1. 先用 `create_note` 起个头（比如第一段或前几个块），拿到 `node_id` 和 `version`。
2. 再用一次或几次 `update_note` 的 `append_blocks` 往后续写，每次只追加一小段。

这样任何一次调用的参数体量都比较小，不容易撞到输出长度上限，出错了也只影响这一小段、不用整篇重来。
