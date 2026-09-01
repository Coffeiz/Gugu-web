# PRD-ARCH-7：Interaction Runtime 与 Gugu 业务代码收敛方案

> 状态：🟡 部分完成，画布侧 landing/hover 编排已收回适配桥接，等待 Runtime 3.0.4 发布后完成版本锁定
> 创建：2026-09-01
> 最近更新：2026-09-01
> 关联模块：`frontend/src/interaction/runtime/`、`frontend/src/views/Mind/`、`frontend/src/stores/mind.ts`、`gugu-interaction-runtime/src/`
> 背景参考：`docs/refactor/_archive/Interaction Runtime业务侧Core API迁移阶段1.md`、`docs/devlog/2026-07-15-抽屉项目卡落地交接-可见克隆与节点身份必须连续.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| Object/Surface 注册 | 画布、抽屉和普通项目卡已接入 Runtime | ✅ 已完成 | Gugu 负责注册业务对象，Runtime 负责交互会话。 |
| 拖拽、代理和 landing | Runtime 已负责跟手、代理、落地、reveal 和 dispose | ✅ 已完成 | 业务侧不应再复制运动算法、FLIP 或代理生命周期。 |
| 业务持久化 | 画布项目引用支持乐观插入、异步落库和失败回滚 | ✅ 已完成 | 依赖 Gugu API 和数据模型，继续留在 Store。 |
| 目标 DOM 交接 | Gugu 仍负责 Teleport/异步渲染后的业务目标解析 | 🟡 部分完成 | 目标解析入口可以保留，但通用等待和收尾契约需要 Runtime 统一。 |
| landing 状态与刷新闸门 | Gugu 仅保留业务刷新闸门，生命周期由 Runtime 视觉事件驱动 | ✅ 已完成 | `activeMindLandings` 只表达业务刷新延后，不再推断通用 session 状态。 |
| hover 恢复 | Runtime 统一控制 phase/affordance，卡片只维护自身鼠标状态 | ✅ 已完成 | 已删除业务侧 phase 监听、hover 抑制和合成 `mouseenter`。 |
| 版本契约 | Gugu 锁定 `3.0.3`，Runtime 仓库 HEAD 为 `3.0.4` | 🚧 进行中 | `move-visual-settled` 的增删必须先统一，否则收尾行为不确定。 |

## 1. 背景与目标

### 1.1 现状问题

Runtime demo 已经能够完成抽屉与画布之间的拖拽，但 demo 使用内存模型和稳定 DOM；Gugu 还需要处理后端请求、乐观 placeholder、Vue/Teleport 重挂载、实时事件刷新、画布坐标和关系线。因此业务侧保留部分编排是合理的，但目前还混入了通用交互生命周期：

- Runtime 已写入 `data-runtime-phase` 和 `runtime-affordances-hidden`，Gugu 又通过 `MutationObserver` 维护 hover 抑制。
- Runtime 已发出视觉过程事件，Gugu 又维护 `activeMindLandings` 和双 `requestAnimationFrame` settle 闸门。
- Runtime 3.0.3 与 3.0.4 对 `move-visual-settled` 的契约不一致，Gugu 仍依赖旧事件分支。
- 业务侧补丁、探针和 Runtime 视觉逻辑交错，导致 landing 期间 `card-actions`、`conn-dot` 和 hover 状态容易出现竞态。

### 1.2 目标

建立一条单一的跨 Surface 移动生命周期：

```text
Runtime session
  -> visual update
  -> business action / target readiness
  -> landing
  -> reveal
  -> settled
  -> business refresh
