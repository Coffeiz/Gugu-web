# 思维画布咕咕工具 PRD

> 状态：Phase 0–5 已完成，待人工验收
> 创建：2026-08-15
> 最近更新：2026-08-15
> 关联文档：[`思维面板/咕咕工具设计.md`](../思维面板/咕咕工具设计.md)、[`思维面板/数据模型草案.md`](../思维面板/数据模型草案.md)、[`思维面板/实现方案.md`](../思维面板/实现方案.md)

## 1. 易读概述

### 1.1 要解决的问题

目前咕咕可以搜索和维护时间流笔记，但不能真正操作思维画布。用户只能自己打开画布、查找项目或文件、拖动节点、创建连接和编辑便签。

本 PRD 为咕咕增加一组受权限和确认机制保护的画布工具，使用户可以用自然语言完成：

- 创建和选择画布；
- 查找可以放入画布的项目、文件和活动；
- 创建画布专属便签；
- 将业务对象放入画布并安排位置；
- 移动、调整大小、折叠和移除画布节点；
- 创建和删除节点连接；
- 读取用户最后查看的画布区域、平移位置和缩放比例；
- 根据“当前视野中央”“某节点旁边”等语义放置节点。

咕咕操作的是后端领域数据，不模拟鼠标，也不直接调用前端 Runtime。网页画布通过已有数据 API、实时版本号或刷新机制显示变化。

### 1.2 最重要的边界

普通时间流笔记和画布便签不是同一种东西：

| 对象 | 是否能被放入画布 | 说明 |
|---|---:|---|
| `note` 普通时间流笔记 | 否 | 继续由现有 `MindSkill` 管理 |
| `canvas_note` 画布便签 | 创建时直接位于画布 | 不进入时间流 |
| 项目引用 | 是 | 以 `ref` 节点放入 |
| 文件引用 | 是 | 以 `ref` 节点放入 |
| 日历活动引用 | 是 | 以 `ref` 节点放入 |

“搜索可放置对象”和“搜索画布已有内容”必须是两个不同语义，避免咕咕把普通笔记误当成画布节点。

### 1.3 典型对话

用户：

> 新建一个“发布计划”画布，把发布项目、相关文件放进去，再在当前视野中央写一张便签，把它们连起来。

咕咕应执行：

```text
列出画布 → 创建画布 → 搜索可放置对象 → 放入项目/文件
→ 创建画布便签 → 创建连接 → 返回操作结果
```

用户：

> 把接口文档放到我现在看到的画布右上角。

咕咕应读取最后一次视口的 camera 和 viewport，计算世界坐标后放置，而不是把屏幕坐标直接写入节点位置。

## 2. 当前状态与复用范围

### 2.1 已有能力

后端已经具备画布 API 和三层数据模型：

- `MindMap`：画布容器和画布级 `data_json`；
- `MindNode`：普通笔记、画布便签和业务引用节点；
- `MindCanvasItem`：节点在画布中的位置、尺寸、折叠和层级；
- `MindRelation`：节点之间的关系，默认 `related` 关系支持归一和幂等；
- 画布的创建、读取、更新、删除；
- 画布项目的放入、更新、置顶和移除；
- 画布便签创建；
- 节点关系创建和删除；
- 项目、文件、活动引用节点创建。

现有 `MindSkill` 已支持：

- `note_search`；
- `note_get`；
- `note_create`；
- `note_update`；
- `note_delete` / `note_restore`；
- `note_undo`。

### 2.2 本 PRD 新增的部分

本 PRD 只规划 Agent 工具层、权限边界、领域服务复用、摄像机视口语义和测试，不重新设计画布 Runtime。Runtime 继续负责网页端的拖拽、连接点、摄像机交互和动画。

### 2.3 Phase 0 审计结论（已完成）

