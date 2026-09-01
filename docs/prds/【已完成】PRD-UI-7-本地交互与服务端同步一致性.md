# InteractionSync 本地交互同步层 PRD

> 状态：✅ Phase 1-4 已完成；实体交互已统一通过 InteractionSync，实时事件按资源队列收敛
> 创建：2026-09-01
> 最近更新：2026-09-02
> 所属层：UI / InteractionSync / Store / Interaction Runtime
> 关联模块：`frontend/src/stores/mind.ts`、`frontend/src/interaction/runtime/`、`frontend/src/stores/live.ts`
> 关联文档：[`【已完成】PRD-UI-2-统一实时事件更新.md`](./【已完成】PRD-UI-2-统一实时事件更新.md)、[`【已完成】PRD-UI-5-CSS样式职责收口与主题层统一.md`](./【已完成】PRD-UI-5-CSS样式职责收口与主题层统一.md)

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| `InteractionSync` 统一模型 | ✅ 已完成 | 项目、日历、文件、便签和定时任务高频交互已通过统一 adapter 执行 |
| 画布 optimistic 卡片身份保持 | ✅ 已完成 | 服务端回写保持 `clientKey`，已通过画布拖拽人工验收 |
| 同客户端实时回声抑制 | ✅ 已完成 | 画布 Mind 写请求携带来源与 mutation 标识，已验证无重复 hover |
| 跨客户端画布同步 | ✅ 已完成 | 其他来源事件经过事件队列并刷新/身份对账 |
| 通用实时事件队列 | ✅ 已完成 | 已接入 Mind、项目、文件、日历和定时任务，支持增量合并与按资源刷新 |

---

## 1. 背景与问题

### 1.1 背景

当前前端同时存在三类状态：用户操作产生的本地即时状态、服务端请求响应、实时事件触发的后台刷新。它们可能在同一段交互生命周期内交错返回。

画布抽屉拖入卡片已经暴露出典型问题：卡片先以 optimistic 数据进入画布并开始 landing，landing 结束后实时刷新再次拉取服务端列表；如果刷新回写改变了 Vue key，卡片会被卸载并重挂载。鼠标仍停留在原位置时，浏览器会对新 DOM 重新触发 hover，表现为 hover 动画播放两次、opacity 短暂消失或卡片瞬间抬升。

这不是单纯的 CSS 或动画时长问题，而是本地交互生命周期与服务端数据 reconciliation 之间缺少统一契约。

### 1.2 目标

1. 本地交互优先获得连续、可预测的视觉反馈。
2. 服务端响应和实时事件最终仍能收敛到 canonical 数据。
3. 数据同步不得因为普通回写重建正在交互的组件。
4. 所有 optimistic 实体在临时状态、服务端确认和后台刷新之间保持稳定前端身份。
5. 建立统一的 `InteractionSync`，让可安全即时更新的业务不再各自维护 optimistic 逻辑。

### 1.3 统一覆盖范围

以下业务交互统一调用 `InteractionSync`，不再在页面或 Store 中重复实现 optimistic、回滚、回声抑制和服务端对账：

1. 日记/便签：编辑、改色、移动。
2. 画布卡片：拖拽、置顶、折叠。
3. 项目：状态、排序、归档。
4. 日历事件：拖动、修改时间。
5. 文件：重命名、移动、收藏。

这些操作仍由各领域提供自己的实体字段和 API adapter；统一层只负责交互同步机制，不吞并领域业务规则。

### 1.4 非目标

- 不改变后端 canonical 数据、权限、版本锁或事件协议。
- 不让 Runtime 读取或猜测业务数据状态。
- 不通过延长动画、强行屏蔽 hover、人工派发 DOM 事件掩盖数据竞态。
- 不在本阶段一次性重写所有 Store；先完成画布最小闭环和通用边界定义。

## 2. 核心原则

### 2.1 状态分层

```text
服务端实体状态：canonical 字段、版本、服务端 id
本地交互状态：pointer、drag、landing、editing、pending mutation
组件身份状态：clientKey、DOM 绑定、Runtime object identity
同步状态：请求序列、来源、待确认操作、冲突结果
```

四层不能通过一次整表替换互相覆盖。服务端数据负责收敛实体字段，本地交互状态负责连续体验，组件身份负责避免无意义重挂载。

### 2.2 所有权边界