```

目标：

1. Runtime 统一拥有拖拽视觉、phase、hover 锁定、reveal 和 settled 契约。
2. Gugu 只注册 Object/Surface/Target，消费 Action 和生命周期事件，执行业务数据变更。
3. 保持乐观插入、异步落库、失败回滚、Teleport 和实时刷新语义不变。
4. 先完成画布项目卡这一条完整切片，再评估文件库和其他 Surface 是否复用同一接口。
5. 删除经过验证的补偿代码和探针，不通过新增业务侧补丁掩盖 Runtime 状态冲突。

### 1.3 非目标

- 不把项目、画布、节点、关系线或 API 请求迁入 Runtime。
- 不让 Runtime 了解 Pinia、后端 schema、项目 ID、placeholder ID 或实时事件协议。
- 不把普通项目页面的 CSS `:hover` 改造成 Runtime 状态；普通项目卡 hover 仍是页面 UI 行为。
- 不在本 PRD 中修改拖拽手感、landing 参数、z-index 或视觉设计 token。
- 不直接删除 Runtime 3.x Vue 兼容入口；删除兼容入口需另立主版本任务。

## 2. 功能需求

### FR-ARCH7-01：统一 Runtime 版本与视觉事件契约

Gugu 使用的 Runtime 版本、lockfile、已安装构建产物和 Runtime 源码必须属于同一兼容契约。视觉事件必须明确区分：

- `move-visual-update`：代理或目标视觉位置变化；
- `move-visual-end`：视觉帧追踪结束；
- `move-visual-settled`：完整 landing/reveal/dispose 事务完成，若保留该事件则必须成为公开稳定契约。

Gugu 不得依赖未在当前 Runtime 类型和构建产物中声明的事件。

### FR-ARCH7-02：Runtime 统一 landing 与 hover 生命周期

Runtime 在 `active`、`landing`、`revealing` 和 `idle` 阶段统一控制对象 phase、代理交互、目标显隐和 affordance 显隐。宿主只读取稳定生命周期，不再自行监听 DOM class 变化来推断 Runtime 状态。

指针在 landing 结束时仍位于目标卡片上，目标卡片必须恢复正常 hover；指针已经离开时不得伪造一次新的 hover。该行为必须由 Runtime 生命周期和宿主适配器共同完成，但判定时序只能有一个事实来源。

### FR-ARCH7-03：业务侧只提供业务交接函数

Gugu 的 Mind 适配层只提供：

- Object/Surface 注册与 generation 生命周期；
- 目标业务 DOM 的解析函数；
- Action 到 Store/API 的映射；
- 乐观数据和失败回滚；
- 业务刷新策略。

不得在业务组件中复制代理创建、视觉 phase 推断、通用 settle 延迟、hover 补发或 Runtime 运动算法。

### FR-ARCH7-04：保持乐观项目引用语义

抽屉拖入画布时必须先创建稳定的前端 placeholder，使 Runtime 能取得真实目标 DOM；网络请求在后台完成。regrab、连续移动、失败回滚和真实 ID 替换必须保持现有行为，`clientKey` 不得因 placeholder 到真实数据的转换而改变。

### FR-ARCH7-05：刷新只能等待业务认可的 settled

实时事件刷新可以在 landing 期间延后，但阻塞条件必须来自 Runtime 的稳定 settled 生命周期。Gugu 只决定“哪些业务刷新需要延后”和“settled 后如何刷新”，不再自行猜测 Runtime 是否已经结束。

## 3. 技术方案

### 3.1 Runtime 侧

在 Runtime 公开一个明确的移动生命周期事件或完成回调，至少提供 `sessionId`、`objectId`、`fromSurfaceId`、`toSurfaceId` 和生命周期阶段。事件必须在旧 session 被 interrupt/cancel 时失效，不能晚到修改新 session。

Runtime 内部继续负责：

- `MoveSession` 状态转移；
- detach/clone proxy；
- Surface 命中、目标追踪、FLIP 和 landing motion；
- `data-runtime-phase`、目标 visibility ownership 和 affordance 隐藏；
- reveal 后 proxy dispose 及最终 settled 通知。

如果保留 `move-visual-end` 与 `move-visual-settled` 两个事件，必须在类型、文档、测试和 npm 构建产物中同时存在；否则统一迁移到单一的 `move-settled` 语义，禁止 Gugu 侧保留兼容猜测。

### 3.2 Gugu 适配层

`useMindRuntimeObject.ts` 只保留 Object 注册、DOM 绑定、业务目标解析和 Action 转发。hover 抑制应改为消费 Runtime 提供的稳定状态或生命周期回调；完成迁移后删除 `MutationObserver`、合成 `mouseenter` 和与 Runtime phase 同构的本地状态。

`canvas.ts` 只保留 Mind 特有的 resolver 注册和业务刷新桥接。`activeMindLandings` 可以暂时作为刷新策略的适配状态，但不能继续承担 Runtime 事务真相；settled 到达后必须幂等清理。

`mind.ts` 继续拥有 `addProjectRefOptimistic()`，因为它负责数据库创建顺序、最新坐标 flush、取消清理和失败回滚。这部分不迁移，只把“何时允许刷新”改为消费 Runtime 契约。

### 3.3 普通项目页面边界

项目页面的 `ProjectCard.vue` 普通 hover 是 CSS 卡片状态，不属于画布移动 Runtime。它只需要注册 Runtime Object 以支持看板拖拽；除拖拽期间的 Runtime 视觉控制外，不应为普通 hover 引入 Mind 的 landing/hover 适配。

### 3.4 观测与清理

迁移期间可以保留开发环境下的生命周期计数器，但不得记录聊天正文、附件名、完整业务对象或凭据。验证完成后删除探针、旧事件兼容分支和无效 import，并通过 `rg` 扫描确认没有业务侧第二套 phase/settled 推断。

## 4. 验证与上线

验证顺序：

1. 先锁定 Runtime 版本契约，确认 Gugu `package.json`、lockfile、`node_modules` 和 devserver 实际构建版本一致。
2. 使用 Runtime fake adapter 测试 `active → landing → revealing → idle/settled`，覆盖 cancel、interrupt 和 regrab。
3. 使用 Gugu fake API 测试 placeholder、连续 regrab、服务端失败、实时刷新延后和 settled 后刷新。
4. 使用 Playwright 真实拖拽覆盖抽屉到画布、画布回抽屉、鼠标持续停留在落点和鼠标已离开四种情况。
5. 对 `card-actions`、`conn-dot`、卡片文本和目标本体分别断言显隐时序，不只断言最终截图。

验收命令：

```bash
cd frontend
npm run typecheck
npm run typecheck:strict
npm run test:run
npm run build
npm run test:e2e:stable -- e2e/mind-canvas-runtime.spec.ts
```

发布前必须确认 Gugu 使用的 Runtime 版本已发布并写入 lockfile。发现 landing 期间仍有状态反复时，停止业务侧增量补丁，回到 Runtime 生命周期事件和 session ownership 排查。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 3.0.3/3.0.4 事件契约漂移 | landing 闸门不结束或依赖分支失效 | 先统一版本和事件类型，再改 Gugu。 |
| Runtime 直接处理业务 DOM 重挂载 | Runtime 与 Vue 生命周期耦合，复用性下降 | Runtime 接收目标 resolver，不接触 Store/API。 |
| 删除 Gugu hover 补偿过早 | 鼠标停留在落点时 hover 不恢复 | 先补 Runtime 生命周期测试，再删除补偿。 |
| 实时刷新与 landing 同时发生 | 旧 DOM 替换新 session 正在使用的目标 | 保留业务刷新策略，改由 Runtime settled 作为闸门。 |
| 为修 bug 继续添加业务补丁 | 两边状态机再次分叉 | 本 PRD 明确禁止新增同类 phase/hover/settled 推断。 |

待确认事项：

- settled 是否继续作为独立公开事件，还是由 `move-visual-end` 重新定义为完整事务结束。
- Runtime 是否直接提供 `hoverSuppressed` 宿主回调，还是通过统一 `applyVisualState` 让组件只绑定状态。
- 画布项目卡作为第一条切片完成后，文件库语义目标是否需要同样的 settled/hover 契约。

## 6. 唯一实施 TODO

### Phase 1：版本与契约基线

- [ ] `ARCH7-001` 对齐 Runtime 版本、lockfile、构建产物和事件类型；责任边界：Runtime 发布与 Gugu 依赖；验收：Gugu 不再消费当前版本未声明的视觉事件，版本来源可由命令核验。
- [x] `ARCH7-002` 为 Runtime 移动生命周期补齐 settled/interrupt/regrab 契约测试；责任边界：Runtime；验收：旧 session 的延迟事件不能修改新 session，正常、取消和重抓路径都有唯一收尾；Runtime 编排测试 56/56 通过。

### Phase 2：画布项目卡收敛

- [x] `ARCH7-003` 将 Mind hover 抑制与恢复改为消费 Runtime 生命周期；责任边界：Runtime 提供契约，Gugu Mind 适配层接入；验收：删除 phase 推断和合成 `mouseenter` 后，卡片 hover 由 Runtime affordance 状态统一控制。
- [x] `ARCH7-004` 收敛 Mind landing 刷新桥接；责任边界：Gugu Store 保留刷新策略，Runtime 视觉收尾事件驱动业务闸门；验收：现有 placeholder、连续 regrab、实时事件和失败回滚测试保持通过。
- [x] `ARCH7-005` 删除已验证的探针、旧事件兼容分支和无效业务补丁；责任边界：Gugu；验收：生产构建无探针输出，`rg` 不再发现第二套通用 phase/settled 状态机。

### Phase 3：完整验证与归档

- [ ] `ARCH7-006` 增加抽屉↔画布真实拖拽 E2E 和卡片 affordance 时序断言；责任边界：Gugu E2E；验收：覆盖持续 hover、离开、regrab、失败回滚，且前端 typecheck、单测、构建和稳定 E2E 全部通过。
- [ ] `ARCH7-007` 更新 Runtime/Gugu 架构文档并标记本 PRD；责任边界：Runtime 与 Gugu 共同；验收：文档明确 Object/Surface/Target、业务持久化、hover 和 settled 的唯一责任归属。