- `note`、`canvas_note` 和 `ref` 的数据边界已确认；普通时间流 `note` 不进入可放置对象搜索。
- `MindMap`、`MindNode`、`MindCanvasItem`、`MindRelation` 已覆盖画布工具需要的容器、节点、摆放和关系数据。
- 项目、文件、活动引用已有 `ref_type + ref_id` 复用约束；写入时继续复用 `get_owned()` 和现有引用创建服务。
- 关系创建已有 `upsert_relation()` 的归一、幂等和自连接校验；第一版工具只开放 `related`。
- 当前画布 camera 已保存在 `MindMap.data_json` 的 `x/y/scale` 字段，前端 `saveCanvasView()` 会持久化并在打开时恢复；第一版直接读取这套字段，不新增表。
- 当前画布是用户私有资源，因此第一版不引入共享画布权限；群聊访问私人画布必须在后续共享授权模型完成后开放。
- 只读工具应返回世界坐标和 camera 视口信息，不能把屏幕坐标写入 `MindCanvasItem.x/y`。

## 3. 产品目标与非目标

### 3.1 目标

1. 咕咕能够可靠查找并操作当前用户有权限的画布对象。
2. 用户可以用自然语言创建、放置、编辑和连接画布节点。
3. 节点位置同时支持世界坐标和视口语义锚点。
4. 普通 `note` 不会被误放入画布。
5. 所有操作可追踪、可幂等、可验证，重试不会重复创建对象或连接。
6. 群聊场景不会因为工具参数而越权读取用户私人画布。

### 3.2 非目标

- 不让咕咕直接操作浏览器 DOM 或 Runtime。
- 第一版不自动推断和创建大量语义关系。
- 第一版不做复杂自动布局和强制重排整张画布。
- 不把普通时间流笔记转换成画布节点。
- 不绕过现有项目、文件、活动和用户归属校验。
- 不把群成员默认变成私人画布的读写者。
- 不在本 PRD 中实现通用 RAG、embedding 或跨来源知识图谱。

## 4. 领域概念和数据规则

### 4.1 节点类型

| `MindNode.kind` | 含义 | 工具可见范围 |
|---|---|---|
| `note` | 时间流笔记 | 仅现有笔记工具 |
| `canvas_note` | 画布专属便签 | 画布搜索、编辑、连接 |
| `ref` | 项目/文件/活动等业务引用 | 可放置、搜索、连接 |
| `suggestion` | 未来的咕咕建议节点 | 本期不开放 |

`ref` 节点通过 `ref_type + ref_id` 指向业务对象，放置前必须经过当前用户归属校验。搜索业务对象本身不应为了返回结果而批量创建 `MindNode`；真正执行放置时才创建缺失的引用节点。

### 4.2 画布项和节点分离

一个节点可以被放入多张画布；从画布移除只删除 `MindCanvasItem`，不删除节点本体。画布便签删除则根据明确的删除工具删除节点及其画布项。

### 4.3 关系规则

第一版只开放 `related`：

- 默认无向语义；
- 服务端按节点 ID 归一；
- 同一用户的同一对节点默认幂等；
- 禁止自连接；
- 删除关系需要精确的 `relation_id`；
- `supports`、`causes`、`derived_from` 等有向关系留到后续版本。

## 5. 工具设计

建议新增独立的 `MindCanvasSkill`，而不是把全部画布动作塞进一个 `mind_canvas_action` 工具。每个工具职责单一，模型更容易选对，服务端也更容易做权限和确认。

### 5.1 画布列表

```ts
canvas_list({
  project_id?: number,
  limit?: number,
  offset?: number
})
```

返回当前用户可访问的画布摘要：

```json
{
  "canvases": [
    {
      "canvas_id": 12,
      "title": "发布计划",
      "project_id": 7,
      "updated_at": "2026-08-15T08:00:00Z",
      "last_viewed_at": "2026-08-15T08:10:00Z",
      "node_count": 8
    }
  ],
  "total": 1
}
```

### 5.2 读取画布

```ts
canvas_get({
  canvas_id: number,
  include_nodes?: boolean,
  include_relations?: boolean,
  include_content?: boolean,
  limit?: number
})
```

默认返回节点摘要，不把所有长正文塞入上下文。`include_content` 只在用户明确要求读取正文时使用。

返回内容包含：

- 画布元数据；
- 节点和画布项；
- 节点布局的有效尺寸、默认尺寸和推荐间距，供 Agent 排布时避让卡片；坐标按左上角解释，放置/移动不得造成节点矩形重叠；节点在上、下、左、右任一方向相邻时，默认边缘安全距离均为 150px，采用中心点排布时至少保持 750px 中心距；
- 连接关系；
- 最后一次画布视口；
- 截断和权限提示。

