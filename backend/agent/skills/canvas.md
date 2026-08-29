---
name: 思维画布
description_long: "用户要查看、搜索、创建、摆放、整理、连接、删除或批量编排思维画布节点时使用。"
description_short: 用户要搜索、创建、整理或连接思维画布节点时使用。
category: canvas
related_tools: canvas_list, canvas_get, canvas_search, canvas_search_placeable, canvas_create, canvas_delete, canvas_create_note, canvas_add_node, canvas_update_node, canvas_remove_node, canvas_update_note, canvas_delete_note, canvas_connect, canvas_update_anchor, canvas_disconnect, canvas_batch
emoji: 🧠
---

# 思维画布操作技能

## 工具路由

- 不要猜画布 ID：先用 `canvas_list`，已有明确画布时用 `canvas_get`。
- 搜索画布中已经存在的节点用 `canvas_search`。
- 搜索可以放入画布的项目、文件、活动用 `canvas_search_placeable`。
- 普通时间流 `note` 不能放入画布；画布便签必须使用 `canvas_create_note`。
- 删除整张画布使用 `canvas_delete`（含确认门，会清除画布内所有便签、引用节点和连接关系）。
- 创建、放置、更新、移除和删除工具都支持单项或数组调用；数组一次最多 20 项。
- 创建、移动、连接或批量编排后，以工具结果为准，不要只用文字声称成功。

## 画布便签的标题（重要）

- `canvas_create_note` / `canvas_update_note` 的 `title` 参数**用户看不到**——只进搜索和列表索引。
- **用户可见的标题必须写在 `content` 的第一行，格式 `# 标题`**（渲染成卡片标题，其余行是正文）。
- 正确示范：`content: "# 合肥\n安徽\n商合杭、京港\n主要客运站：合肥站、合肥南站、合肥西站"`
- 反例：`title: "合肥"` 但 `content` 第一行是 `安徽` → 用户看到的是"安徽"，城市名丢了。

## 坐标、尺寸和安全距离

画布节点是有尺寸的矩形，不是无尺寸的点。

- `position.x/y` 是卡片**左上角**的世界坐标，不是中心坐标。
- 节点实际占用尺寸优先使用 `layout.effective_size`；卡片尺寸由系统按节点类型统一管理，Agent 工具不能设置或修改 `w/h`。
- 未显式设置尺寸时使用 `layout.default_size`。
- 当前默认尺寸约定：画布便签 `244×148`、项目卡 `240×120`、文件卡 `156×140`、活动卡 `220×96`。
- 两个卡片在上、下、左、右任一方向相邻时，矩形边缘之间都必须至少保持 `150px` 安全距离；不能只满足横向间距。
- 如果采用中心点排布，则两个卡片中心必须至少相隔 `750px`；不要把中心点距离规则误当成卡片左上角距离。
- 两个规则满足其一即可，但优先使用边缘 `150px` 规则；除非用户明确要求紧凑排列，不得重叠或贴边。

判断两个矩形是否安全时，先计算：

```text
right = x + width
bottom = y + height
```

不能只比较两个节点的 `x/y`，也不能忽略不同卡片类型的宽高。

## 摆放流程

每次放置或移动遵循以下顺序：

1. 读取当前画布节点、有效尺寸和最后查看的视口。
2. 确认用户要放置的对象，先搜索再使用稳定的 `node_id` 或引用 ID。
3. 解析用户指定的位置；明确位置优先，但仍要检查是否与已有节点冲突。
4. 发生冲突时，优先向右寻找最近的可用位置，再向下换行；不要自动移动已有节点。
5. 批量放置时先在脑中完成所有矩形布局，再调用 `canvas_batch`，每个新节点都要避让已有节点和同批节点。
6. 用户要求“大范围整理”时，先说明将移动哪些节点并请求确认；没有明确授权时只寻找空位。

位置锚点的使用：

- “靠近某节点”使用 `near_node`，在目标节点右侧留出至少 150px；如果用户指定上、下或左侧，也必须在对应方向留出同样的 150px。
- “放在当前视野中央/角落”使用 `viewport_center` 或 `viewport_*`，不要把屏幕坐标直接写成世界坐标。
- `auto` 只适合没有指定位置的普通新增，不代表可以与已有卡片重叠。

## 连接方向

画布支持左右两侧的连接点（left/right）；同张卡片左右两个端口独立，可以分别连接不同节点。

**树状/层级图（默认推荐）**：左右相邻的节点用相向端点，避免线条交叉：
| 目标相对位置 | 源端点 | 目标端点 |
|---|---|---|
| 目标在源节点右侧 | `right` | `left` |
| 目标在源节点左侧 | `left` | `right` |

**Loop/回环图（用户明确要循环、互相连接、形成闭环时）**：可以使用同向端点：
- 形成 loop：`right → right` 或 `left → left`，让线条绕回
- 同卡片多线：左右两个端口可分别连向不同节点，无需换向

**判断逻辑**：
- 两节点水平相邻 → 优先相向端点（避免交叉）
- 用户要求"画一个循环"、"能互相连"、"形成闭环" → 用同向端点
- 目标卡片与源卡片在同一张、或左右排布混乱 → 用同向端点避免交叉
- 方向判断用两卡片中心的水平坐标，不用节点 ID 顺序

**其它规则**：
- 创建关系时可在 `canvas_connect` 传 `source_side` / `target_side`。
- 读取画布关系时，以返回的 `source_node_id` / `target_node_id` 对应端点；数据库可能按节点 ID 归一，不能因此自行交换端点。
- 已有关系修改端点使用 `canvas_update_anchor`；移动节点后不要擅自重算已经确认的端点。
- 删除便签或关系必须先走确认门。

## 批量编排

- 各 CRUD 工具优先直接使用数组参数完成同类操作：
  - `canvas_create_note.notes`
  - `canvas_add_node.nodes`
  - `canvas_update_node.updates`
  - `canvas_update_note.updates`
  - `canvas_remove_node.item_ids`
  - `canvas_delete_note.notes`
- 上述数组每次最多 20 项；单项调用继续使用原来的单数参数和返回格式。创建、放置和更新都只接受位置、层级和折叠状态，不要传 `w/h`；如果需要调整视觉尺寸，应由前端/Runtime 的布局策略处理。
- `canvas_batch` 用于需要跨类型、跨步骤保持原子性的事务，单次最多 20 个操作。支持 `create_note`、`add_node`、`update_item`、`remove_item`、`delete_note` 和 `connect`。
- 批量事务使用稳定的 `request_id`；任一操作失败会整体回滚。
- 批量连接也遵循相向端点规则，并可指定两端连接点。
- 批量布局失败会整体回滚；收到回滚结果后先调整方案，不要盲目重复提交。
- `canvas_delete_note` 和批量中的 `delete_note` 都会一次性展示影响并请求确认；版本冲突时整批不执行。

同类操作不要为了凑批量事务而逐项调用：例如创建多条便签直接使用
`canvas_create_note.notes`，移动多个节点直接使用 `canvas_update_node.updates`。
只有“创建便签 → 放置引用 → 调整布局 → 建立连接”这类相互依赖的多类型流程，才使用
`canvas_batch`。

## 典型示例

把项目放到文件右侧：先读取文件的 `position` 和 `layout.effective_size`，令项目的
`x = 文件 right + 150`，并保持合适的 `y`；如果用户没有指定高度方向，不要覆盖文件。

把左侧节点连接到右侧节点：

```json
{
  "source_node_id": 12,
  "target_node_id": 34,
  "source_side": "right",
  "target_side": "left"
}
```