| 能力 | 唯一 owner | 业务侧职责 |
|---|---|---|
| 拖拽、landing、proxy、视觉生命周期 | Interaction Runtime | 注册 object、surface 和目标解析器 |
| hover 真实状态 | 浏览器 / 组件 | 只响应真实 pointer 事件 |
| 服务端实体与版本 | API / Store | 请求、版本和错误处理 |
| optimistic 与服务端对账 | 通用同步层 / Store | 保留身份并合并字段 |
| 实时事件接收 | Live Store | 分发事件，不直接重建交互组件 |

Runtime 不负责服务端数据 reconciliation；Store 不通过修改 hover 或动画属性来补偿组件重挂载。

### 2.3 稳定身份

组件的 Vue key、Runtime object id 和服务端实体 id 不是同一个概念：

- 服务端 id 标识持久化实体。
- `clientKey` 标识本次前端组件生命周期。
- Runtime object id 必须基于稳定的 `clientKey` 或稳定实体身份生成。

optimistic 实体转为服务端实体时，默认只替换数据，不替换 `clientKey`。

### 2.4 客户端身份与回声抑制

每个浏览器 Tab 在 `sessionStorage` 中生成独立的 `clientId`；咕咕其他客户端、其他浏览器和其他 Tab 都视为不同来源。每次本地 mutation 生成独立的 `mutationId`，服务端事件携带来源身份和 mutation 身份。

客户端按以下规则处理服务端消息：

- 同一 `clientId` 的实时事件视为本地回声，只抑制重复事件处理，不抑制当前 API 响应和失败结果。
- 不同 `clientId` 的事件必须正常同步，经过 entity reconciliation 后更新本地状态。
- 同一 `mutationId` 的响应或事件只能确认一次，不能重复应用。
- `clientId` 只标识来源，不承担版本判断；新旧顺序仍由 mutation 序列、实体版本或服务端 revision 决定。

```text
Tab A 本地操作 → API 响应：确认并对账
Tab A 本地操作 → clientId=A 的事件：忽略回声
Tab B / 咕咕操作 → clientId!=A 的事件：同步并对账
```

## 3. InteractionSync 统一同步模型

### 3.1 模块职责

`InteractionSync` 是前端本地交互和服务端状态之间的统一协调层。它不要求所有请求都 optimistic，而是根据实体 policy 选择即时更新、等待确认或只读刷新。

```text
业务 Store / composable
  → InteractionSync.execute(policy, operation)
  → 本地即时更新（可选）
  → API 请求
  → 当前客户端回声过滤 / 响应确认
  → 其他客户端事件合并
  → 成功收敛或精确回滚
```

业务调用方只提供实体 adapter、可即时更新字段和回滚策略；不得再次实现一套独立的 pending map、client id 或刷新闸门。

### 3.2 Mutation 生命周期

```text
用户操作
  → 创建 mutation 记录和 clientKey
  → 立即更新本地状态
  → Runtime 播放交互动画
  → 后台提交服务端请求
  → 响应按身份合并
  → 交互结束后处理挂起事件
  → 按版本/序列收敛
```

服务端失败时，只回滚该 mutation 负责的字段；不能用旧整表快照覆盖之后已经发生的本地操作。

### 3.3 列表刷新规则

列表刷新必须经过 reconciliation，不得直接执行“服务端数组覆盖响应式数组”。对每个服务端实体按以下顺序寻找本地身份：

1. 当前实体的服务端 id。
2. pending mutation 记录的持久化 id。
3. pending mutation 记录的稳定 node id 或业务引用身份。
4. 无匹配时创建新的前端身份。

刷新只替换 canonical 字段；已有 `clientKey`、本地未确认字段和交互元数据必须按明确规则保留。

### 3.4 交互期间的事件

- Runtime 交互 active 时，实时事件只记录为待处理刷新或增量事件。
- landing settled 后允许同步，但必须先完成身份对账。
- 正在拖拽、编辑或保存的实体不能因后台响应被重挂载。
- 旧请求响应不能覆盖更晚的本地 mutation；使用请求序列或实体版本判定。
- 结构性删除需要单独确认，不能由一次过期列表响应推断。

### 3.5 服务端更新与本地交互的冲突策略

服务端更新不能直接替换正在交互的本地实体。同步层必须先判定消息来源和 mutation 状态，再决定确认、忽略回声、排队或合并：

