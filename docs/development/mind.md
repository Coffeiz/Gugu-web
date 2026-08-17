# 咕咕画布 / 便签（Mind）约定

本文件是 Mind 画布、时间流便签的专项约定；**通用内容卡片规则（标题可见性、自查流程）见 AGENTS.md「内容卡片约定」章节**，本文件只保留 Mind 专项细节。

## 便签的内容模型

时间流便签（`mind_nodes`，kind 含 `note` / `canvas_note` 等）有两个内容字段：

| 字段 | 语义 | 用户在哪能看到 |
|---|---|---|
| `content_md` | 正文（Markdown），标题存正文首行 `# xxx` | 画布便签卡片、卡片预览、编辑框 |
| `title` | 标题元数据（搜索/列表/API 用） | 画布便签卡片不显示；仅搜索、列表、API 返回值 |

标题可见性遵守 AGENTS.md 通用规则：**用户可见标题必须写在 `content_md` 首行 `# xxx`，`title` 字段不承担用户可见信息**。

### 画布便签卡片的标题规则

只读视图共用 `frontend/src/composables/useMindEditor.ts` 的 `splitMindTitleBody()`：

- 取 `content_md` 第一个非空行；
- 若首行是 `# xxx`（一到六级标题）→ 摘出为卡片标题，其余为正文；
- 若首行是普通文本 → 没有标题区，整段按正文渲染（第一行就是正文开头）。

### 城市便签反例（曾踩的坑）

`title='合肥'` 但 `content_md` 首行是 `安徽` → 用户在画布上看到的"标题"是 `安徽`，城市名反而看不到。正确写法：

```markdown
# 合肥
安徽
商合杭、京港
主要客运站：合肥站、合肥南站、合肥西站
```

## 搜索对 title 的依赖

`app/api/v1/search.py` 的搜索同时匹配 `title` 与 `content_plain`，且 `title` 精确/前缀命中加权更高，结果展示也优先用 `title`。因此 `title` 字段**不能删除**，它是搜索质量与结果标题的依赖。

## 画布便签的版本与软删

- 更新走乐观并发：`update_mind_note(db, node_id, user_id, client_version, fields)`，`client_version` 不匹配则失败。
- 删除为软删（`deleted_at`），查询一律过滤 `deleted_at IS NULL`。