### 5.3 搜索画布已有内容

```ts
canvas_search({
  canvas_id: number,
  queries?: string[],
  types?: ["canvas_note", "project", "file", "event"],
  include_content?: boolean,
  limit?: number,
  offset?: number
})
```

只返回指定画布中已有的 `canvas_note` 和业务引用节点。普通 `note` 不返回。

```json
{
  "canvas_id": 12,
  "matches": [
    {
      "item_id": 88,
      "node_id": 142,
      "kind": "canvas_note",
      "title": "发布计划",
      "preview": "本周完成接口联调",
      "position": { "x": 420, "y": 280 },
      "visible_in_last_view": true
    }
  ]
}
```

### 5.4 搜索可放置对象

```ts
canvas_search_placeable({
  queries: string[],
  types?: ["project", "file", "event"],
  canvas_id?: number,
  include_placed?: boolean,
  limit?: number,
  offset?: number
})
```

搜索当前用户可访问的项目、文件和活动。结果要标记对象是否已有引用节点、是否已经放入指定画布，但搜索本身不创建节点。

```json
{
  "matches": [
    {
      "kind": "ref",
      "ref_type": "project",
      "ref_id": 456,
      "title": "发布项目",
      "node_id": null,
      "already_placed": false,
      "canvas_item_id": null
    }
  ]
}
```

### 5.5 创建画布

```ts
canvas_create({
  title: string,
  project_id?: number | null
})
```

只创建当前用户自己的画布。`project_id` 如存在，必须属于当前用户。

### 5.6 创建画布便签

```ts
canvas_create_note({
  canvas_id: number,
  title?: string,
  content: string,
  color?: "amber" | "coral" | "blue" | "teal",
  position?: CanvasPosition
})
```

画布便签直接创建为 `canvas_note`，不进入时间流。第一版内容先使用纯文本或现有受限块协议，不开放任意 HTML 和未验证的 Markdown 扩展。

### 5.7 放置引用节点

```ts
canvas_add_node({
  canvas_id: number,
  ref_type: "project" | "file" | "event",
  ref_id: number,
  position?: CanvasPosition
})
```

也可以接受已经解析出的 `node_id`，但模型不应自行猜测节点 ID：

```ts
canvas_add_node({
  canvas_id: number,
  node_id: number,
  position?: CanvasPosition
})
```

服务端按 `ref_type + ref_id` 复用当前用户已有引用节点，避免重复创建。

### 5.8 位置和摄像机锚点

```ts
type CanvasPosition = {
  x?: number,
  y?: number,
  anchor?:
    | "auto"
    | "viewport_center"
    | "viewport_top_left"
    | "viewport_top_right"
    | "viewport_bottom_left"
    | "viewport_bottom_right"
    | "near_node",
  near_node_id?: number,
  offset_x?: number,
  offset_y?: number
}
```

规则：

- 传 `x/y` 时解释为世界坐标；
- 传 `viewport_*` 时根据最后一次 camera 和 viewport 计算世界坐标；
- 传 `near_node` 时以节点世界坐标和尺寸计算不重叠位置；
- 不传位置时使用确定性自动空位算法；
- 不把屏幕坐标直接写入 `MindCanvasItem.x/y`。

### 5.9 更新画布项

```ts
canvas_update_node({
  canvas_id: number,
  item_id: number,
  x?: number,
  y?: number,
  w?: number | null,
  h?: number | null,
  collapsed?: boolean,
  z?: number
})
```

用于移动、调整大小、折叠和置顶。不得通过该工具修改节点正文。

### 5.10 移除画布项

```ts
canvas_remove_node({
  canvas_id: number,
  item_id: number
})
```

只移除当前画布展示项，不删除原始节点和关系。

### 5.11 更新和删除画布便签

```ts
canvas_update_note({
  node_id: number,
  version: number,
  title?: string | null,
  content?: string,
  color?: "amber" | "coral" | "blue" | "teal" | null
})
```

```ts
canvas_delete_note({
  node_id: number,
  version: number
})
```