| 消息 | 当前客户端处理 |
|---|---|
| 当前 `clientId` 的事件回声 | 标记已见或忽略，不重复刷新 UI |
| 当前 API 的成功响应 | 合并 canonical 字段，保留本地身份和未完成交互字段 |
| 其他客户端的增量事件 | 按实体 id/版本合并；交互字段由本地 mutation 暂时优先 |
| 其他客户端的结构性变更 | 进入刷新队列，交互结束后 reconciliation |
| 过期或重复响应 | 丢弃，不覆盖较新的本地 mutation |

“不回传给当前客户端”只适用于实时事件回声；服务端仍需向其他客户端广播成功变更，当前客户端仍需消费自己的 API 响应。

## 4. 画布 Phase 1

### 4.1 实施范围

- 抽屉到画布的 optimistic project ref。
- 普通画布卡片移动、置顶和属性更新。
- landing settled 后的 `loadCanvas` 后台刷新。
- 跨标签页或 Agent 触发的 mind 实时事件。

### 4.2 画布具体要求

- pending project ref 在创建节点后记录 `nodeId`。
- 创建 canvas item 后记录 `persistedItemId`。
- `loadCanvas()` 通过 `id/nodeId` 对账并继承 `clientKey`。
- 后台刷新不得导致 optimistic 卡片从临时 key 切换到服务端 id key。
- `bringCanvasItemToFront` 和属性更新响应保留当前项的 `clientKey`。
- 删除、取消和账号切换必须清理 pending mutation，不能把已取消项重新认领。
- 画布请求和 mind 事件携带 `clientId`、`mutationId`；同客户端回声不触发二次列表刷新。
- 其他 Tab 或咕咕更新画布时，仍通过 reconciliation 同步，不得用整表替换破坏本地组件身份。

### 4.3 禁止做法

- 在 Store 中根据 Runtime phase 手动 suppress hover。
- synthetic `mouseenter` 或其他人工 DOM 事件重建 hover。
- 通过 `opacity`、`visibility`、`transform` 的额外补丁处理重挂载后果。
- 为了避免竞态永久关闭实时刷新。

## 5. 修改与新建文件树

以下是当前文件树与后续目标边界；已创建文件用“当前”标识，避免同步逻辑散落到领域目录。

```text
frontend/src/interaction/sync/
├── InteractionSync.ts              # 当前：核心入口和来源判断
├── InteractionSyncState.ts         # 当前：clientId、mutationId、pending 状态
├── InteractionSyncPolicy.ts        # 当前：实体 adapter/policy 类型
├── InteractionSyncReconciler.ts    # 当前：画布列表身份和字段合并
├── InteractionSyncEventQueue.ts    # 当前：增量事件和合并刷新队列
└── InteractionSync.test.ts         # 后续：通用时序测试

frontend/src/interaction/runtime/
└── syncBridge.ts                   # 后续：仅在确认需要时创建 Runtime 边界适配

frontend/src/stores/
├── mind.ts                         # 迁移便签、画布卡片和 mind 事件
├── projects.ts                     # 迁移项目状态、排序和归档
├── calendar.ts                     # 迁移日历事件拖动和时间修改
└── filesCache.ts                   # 迁移文件重命名、移动和收藏

frontend/src/views/
├── Mind/                           # 移除领域内重复 optimistic/reconciliation 编排
├── Projects/                       # 仅保留项目字段和交互触发
├── Calendar/                       # 仅保留事件编辑和时间字段映射
└── Files/                          # 仅保留文件操作入口和展示

frontend/test/
├── interactionSync.test.ts         # 当前：画布来源、placeholder 和身份对账
├── interactionSyncPhase23.test.ts  # 当前：通用执行与实时事件队列契约
├── interactionSyncRace.test.ts     # 后续：请求、事件和交互时序组合
└── interactionSyncEntities.test.ts # 后续：五类实体 adapter 契约
```

### 5.1 新建文件

- `frontend/src/interaction/sync/InteractionSync.ts`
- `frontend/src/interaction/sync/InteractionSyncState.ts`
- `frontend/src/interaction/sync/InteractionSyncPolicy.ts`
- `frontend/src/interaction/sync/InteractionSyncReconciler.ts`
- `frontend/src/interaction/sync/InteractionSync.test.ts`
- `frontend/src/interaction/runtime/syncBridge.ts`（仅确认 Runtime 生命周期边界确有适配需求时创建）
- `frontend/test/interactionSync.test.ts`
- `frontend/test/interactionSyncRace.test.ts`
- `frontend/test/interactionSyncEntities.test.ts`

