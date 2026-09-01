# InteractionSync 乐观更新与画布二次 hover 竞态

## 背景

2026-09-02，抽屉项目卡拖入画布后，鼠标一直停留在落点卡片上时，卡片偶发出现二次 hover：落地动画结束后卡片短暂抬升，`card-actions` 和连接点出现又消失，随后再次进入正常 hover。问题只在服务端回写/刷新参与时稳定出现；切换到仅本地拖拽模式后不再复现。

## 定位过程

这次没有继续对 `opacity`、`transform` 或 hover 样式做增量补丁，而是结合二分、性能 trace 和运行时探针核对实际时序：

1. 旧版本 Runtime 基线没有问题，问题位于后续版本的本地状态与服务端状态同步链路。
2. 仅本地拖拽时没有二次 hover，说明 landing 动画本身不是唯一触发条件。
3. trace 显示第一次 `opacity` 出现发生在目标卡片首次进入 DOM 后，随后服务端数据回写使卡片状态或节点身份发生变化；旧节点的 hover 被清理，新节点又在鼠标仍停留时触发正常 hover。
4. 当前 `dev` 已经没有旧的 `phaseObserver → hoverSuppressed → synthetic mouseenter` 逻辑，因此不能把早期分析中的“人为派发第二次 mouseenter”当作当前根因。

## 根因

抽屉拖拽使用 optimistic 数据立即把目标卡片插入画布，Runtime landing 与服务端实时回写随后并行发生。服务端回写如果按新的 key 或不完整实体替换 optimistic 卡片，会让 Vue 卸载并重新挂载目标节点。鼠标位置没有变化，但浏览器面对新的 DOM 节点会重新计算 hover，于是出现：

```text
optimistic 卡片挂载
  → 第一次 native hover / opacity 开始
  → 服务端回写替换节点或状态
  → 原 hover 状态被清理
  → 新节点在鼠标下再次触发 hover
```

因此问题本质是本地交互状态与服务端回写的身份、时序没有统一收束，而不是某一个卡片颜色或 CSS transition 单独错误。

## 修复边界

引入并完成 `InteractionSync` Phase 1-4，统一处理高频本地交互的 mutation 身份、optimistic 生命周期、服务端确认、失败回滚、同客户端回声抑制和资源事件队列：

- 使用稳定的 `clientKey`、`clientId` 和 `mutationId`，服务端确认或刷新只合并实体，不替换正在交互卡片的前端身份。
- 同一客户端发出的服务端事件不再立即覆盖本地 optimistic 状态；其他客户端或浏览器标签页的变更仍可进入同步链路。
- 项目、日历、文件、便签和定时任务的高频交互统一经过 `InteractionSync`，领域代码只提供实体操作所需的 apply/request/rollback 能力。
- Runtime 负责拖拽、landing、revealing 和视觉生命周期；业务卡片只负责注册对象、surface 以及反映真实的 pointer hover，不再根据 Runtime phase 重建 hover。
- 删除探针和临时调试代码，不通过人为派发 `mouseenter`、重复 conceal 或额外 opacity 补丁掩盖竞态。

对应方案与文件树见：[InteractionSync 本地交互同步层 PRD](../prds/【已完成】PRD-UI-7-本地交互与服务端同步一致性.md)。

## 验证结果

已通过以下验证：

- 抽屉 → 画布拖拽，鼠标停留在目标卡片上，landing 结束后不再出现二次 hover 或 `opacity 1 → 0 → 1` 闪烁。
- 本地拖拽与服务端回写两种模式均可完成落地；服务端确认不会卸载并重挂载本地交互中的卡片。
- 跨客户端更新仍能同步，当前客户端的本地交互不会被自己的回声打断。
- 前端测试 403 项通过，TypeScript typecheck 和 production build 通过。
- Python 后端相关模块 `compileall` 通过，`git diff --check` 通过。
- 提交前已清理 `mind-hover-probe`、`console.debug` 和 `console.trace` 等临时探针。

## 经验

遇到“动画先正常、数据刷新后重新 hover”的问题，应优先检查节点身份、optimistic 实体对账和事件回声，而不是继续叠加 hover 样式补丁。对于所有需要即时反馈的交互，应由统一同步层管理本地状态与服务端确认，避免每个业务页面各自实现一套乐观更新和刷新抑制规则。