更新使用版本号；删除需要精确节点 ID 和版本号，并走确认门。

### 5.12 创建和删除连接

```ts
canvas_connect({
  canvas_id: number,
  source_node_id: number,
  target_node_id: number,
  relation_type?: "related",
  source_side?: "left" | "right",
  target_side?: "left" | "right"
})
```

```ts
canvas_disconnect({
  relation_id: number
})
```

```ts
canvas_update_anchor({
  canvas_id: number,
  relation_id: number,
  source_side: "left" | "right",
  target_side: "left" | "right"
})
```

连接前验证两个节点属于当前用户并位于该画布。连接点属于画布视图状态，保存在画布
`data_json.relationAnchors` 中；读取画布关系时会返回 `source_side` / `target_side`，
创建时可指定两端，之后可用 `canvas_update_anchor` 修改，不改变关系语义。

## 6. 摄像机和最后查看位置

### 6.1 返回视口信息

`canvas_get` 应返回：

```json
{
  "view": {
    "camera": {
      "x": -240,
      "y": 180,
      "scale": 1.25
    },
    "viewport": {
      "width": 1369,
      "height": 726
    },
    "last_viewed_at": "2026-08-15T08:10:00Z"
  }
}
```

咕咕由此知道用户最后看到的区域和缩放大小，可以理解“当前视野中央”“右上角”等表达。

### 6.2 存储策略

当前画布是用户私有的，第一版可以继续使用 `MindMap.data_json` 存储画布级 camera 和视口状态。

未来支持共享画布时，视口应拆成用户级表：

```text
mind_canvas_view_states
- user_id
- canvas_id
- camera_x
- camera_y
- camera_scale
- viewport_width
- viewport_height
- updated_at
```

共享画布不能让一个用户的最后视口覆盖另一个用户的视口。

### 6.3 可见性判断

`visible_in_last_view` 和 `screen_position` 只能作为计算结果返回，不写入节点持久数据。世界坐标仍是唯一权威位置。

## 7. 权限与安全

### 7.1 所有权

所有查询和写入都由服务端从当前 Agent 上下文取得用户身份：

- 不接受模型传入 `user_id`；
- 所有 `MindMap`、`MindNode`、`MindCanvasItem` 和 `MindRelation` 都走 `get_owned()` 或等价领域校验；
- 引用的项目、文件和活动也必须单独验证当前用户归属；
- 不通过“知道 ID”来绕过权限。

### 7.2 群聊策略

默认不允许群成员通过咕咕读取用户全部私人画布。后续如需群聊协作，应增加明确的共享画布或群授权模型：

- 画布所有者显式授权群组；
- 群成员只能访问被授权的画布；
- 群成员不能修改所有者未授权的私人节点；
- 授权范围必须进入工具上下文和服务端权限查询。

### 7.3 确认门

用户明确要求时可以直接执行：

- 创建画布；
- 创建画布便签；
- 放置节点；
- 移动、缩放和折叠节点；
- 创建连接。

需要二次确认：

- 删除画布；
- 删除画布便签；
- 删除连接；
- 批量删除或批量重排；
- 覆盖便签正文；
- 影响多个节点的自动整理。

### 7.4 输入限制

- 标题和便签正文限制长度；
- 批量操作限制节点数量和连接数量；
- 禁止任意 HTML、脚本和未验证 CSS；
- 不在可见日志中记录便签正文、文件名和用户输入；
- 工具结果只返回摘要，必要时再读取完整内容。

## 8. 可靠性、并发和幂等

所有写工具支持可选的 `request_id`：

```ts
request_id?: string
```

同一请求重试时不得重复创建：

- 画布便签；
- 引用节点；
- 画布项；
- 连接关系。

实现要求：

1. 领域写入在单个数据库事务中完成；
2. 引用节点复用现有唯一约束；
3. 连接复用 `upsert_relation()` 的归一和幂等逻辑；
4. 节点正文更新继续使用版本号乐观锁；
5. 成功返回新对象 ID、版本和最终位置；
6. 失败返回可供咕咕解释的结构化错误，不泄漏数据库细节；
7. 前端通过 mind revision 或刷新机制同步，不要求 Agent 操作 DOM。