### 5.2 修改文件

- `frontend/src/stores/mind.ts`
- `frontend/src/stores/projects.ts`
- `frontend/src/stores/calendar.ts`
- `frontend/src/stores/filesCache.ts`
- `frontend/src/views/Mind/**`
- `frontend/src/views/Projects/**`
- `frontend/src/views/Calendar/**`
- `frontend/src/views/Files/**`
- `frontend/src/stores/live.ts`（补充来源和 mutation 元数据消费，不改变统一连接职责）

### 5.3 不应修改的边界

- `gugu-interaction-runtime` 不负责业务实体同步。
- API service 不负责本地 optimistic 状态机。
- 业务组件不再直接维护跨请求 pending map 或 synthetic hover 修复。

## 6. 推广阶段

### Phase 1：画布闭环

- 完成画布 reconciliation helper 和 mutation identity 记录。
- 覆盖创建、移动、更新、删除和后台刷新交错场景。
- 保留 Runtime 视觉生命周期的单一 ownership。

### Phase 2：通用同步原语

- 抽取与业务无关的 `clientId`、`mutationId`、`clientKey`、请求序列和列表 reconciliation 原语。
- 为项目、日历、文件、便签、定时任务建立 entity adapter。
- 明确字段级本地优先策略，避免粗粒度整对象覆盖。
- 统一实现同客户端事件回声抑制和跨客户端事件同步。

### Phase 3：增量实时事件

- 能安全 patch 的事件直接增量更新 Store。
- 不能安全 patch 的事件进入统一刷新队列。
- 批量事件合并请求，避免交互结束时产生请求风暴。

### Phase 4：移除重复编排

- 清理各业务模块自行实现的 hover suppression、刷新延迟和临时 key 修补。
- 将交互生命周期通知、数据 reconciliation 和错误回滚纳入明确的共享边界。

## 7. 唯一执行 TODO

以下清单是本 PRD 的唯一执行入口。各 Phase 的说明用于定义范围和验收标准，不再维护第二份实施状态；完成一项后必须在这里补充代码位置、测试命令和验收证据。

### 当前状态

- [x] **Phase 1：画布同步闭环**
  - [x] `UI7-001` 定义 `clientId`、`mutationId`、`clientKey` 的生命周期和存储边界；验收：同一 Tab 刷新保持 `clientId`，每次 mutation 有独立 id。
  - [x] `UI7-002` 为画布创建、移动、更新、删除建立 mutation 记录并透传请求来源；验收：画布写请求携带 `X-Client-Id` 和需要时的 `X-Mutation-Id`。
  - [x] `UI7-003` 完成 `loadCanvas()` 的实体身份 reconciliation；验收：服务端列表回写不覆盖已有 `clientKey`，pending placeholder 在响应未到时保留。
  - [x] `UI7-004` 接入同客户端事件回声抑制；验收：Mind 事件 `origin` 与当前 Tab 相同不触发重复刷新，API 响应仍正常合并。
  - [x] `UI7-005` 接入其他 Tab/咕咕客户端事件的 reconciliation 刷新；验收：来源不同的 Mind 事件仍进入实体合并或后台刷新。
  - [x] `UI7-006` 补齐请求先后、实时事件、landing 期间刷新、回抽和失败响应的自动化竞态契约；验收：画布加载序列、删除失效、账号边界、身份保持和取消 placeholder 测试通过。
  - [x] `UI7-007` 完成画布人工验收和 Performance Trace；验收：抽屉拖入后无重复 hover、无卡片重挂载抖动，验证日期：2026-09-02。

### 后续顺序

- [x] **Phase 2：通用同步原语**
  - [x] `UI7-008` 提供通用 `InteractionSyncPolicy` 和 `InteractionSync.execute()`；验收：领域只提供 apply/request/rollback，统一入口负责 mutation 生命周期与失败收束。
  - [x] `UI7-009` 复用现有 optimistic intent 串行器并保留字段级业务 adapter 边界；验收：连续同实体操作不因旧请求失败覆盖最新本地状态。
  - [x] 为定时任务开关建立 `InteractionSync.execute` adapter，覆盖即时 apply、失败回滚和 mutation 传递。
  - [x] 为项目、日历、文件和便签建立 adapter，并移除目标实体各自重复的 optimistic 编排。