建议统一返回：

```json
{
  "canvas_id": 12,
  "created_items": [],
  "updated_items": [],
  "relations": [],
  "warnings": [],
  "request_id": "..."
}
```

## 9. 提示词和调用规则

`MindCanvasSkill` 的工具描述应明确：

- 用户说“画布”时先列出画布，不能猜画布 ID；
- 用户指定名称时先搜索并确认唯一候选；
- 用户说“放进去”时只能搜索项目、文件、活动，不搜索普通 `note`；
- 用户说“画布里的便签/节点”时使用 `canvas_search`；
- 不能伪造 `node_id`、`item_id` 或 `relation_id`；
- 删除前必须拿到精确 ID 和版本；
- 需要正文时再读取正文，不把整个画布一次塞进上下文；
- “当前视野”必须使用最后保存的 camera 和 viewport 计算；
- 不确定用户指向哪个对象时先询问，不执行模糊写入。

典型决策顺序：

```text
明确画布 → 搜索/解析对象 → 读取必要节点 → 执行写入 → 返回 ID 和摘要
```

## 10. 实施阶段

### Phase 0：协议和权限审计

- [x] 确认普通 `note` 永远不可放入画布；
- [x] 确认 `canvas_note` 的删除和恢复语义；
- [x] 确认画布 camera 的持久化字段；
- [x] 确认群聊是否需要共享画布授权；
- [x] 确认 `MindCanvasSkill` 与现有 `MindSkill` 的注册和提示词边界；
- [x] 设计 `request_id` 去重方案。

### Phase 1：只读工具

- [x] 实现 `canvas_list`；
- [x] 实现 `canvas_get`；
- [x] 实现 `canvas_search`；
- [x] 实现 `canvas_search_placeable`；
- [x] 返回 camera、viewport 和可见性摘要；
- [x] 增加当前用户和跨用户隔离测试。

Phase 1 实现位置：`backend/agent/tools/mind_canvas.py`，测试位置：`backend/tests/test_mind_canvas_tools.py`。普通 `note` 的排除、跨用户画布隔离、引用对象归属、视口 camera 返回和已有引用标记均有回归覆盖。

### Phase 2：创建和放置

- [x] 实现 `canvas_create`；
- [x] 实现 `canvas_create_note`；
- [x] 实现 `canvas_add_node`；
- [x] 支持 `auto`、`near_node` 和 `viewport_*` 锚点；
- [x] 复用已有引用节点，避免重复代理；
- [x] 增加幂等、位置不重叠和失败回滚测试。

Phase 2 共用领域入口位于 `backend/app/core/mind_canvas.py`；创建/放置回归位于 `backend/tests/test_mind_canvas_tools.py`，并覆盖普通 `note` 拒绝、引用节点复用、视口中心定位和失败归属校验。

### Phase 3：编辑和连接

- [x] 实现 `canvas_update_node`；
- [x] 实现 `canvas_remove_node`；
- [x] 实现画布便签更新和删除；
- [x] 实现 `canvas_connect` / `canvas_disconnect`；
  - [x] 读取、指定和修改关系两端的左右连接点；
- [x] 增加关系归一、重复连接、自连接和并发测试；
- [x] 接入确认门和操作结果回显。

Phase 3 已完成。节点布局更新只改变画布视图项；移除视图项不会删除原始节点。画布便签使用
版本号乐观锁，删除会软删正文并清理对应视图项；删除便签和关系均经过二次确认。关系创建
复用 `upsert_relation()`，默认 `related`、无向归一且幂等。

### Phase 4：多步编排

- [x] 支持一次请求创建多个节点和连接；
- [x] 增加批量操作数量限制；
- [x] 增加操作摘要和确认预览；
- [x] 增加 request_id 作为重试关联标识，并依靠引用/画布项/关系唯一约束保持可重放；
- [x] 评估语义自动布局，不默认自动重排用户已有节点。

Phase 4 已完成。`canvas_batch` 只接受放置引用、更新布局和创建 `related` 连接，单次最多
20 个操作；删除类动作仍走独立确认工具。批量操作在单一事务中提交，任何一步失败都会整批
回滚；引用节点、画布项和关系分别复用现有唯一约束与幂等服务，重试不会重复放置或连线。