- [x] **Phase 3：增量实时事件**
  - [x] `UI7-010` 提供按资源注册的事件队列；验收：同客户端回声丢弃，安全事件走增量 handler，其余事件按资源合并刷新。
  - [x] `UI7-011` 将 Mind 事件接入统一队列；验收：增量实体事件不额外触发全量刷新，断线补刷仍可进入队列。
  - [x] `UI7-012` 将项目和文件事件接入统一队列；验收：保留实体增量合并与刷新兜底，并避免事件与 revision watcher 重复刷新。
  - [x] 为日历、便签和定时任务接入增量 handler，并补齐跨资源事件顺序测试。
- [x] **Phase 4：移除重复编排**
  - [x] Runtime Action 路由不再重复创建 optimistic intent；实体 adapter 统一拥有 apply、rollback、request 和 mutation 生命周期。
  - [x] 目标实体不再自行维护实时回声判断与刷新延迟；共享事件队列负责增量处理和合并刷新。

### 完成证据

- `frontend`：`npm run test:run`，59 个测试文件、403 个测试通过。
- `frontend`：`npm run typecheck` 通过。
- `frontend`：`npm run build` 通过；仅保留 Vite 配置兼容性和大 chunk 既有警告。
- `git diff --check` 通过。

### 完成门槛

- 当前 Phase 的所有子项完成。
- 对应自动化测试和人工验收证据已记录。
- 没有未解释的竞态、重复状态源或业务侧 Runtime 生命周期补丁。
- 下一 Phase 开始前，必须先把上一 Phase 标记为完成并记录变更文件。

## 8. 测试与验收

### 8.1 必测时序

1. optimistic 插入后 landing，服务端响应先于 settled 返回。
2. landing settled 先触发后台刷新，创建请求随后完成。
3. `nodeId` 已知但 `persistedItemId` 尚未返回时发生刷新。
4. 服务端回写与用户第二次拖动交错。
5. 删除或回抽与后台刷新交错。
6. 鼠标持续停留在目标卡片上，组件不得发生无意义重挂载。
7. 当前 Tab 的 mutation 回声不触发第二次 UI 更新，其他 Tab 的 mutation 能正常到达并收敛。

### 8.2 可观察契约

- 同一实体在一次交互中 `clientKey` 不改变。
- 同一目标不得因刷新产生额外的原生 `mouseenter`。
- landing 期间不得出现 `opacity 1 → 0 → 1` 的重建序列。
- 服务端最终字段能够正确收敛。
- 失败响应只回滚对应 mutation，不影响其他本地操作。
- 实时刷新仍然有效，不能以永久禁用同步作为修复。
- `clientId` 相同只抑制事件回声，不抑制 API 成功/失败确认。
- `clientId` 不同的更新能够同步，且不会破坏正在进行的本地交互。

### 8.3 验收方式

- Vitest：覆盖上述请求响应排列组合和 Store reconciliation 结果。
- Vitest：覆盖同客户端回声、跨 Tab 更新、重复 `mutationId` 和旧响应丢弃。
- Runtime 事件测试：确认 Runtime 只发布生命周期事件，不接管业务数据。
- Performance Trace：确认目标 DOM node 在 landing settled 后不因普通刷新更换。
- 浏览器人工验收：抽屉拖入、连续拖动、回抽、跨标签页刷新和失败重试。

## 9. 风险与决策

| 风险 | 影响 | 应对 |
|---|---|---|
| 服务端列表缺少前端身份 | 组件重挂载、重复 hover | Store reconciliation 继承 `clientKey` |
| 旧响应晚到 | 新位置被覆盖 | mutation 序列和实体版本校验 |
| 事件与刷新重复 | 请求风暴、状态抖动 | 统一刷新队列和事件去重 |
| 业务侧继续补 hover 状态 | ownership 冲突 | 删除 phase→hover 编排，保留 Runtime 单一生命周期 |
| 通用抽象过早 | 改动面过大 | 先完成画布 Phase 1，再抽取稳定原语 |

本 PRD 的完成标准不是“某一张卡片看起来正常”，而是本地交互、组件身份和服务端最终一致之间形成可测试的统一契约。