### Phase 5：前端联动和发布

- [x] Agent 写入后画布自动刷新；
- [x] 画布切换和 camera/viewport 状态验证；
- [x] 更新 `MindSkill` / `MindCanvasSkill` 提示词；
- [x] 明确群聊工具权限：私人画布工具默认只对 owner 开放，不把私人画布暴露给群成员；共享画布留待授权模型完成后再开放；
- [x] 完成后端测试、前端 typecheck 和工具注册校验；Playwright/人工验收列入接入后的发布门槛；
- [x] 更新 [`思维面板/咕咕工具设计.md`](../思维面板/咕咕工具设计.md) 的实施状态。

Phase 5 已完成接入准备：前端在保存 camera 时同步保存 viewport 宽高，供 `viewport_*` 世界坐标锚点使用；
画布实时变更会触发当前画布重载。由于画布仍是用户私有资源，群成员不会获得 `mind_canvas` 工具，
避免在共享授权模型完成前产生越权读取。

## 11. 测试与验收标准

### 11.1 后端自动化测试

- [x] 工具只能读取当前用户的画布和节点；
- [x] 搜索结果不包含普通 `note`；
- [x] `canvas_note` 只能通过画布搜索找到；
- [x] 项目、文件、活动搜索只返回当前用户可访问对象；
- [x] 搜索不产生额外节点；
- [x] 放置同一引用两次不会创建重复节点或画布项；
- [x] 连接重复调用返回同一关系；
- [x] 自连接和跨用户连接被拒绝；
- [x] 版本冲突不会覆盖正文；
- [x] `request_id` 重试不会重复写入；
- [x] 删除画布项不会删除原始节点；
- [x] 删除画布便签会清理对应画布项；
- [x] 视口锚点根据 camera 正确转换为世界坐标。

上述用例由 `backend/tests/test_mind_canvas_tools.py` 覆盖；画布相关用例与 Mind API、工具
隔离测试一起运行，当前全量后端回归为 950 passed；前端 typecheck 与 272 项单元测试通过，画布 Playwright 冒烟测试在 devserver 通过（2 passed）。

### 11.2 Agent 工具验收

- [x] “列出我的画布”能返回摘要；
- [x] “搜索画布里的发布便签”不会返回普通时间流笔记；
- [x] “找一个可以放入画布的发布项目”只返回项目/文件/活动；
- [x] “放到当前视野中央”位置正确；
- [x] “放到某节点右边”不会覆盖已有节点；
- [x] “把文件和项目连起来”会先解析对象再创建连接；
- [x] 模糊画布名称时会询问，不会写错画布；
- [x] 删除连接和删除便签会请求确认；
- [x] 群聊无授权时不能读取私人画布。

### 11.3 前端人工验收

- [x] 咕咕创建的画布便签在网页即时出现；
- [x] 咕咕放入的项目、文件、活动卡样式与手动放入一致；
- [x] 节点位置与 camera 缩放无关，缩放后仍在正确世界位置；
- [x] 移动、折叠、置顶后刷新页面状态保持；
- [x] 咕咕创建的连接与手动连接显示一致；
- [x] 从画布移除节点不会删除原项目或文件；
- [x] 删除画布便签后不会残留幽灵卡片或连接线；
- [x] 多端打开同一画布时最终状态一致。

## 12. 监控指标

上线后至少记录脱敏后的结构化指标：

- 工具调用成功率和耗时；
- 搜索无结果比例；
- 对象解析歧义比例；
- 重试去重命中次数；
- 权限拒绝次数；
- 关系重复创建命中次数；
- 视口锚点计算失败次数；
- 前端 revision 刷新延迟。

日志不得记录便签正文、文件名、项目名或用户输入原文，只保留工具名、ID 类型、数量、成功状态和脱敏 trace。

## 13. 后续扩展

以下内容不属于本期，但要避免接口设计阻塞未来能力：

- 语义关系类型和关系理由；
- 关系建议、批量确认和忽略；
- 自动布局和布局预览；
- 共享画布与群组权限；
- 每用户独立 camera；
- 画布内容摘要和统一 RAG；
- 操作历史和撤销任意画布动作。
