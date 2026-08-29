# 咕咕 · 早期开发记录

## 2026-08-26 · Skill 关联 Schema 按需注入与未声明工具执行门

### 修复

- `use_skill` 成功后，将 Skill 关联工具的当前 Schema 和实现指纹作为 canonical event
  追加到历史尾部；不重排稳定前缀，也不把全量 Schema 放回首轮。
- 固定 Adapter 模式下，业务工具没有当前版本 Schema 时，dispatch 前直接返回
  `tool_schema_required`，要求先调用 `get_tool_schema`，避免模型凭记忆猜参数并触发副作用；参数校验失败时 Runtime 会自动回注当前工具 Schema。
- Schema 判断同时比较 Schema digest 和 implementation digest；工具实现更新后会要求重新声明。

### 验证

- canonical history、Schema digest、工具契约和缓存边界专项测试通过。

## 2026-08-26 · 统一上下文 canonical 序列化并修复工具续轮缓存断点

### 根因

- 自动 RAG 当前轮使用 `knowledge-context` block，历史中仍可能存在旧版
  `[owner-rag]...[/owner-rag]` 纯文本；恢复后消息结构变化，provider cache 在首个
  RAG 位置断开。
- 工具续轮把旧动态 tail 插回新消息之前，会重排上一轮前缀；即使 schema 没有重复，
  cache anchor 也会落在不稳定的消息边界。

### 修复

- 新增统一上下文序列化约定，RAG 当前注入、历史恢复和 provider wire 均使用同一
  `knowledge-context -> text block` 结构。
- 工具续轮首次追加时提升旧动态 tail，再按原顺序追加 assistant/tool 消息；动态 tail
  不写回历史，旧 cache anchor 保持在原消息索引上。
- 增加 RAG wire 形状一致性、旧记录恢复和工具续轮前缀稳定性回归测试。

### 验证

上下文、RAG、canonical tool history、provider 和 session snapshot 专项测试通过。

## 2026-08-25 · ContextBudget Phase 6/10 收口

### 完成内容

- 统一 90% 观察线由 provider usage 驱动，core 不再复制预算比例常量。
- 删除 `select_history_window`、历史读取 `token_budget` 兼容参数及其旧裁剪测试，避免 ContextBudget 之外残留第二套历史窗口语义。
- 完成 ContextBudget、压缩 cap、provider overflow retry、baseline 提交、session gate/pending 的专项回归。
- 上下文专项测试通过 64 项；devserver 上下文专项测试通过 67 项。本地全量 1419 项通过、1 项 knowledge 内容换行断言失败，属于本次范围外的工作区改动。

### 验收边界

自动化验收已完成；真实长群 trace 的 cache/输入 token 对比和多 worker 故障恢复仍需在产品环境持续观察。日志只记录脱敏预算分项和生命周期状态，不记录对话正文。

## 2026-08-19 · 修复创建画布后 "咕咕开小差了" ValueError 错误

### 现象

用户创建画布后，咕咕返回 "咕咕开小差了 😵‍💫 麃烦再说一遍吗？"，实际工具调用成功但第二轮 LLM 调用失败。日志显示：

```
08-19 09:01:34 INFO [agent.traj] {"t": "tool", "tool": "mind_create_canvas", "user": "019eec39", "ok": true, "ms": 23, "args": {"title": "***"}, "trace": "cfc05e34ead3"}
08-19 09:01:34 ERROR [agent.core] LLM 调用中途出错：ValueError
```

### 初步误判

最初认为是 MiniMax API 对工具返回值中 `null` 字段（如 `project_id: null`）的容忍度问题，尝试将 `ValueError` 添加到 MiniMax 的 `transient_exceptions` 重试列表。

### 根本原因

通过完整链路测试，精确定位到 `agent/loop_drivers.py` 第 125 行的缓存处理逻辑错误：

```python
# 错误代码
elif isinstance(content, str):
    new_content = [dict(content, **{"cache_control": {"type": "ephemeral"}})]
```

当 `content` 是字符串时，`dict(content)` 会将字符串的每个字符视为键值对序列。如果字符串长度是奇数（如 `"hello"` 有 5 个字符），会抛出：

```
ValueError: dictionary update sequence element #0 has length 1; 2 is required
```

这不是 MiniMax API 的问题，而是 Anthropic 格式缓存处理的代码逻辑错误。

### 修复

```python
# 修复后
elif isinstance(content, str):
    new_content = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
```

### 验证

通过完整的 agent 链路测试（74步详细跟踪），确认：
- ✅ 第一轮 LLM 调用成功（调用 mind_create_canvas）
- ✅ 工具执行成功并返回结果
- ✅ 第二轮 LLM 调用成功（接收 218 个 token）
- ✅ 没有出现 ValueError

### 调试方法

创建了三个测试脚本逐步排查：

1. **test_simple_valueerror.py** - 测试基础序列化和消息格式
2. **test_minimax_null_fields.py** - 测试 MiniMax API 对 null 字段的容忍度
3. **test_full_agent_flow.py** - 完整 agent 链路测试，精确定位错误发生位置

第三步成功捕获到 ValueError 的确切位置和堆栈。

### 经验教训

- **逻辑错误不重试** - ValueError 通常是代码逻辑问题，重试机制无法解决
- **让错误暴露** - 撤回重试兜底，让错误直接暴露有助于快速定位根因
- **逐步测试** - 从简单到复杂的测试策略能有效缩小问题范围

### 相关文件

- `backend/agent/loop_drivers.py` - 根本原因修复
- `backend/test_full_agent_flow.py` - 完整链路测试脚本
- `backend/test_minimax_null_fields.py` - MiniMax API 容忍度测试

## 2026-08-17 · 修复 LoopScope 用量监控全为 0

### 现象

LoopScope 顶部用量格全为 0（Input / Output / Cache read / Fresh input / Total），而下方 LLM span 卡片有 `~` 前缀的 token_impact 估算。即 usage 从未落地，span 只有估算没有实测。

### 根因

`agent/core.py` 的 `_run_loop` 收到 `("done", value)` 后立即 `break`，不再消费 `driver.run_round` 这个生成器的剩余部分。而 `hooks.py` 的 `traced_round` 把「记录 usage」的代码放在 `async for` 循环结束之后（循环正常走完才执行），外层提前 break 导致生成器被提前关闭，该段代码永远执行不到——所以 `span.usage`、`run.add_usage()` 全部没跑，监控拿到 0。

### 修复（两层）

1. **hooks.py**：`traced_round` 收到 `kind == "done"` 时，在 yield done 之前就把 usage 落地——设置 `span.usage`、`span.finish(...)`、`run.add_usage(...)`。即使外层立即 break，数据也已经写入。同时把 `except GeneratorExit` 扩成 `except (GeneratorExit, asyncio.CancelledError)`。
2. **core.py**：流式中途取消（`_im_cancelled` 命中）时，`_run_loop` 原来直接 `return`，把 `run_round` 生成器丢给 GC。

### Python 3.14 的坑（排查中发现）

`async for` 在 `try` 块内提前退出（break/return）时，生成器的 close 被推迟到 GC 才执行，注入的异常可能是 `GeneratorExit` 也可能是 `asyncio.CancelledError`（取决于 frame 状态）。只 `except GeneratorExit` 会漏掉 CancelledError 的情况；且不主动关生成器的话，span 会一直挂着 `running` 直到 GC。因此取消路径改为显式 `await _round_gen.aclose()`，同步注入 GeneratorExit，`traced_round` 立即把 span 标成 `cancelled`，不再等 GC。

### 回归测试

新增 `tests/test_loopscope_usage.py`：

- `test_usage_lands_before_done_break`：fake `_stream_round` 产出 token/final，断言 `run.usage` 与 LLM span 的 usage == 期望 7 键 dict，span 状态为 success。防的是「外层收到 done 即 break，usage 永远不落地」。
- `test_mid_stream_abort_marks_span_cancelled`：fake 流产出 30 个 token，`_im_cancelled` 第二次返回 True，断言 span 状态立即为 cancelled（而非 running）。防的是「中途取消后 span 挂着 running 直到 GC」。

`test_core_loop_characterization.py` 13 个用例全绿，无回归。

## 2026-08-16 · Runtime 卡片主题过渡不再抢占交互动画

`component-theme-refinements.css` 的卡片主题规则曾用 `transition: ... !important` 覆盖 Runtime 在抓取、FLIP 和 landing 生命周期中写入的过渡。现在保留同一组 `--card-motion` 主题动效，但移除卡片本体 transition 的强制优先级；伪元素 hover 层仍保留自己的过渡。

回归说明：抽屉卡片拖出/拖入时，兄弟卡片应继续执行 FLIP，grabbing 阴影应连续交接到 landing；主题 hover 动效仍保持不变。

## 2026-08-06 · 视频链路 PR 审查收尾（P2 后续优化 + P3 文档修正）

PR #7 视频链路审查确认 3 个 P1 已修复（事件循环阻塞、竖屏长边、超限回退），全量 701 测试通过。另有两个非阻塞项：

- **P3（已修）**：统一文档与源码注释里过时的「>90MB 兜底走 base64」描述为「>90MB 明确拒绝，不回退 base64」。涉及 `chat_attach.py` 设计注释、`TEST-LLM-MINIMAX-M3-视频MM_FILE传输.md` 策略、`PRD-LLM-3` 数据注意事项三处。
- **P2（后续独立优化，不阻塞 PR7）**：大视频仍是全量内存处理——同时持有原始 `raw`、压缩后完整 `bytes`、base64/multipart 数据、ffmpeg 子进程内存；`Semaphore(2)` 仅单进程内限流。对 2C2G 部署，多个 ~90MB 视频并发仍有内存压力。后续改为文件路径式流水线：`Storage → 临时文件 → ffmpeg 输出文件 → 流式上传`，不在 Python 中同时保留原始与压缩后完整字节；机器级并发建议降到 1，或用 Redis 做跨进程限流。

## 2026-08-05 · PR #7 合并前安全审查修复

审查发现三个需要阻断合并的业务问题：OSS 直传确认信任客户端大小、Redis shortcut 故障会阻断 IM 入队、定时任务执行时用展示文本覆盖结构化投递目标。

本次修复：

- OSS confirm 通过 `HEAD` 读取真实对象大小和 MIME，重新执行单文件上限与用户配额校验，并锁定用户行避免并发 confirm 超额。
- Redis 状态读取失败时 shortcut 默认放行到 worker；取消状态写入失败只记录受限诊断，不阻断消息处理。
- 定时任务拆分 `target_map` 和 `target_description`，实际投递始终使用任务保存的目标。
- IM 附件改为流式读取，限制单附件 50MB、单消息附件 100MB；连接层 DNS resolver 与 SSRF 校验共用内网地址判断，覆盖重定向、混合 DNS 和 IPv4-mapped IPv6。
- 权限解析显式区分内部 Bot 数据库主键与平台 Bot ID，非法平台 ID 按最小权限处理。

回归验证：后端 `638 passed`，ownership/confirmation guard 通过；前端 typecheck、strict typecheck、246 个单测和 build 通过。Alembic `current` 与 `heads` 均为 `20260804000007`；生产数据库副本升级/回滚和真实 OSS 对象测试仍需在部署环境完成。

> 更新：2026-07-16
> 状态：早期阶段记录，当前进度见 `product/OVERVIEW.md`

## 2026-08-04 · 开发环境后端热重载收口

之前开发机修改后端代码经常需要手动重启 systemd，主要是 Web、Worker、gateway 三个进程的职责和启动方式没有对应到开发入口：Uvicorn 只覆盖 Web，Worker 仍然是常驻进程，`onboarding/` 也不在原有 reload 目录中。

现在统一为：

- `cd backend && make dev-web`：前台启动 Uvicorn reload，监听 `app/`、`agent/`、`onboarding/`，并用 1 秒 graceful shutdown 避免 SSE 长连接卡住 reload。
- `cd backend && make deps-dev && make dev-worker`：用 `watchfiles` 监听 `app/`、`agent/`、`onboarding/`、`worker.py`，Python 文件变化时自动重启 Worker。
- gateway 暂不自动 watcher；平台网关代码继续按 IM 网关规则单独重启。

这套 watcher 只用于开发，不能与同机 systemd Worker 并行运行，也不改变生产 systemd 服务配置。生产环境仍按改动所属进程执行 `systemctl restart`，数据库结构变更仍需单独执行迁移。

---

## 2026-07-18 · 已完成列动画事务复杂度复核

复核确认，已完成列当前的问题不是单个 CSS 或落地回调，而是多套布局事务同时存在：

- `DoneLayoutCoordinator` 同时维护 group FLIP 和 recent card FLIP。
- `DoneGroup` 继续独立启动组高度事务。
- `DoneLayout` 同时通过 `onBeforeUpdate/onUpdated` 和 `runLayoutMutation()` 触发布局事务。
- 项目拖拽桥还会并行启动 clone2 landing。

这些逻辑分别控制父级 transform、子级 height、卡片显隐和滚动位置，导致二次 FLIP、瞬间收缩、滚动顿挫和落地目标变化反复出现。后续不再继续添加局部补偿，改为在主文档的 `DoneLayoutRuntime` 中统一 capture、最终布局计算、滚动和动画收尾。

本次只更新架构结论，没有修改已完成列运行逻辑。详见 [拖拽系统模块化拆分方案.md](docs/refactor/_archive/拖拽系统模块化拆分方案.md)（已归档，被 gugu-interaction-runtime 取代）的「FLIP 基础设施与页面适配」章节。

## 2026-07-18 · 项目抽屉状态组的两个位移 bug：重叠事务、合成层未重绘

### 现象

1. 刚展开一个状态组（组的展开动画还在播），紧接着把这个组里第一张卡拖出到画布——组会莫名再跳一下。
   只在"展开动画还没播完就立刻拖卡"时出现，展开动画早播完了（比如默认展开的"进行中"）就不会。
2. 硬刷新页面后，如果某个状态组里恰好有一张卡当前在画布上，组内会莫名留出一张卡的空位，即使角标
   显示的数量已经是对的；SPA 内切换页面再回来不会有这个问题。只要再触发一次这个组的数据变化
   （比如把画布上那张卡拖回抽屉），空位就会消失。

### 根因

1. `projectGroupsLayout.ts` 的 `requestLayout()` 只会取消"还没开始播放"的 `pending` 事务；一旦
   `measureAndPlay()` 已经跑到 `await transaction.play()`，这笔事务就不再被 `pending` 追踪，变成
   孤儿。这时候如果又有新的 `requestLayout()` 调用（比如拖拽触发的 `data-update`），它会直接
   `getBoundingClientRect()` 读取各组的 `top`，读到的是上一笔事务还在 transform 插值中的中间态，
   而不是真实落点。等上一笔事务自己播完、清空 transform 复原到真实 CSS 位置，组就会从"中间态"
   瞬间跳到真实位置——看起来像莫名又跳了一下。

2. 页面刚加载时，画布数据（`canvasProjectIds`）有时比抽屉的项目列表晚到，`filteredProjects` 因此
   会先渲染出偏多的卡片，紧接着再收窄一次（排除掉已经在画布上的项目）。这次收窄走的是原生 flex
   回流（`.project-group-content` 没有触发折叠动画，只是 `v-for` 少渲染了一个子节点），跟
   `createGroupLayoutTransaction` 的显式折叠不一样，没有做过任何强制同步 reflow/repaint。用
   `getComputedStyle` 量出来的高度已经是对的（缩小后的高度），但极少数情况下 Chrome 的合成层
   没有跟着重绘这块区域，画面还停在收窄前的高度——数据层面完全正确，纯粹是画面没刷新。

### 修复

1. `projectGroupsLayout.ts` 增加一个 `playing` 引用记录"当前正在播放"的事务；`requestLayout()`
   除了取消 `pending`，也会一并取消 `playing`，让它立即清理内联 transform、落回真实位置，新一笔
   事务的 before 基线才是准的。

2. `CanvasSidebar.vue` 的 `onUpdated()` 里对 `.project-groups` 补一次强制同步 `offsetHeight`
   reflow，再做一次无位移的 `translateZ(0)` 抖动（改了立刻改回，视觉上不产生位移）强制该层
   重新合成。

### 教训

- 一个只追踪"待播放事务"的取消机制，管不到"已经在播放中"的事务——事务的生命周期比表面看到的
  "pending → 播放 → 结束"三段更容易在并发请求下产生孤儿态，取消逻辑要覆盖到"正在播放"这一段，
  不能只覆盖起点。
- 布局数据（`getComputedStyle`/`getBoundingClientRect`）正确不等于画面正确；当一个 bug 只在
  "页面刚加载、某块区域还没被绘制过"这种特定时机出现，且所有 DOM/尺寸探针都显示数据正常时，要
  怀疑纯粹的合成层重绘问题，而不是继续在布局逻辑里找错。

### 验证

- 场景一：反复"展开一个组 → 立刻拖出组内第一张卡"，组不再跳动；`typecheck` 通过。
- 场景二：多次硬刷新页面，画布上有卡片对应的抽屉组不再留空位；用户确认修复。

---

## 2026-07-17 · 项目抽屉状态组展开/收起的两次二次动画

### 现象

项目抽屉的状态组（进行中/待开始/已完成）支持展开/收起。两个独立问题：

1. 已有一组展开着的情况下再展开/收起另一组，兄弟组的让位动画会明显playing 两遍——先平滑挪到位，
   紧接着又用 transform 重新播一次同样的位移，只有单独展开一组（没有其它可见内容需要让位）时才不明显。
2. 修完第 1 个问题后，收起动画播完仍残留 1 帧、约 1-2px 的额外向上位移，量级很小但每次收起都会出现。

### 根因

**问题 1**：`toggleProjectStatus` 同时接了两套让位机制——`createGroupLayoutTransaction` 直接
animate 折叠元素自身的 `element.style.height`，这本身就是文档流里的正常块级/flex 子项高度变化，
后面的兄弟 `.project-group` 会跟着逐帧自动回流、免费拿到平滑让位；而 `toggleProjectStatus` 又额外
调用了 `projectGroupsLayout`（`createFlipTransaction` 的 before/after 快照 + transform 补间）去做
同一批兄弟组的位移。折叠过渡已经把兄弟组挪到位之后，这层 FLIP 事务照着快照又用 transform 重播了
一遍同一段位移——两段动画数值一致、视觉上就是"完成了又来一次"。

**问题 2**：`.project-group` 是 `display:flex; flex-direction:column; gap:6px`。折叠内容元素的
`height` 过渡到 0 后，只要它还没被 Vue 的 `v-if` 真正移出 DOM（leave 回调里的 `done()` 比
`cleanup()` 晚一拍才调用），flex `gap` 依然会在它和上一个兄弟（分组标题按钮）之间占位——这份空间
跟元素自己的 `height` 无关，只跟它还算不算一个 flex 子项有关。等 DOM 真正移除、gap 随之消失，
父容器和后续兄弟组才会再产生一次可见的位移。用 Performance 级别的多帧探针（`before-cleanup` /
`after-cleanup` / `mutation-observed` / `frame+1~6`）实测确认：`groupHeight` 在 DOM 真正移除
（`mutation-observed`）那一刻才从 31 掉到 25，差值正好等于 `gap` 的 6px。

最初怀疑过 `cleanup()` 把内联样式还原回事务开始前状态导致的"高度闪回"（还原成空字符串会撤销
`height:0` 约束，元素瞬间弹回自然完整高度、又在下一帧被移除），这个猜测本身也是真实存在的坑
（已经修掉：收起场景 `cleanup()` 不再还原内联样式，反正元素马上要被移除，恢复原状没有意义），
但不是这次 1-2px 残留的成因——探针数据显示 `before-cleanup`/`after-cleanup` 两帧 `groupHeight`
完全一致（都是 31→后来 25，两次真正的变化点始终是 DOM 移除那一刻，不是 `cleanup()` 那一刻）。

### 修复

1. `toggleProjectStatus` 不再触发 `projectGroupsLayout` 的 FLIP：只保留一次 `requestLayout('toggle')`
   调用（唯一作用是置位 `skipNextDataUpdate`，抵消紧跟着 `onBeforeUpdate` 触发的 `'data-update'`
   请求，避免同一次 toggle 从另一个入口重新引入二次动画）。`onGroupFoldEnter`/`onGroupFoldLeave`
   收尾也不再调用 `measureAndPlay`，只保留 `measurePanel('projects')` 同步抽屉外层高度。
   `projectGroupsLayout` 的 FLIP 现在只服务于真正的拖拽改数据场景（`data-update`），那种情况下
   卡片数量是非连续突变，没有平滑高度过渡可言，才真的需要 FLIP 补偿。

2. `createGroupLayoutTransaction` 收起时给折叠元素叠加一段等量负 `margin-top` 过渡，跟 `height`
   同一个过渡窗口内一起走完——`height:0` 的空间 + `gap` 占的空间 + 负 margin 抵消的空间，净值在
   动画终点正好归零，DOM 真正移除时不会再有可见变化。展开方向对称处理（`margin-top` 从 `-gap`
   过渡回 `0`）。`gap` 值从父容器 `getComputedStyle(parent).rowGap` 现取，不需要写死常量。

### 教训

**FLIP 补偿是有代价的，普通块级/flex 布局能免费提供的平滑效果不需要 FLIP。** 高度用真实过渡
（而不是瞬间切换）驱动时，同一文档流里的兄弟元素本来就会跟着逐帧自然回流；这时再叠一层
"快照位移再补间"式的 FLIP，只会重播一次已经发生过的动作。FLIP 该留给真正非连续的布局跳变
（数据突变、跨容器重挂载），不是默认对所有布局变化都套用的万能工具。

**flex/grid 的 `gap` 不受子项自身尺寸变化的直接约束，只受"是否还是一个子项"约束。** 子项收缩到
`height:0` 不等于它不再占 `gap` 的份额——只要还在 DOM 里参与 flex/grid 布局，`gap` 就照占不误，
这类残留要么等 DOM 真正移除、要么显式用等量反向 margin/gap 覆盖抵消。

### 验证

- `npm run typecheck` 通过。
- 已有一组展开时再展开/收起另一组：兄弟组让位动画不再播放两次；收起动画播完确认无残留位移。
- 拖拽改数据触发的组收缩（`onBeforeUpdate`/`data-update` 路径）手测确认未受影响。

---

## 2026-07-17 · 项目跨列重抓残留旧 clone2

项目卡从一列拖到另一列后，落地动画尚未结束时再次抓起，旧落地 `clone2` 可能仍停在目标列的落点，
看起来像抓起时凭空多出一张假卡。跨列的 Vue keyed 列表可能重挂载项目卡 DOM，原来的
`DragRegistry` 只按 HTMLElement 引用管理 session；新 DOM 与旧 DOM 引用不同，旧 session 就无法被
新拖拽取消，旧 morph cleanup 继续保留 clone2。

修复为在保留元素引用门禁的基础上，按 `data-project-id`、`data-file-id`、`data-folder-key` 建立稳定
身份索引。相同业务卡片换 DOM 后开始新 session 会先取消旧 session，触发旧 holder/clone2 的统一清理，
并新增回归测试覆盖“稳定身份替换 DOM”场景。

**教训：** keyed 列表的 key 稳定不等于 DOM 引用一定稳定；跨列、分组和异步挂载场景的动画 session
需要同时具备元素引用和业务身份两层取消门禁。

## 2026-07-17 · 抽屉展开导致 clone2 落点先错后纠正

### 现象

从画布把卡片拖入项目抽屉时，如果抽屉原本卡片较少，落地过程中会因为内容增加而展开、变高。clone2
仍按展开前的卡片位置飞行，接近终点后才快速移动到本体的最终位置；部分尝试还会让本体提前闪现，或让
卡片先缩放/旋转到错误状态再纠正。抽屉已经完全展开时不明显，因此容易误判为 clone2 自身的 easing 问题。

### 根因

抽屉内容使用两层 `TransitionGroup` 做 FLIP，外层容器高度也同时通过 CSS transition 变化。飞行开始时直接
读取 `getBoundingClientRect()`，拿到的是祖先高度过渡中的中间视觉盒，而不是抽屉展开结束后的最终布局盒。
随后 ResizeObserver 又观察到容器高度变化，重复 retarget clone2，导致终点连续改变，最后一段表现为瞬移。

### 修复

在 `interaction/dom.ts` 增加不受 transform 影响的布局测量：沿目标和滚动容器的 `offsetParent` 链累计
`offsetTop` / `offsetLeft`，得到稳定的布局坐标；同时在测量终点前临时把目标祖先链上正在运行的 Web Animation
seek 到终点，读取抽屉完全展开后的尺寸和位置，再恢复动画进度。这样 clone2 从第一帧就以最终落点为目标，
不再依赖动画中途的补偿式 retarget。

本体揭示继续延后到 clone2 收尾，避免目标卡片在抽屉高度变化期间提前显示；抽屉侧的滚动、相机和业务状态
时序不由落点测量工具直接修改。

### 教训

**动画中的视觉坐标不能直接当作最终布局坐标。** 当落点元素的祖先同时在做高度、FLIP 或滚动变化时，必须
先计算无 transform 的最终布局盒；否则每次布局变化都会把误差推迟到动画末尾，形成“先飞错、再瞬移纠正”的感觉。

### 验证

- `npm run typecheck` 通过。
- 抽屉未完全展开、抽屉已完全展开、目标需要滚动以及连续拖入四类路径均进行手测。
- 后续仍需将这套最终布局测量纳入 FLIP 协调器，避免抽屉和拖拽流程各自维护一套位置修正逻辑。

### 追加：同列接力时的短暂停顿

跨列落地尚未结束时从 `clone2` 再次抓起并放回当前目标列，原位归还路径比拖回另一列更容易出现
短暂停顿。旧 session 的取消收尾会在本体上安排 `phys-just-revealed` 等临时揭示类的下一帧清理；
新 session 若在这之前 clone，本体状态会被 `cloneNode` 一并带走。开始新拖拽时现在会先清除这些仅用于
揭示收尾的临时类，再创建新 clone，避免同列归还继承上一段动画状态。

trace 进一步确认，主要顿挫发生在 `threshold.onMove → DragRegistry.start → DragSession.cancel →
morphLifecycle.forceCleanup`：旧 session 的取消同步执行完整 reveal，并触发一次合成的
`mouseenter` 和布局更新。新增 handoff 标记后，重抓交接只清除旧 holder/clone，不再揭示本体；新
session 接管后自行建立视觉状态，普通取消仍走完整 reveal 收尾。

---

## 2026-07-16 · 已完成列拖拽动画：年月行 FLIP 缺口与月份文件夹嵌套

### 问题

1. **拖出卡片时年月标题瞬间移动**：从已完成列拖出卡片，year-row / month-row 没有让位动画，直接跳到新位置。
2. **拖入卡片时年月组瞬间移动**：其他列的卡片拖入已完成列后，最近完成的第 3 张卡被挤出 `recentDone` 进入年月文件夹，此时年月行向上跳，没有过渡动画。
3. **月份展开后卡片不在文件夹内**：展开月份文件夹时，卡片出现在所有月份行的最底部，而不是在对应月份行下方。

### 根因

**问题 1 & 2**：Vue TransitionGroup 的 FLIP（`done-group-list-move`）依赖在 `nextTick` 窗口内捕获新旧位置。但拖拽场景中：
- 拖出时：`invertPlay`（drag 系统的 FLIP）查询子元素时没有覆盖 `.year-row` / `.month-row`（它们不是 `.project-card`），所以这些行不在 FLIP 补偿范围内。
- 拖入时：卡片从 `recentDone` 退出进入年月文件夹，触发 `done-card-list-leave` 动画。leave 动画结束后 Vue 才更新布局，此时 TransitionGroup 的 FLIP 窗口早已关闭，`move` class 永远不会被添加到年月行上。

探针验证：在 `afterCancel` / `afterFinish` 等时机读取 `[data-flip-target]` 元素的 class 和 computed style，发现 `move=false`、`transition=background 0.12s`——确认 Vue 从未给这些元素加 `move` class。

**问题 3**：模板中 month-row 和 month-cards 分两个 `v-for` 渲染——先遍历 `yg.months` 渲染所有月份行，再遍历 `openMonthList(yg)` 渲染展开的卡片容器。DOM 顺序导致所有卡片排在所有月份行之后。

### 修复

1. **拖出 FLIP**：在 `useDragEngine.ts` 的 `_childCards` 查询中加入 `[data-flip-target]`，让 drag 系统的 `invertPlay` 覆盖年月行；`flip.ts` 改用 `el.style.setProperty('transition', ..., 'important')` 压过 CSS `!important` 冲突。

2. **拖入 FLIP**：在 `DoneColumn.vue` 添加 `watch(recentDone, ...)` 手动 FLIP——在 `recentDone` 变化时记录年月行旧位置，`nextTick` 后记录新位置，差值用 `transform: translate()` 补偿，再 `requestAnimationFrame` 内过渡回零。这是对 Vue TransitionGroup FLIP 窗口过期后的手动补偿。

3. **月份嵌套**：把 month-row 和对应的 month-cards 放在同一个 `<template v-for="mg in yg.months">` 中连续渲染，卡片紧跟在月份行下方；`month-cards` 增加 `padding-left: 14px`、`margin-left: 12px`、`border-left` 实现视觉缩进嵌套。删除不再需要的 `openMonthList()` 辅助函数。

4. **退出动画妥协**：`recent-card-list .done-card-list-leave-active` 暂设 `display: none !important`，让卡片从最近完成退出时瞬间消失而非渐隐。原因是 leave 动画期间卡片仍占位，与手动 FLIP 的时序冲突会导致年月行跳动。后续可尝试用 `opacity` 渐隐 + `position: absolute` 脱流来兼顾两者。

### 教训

- Vue TransitionGroup 的 FLIP 只在 `nextTick` 窗口内生效，跨 TransitionGroup 的元素迁移（从一个 TG 的 leave 到另一个 TG 的 enter）必然超出这个窗口，需要手动补偿。
- CSS `!important` 会覆盖 Vue TransitionGroup 内联设置的 `transition`，需要用 `setProperty('important')` 反压。
- 探针（读取元素 class / computed style）比反复读代码猜时序有效得多——连续 2-3 轮猜不中就该换实测手段。

---
## 2026-07-16 · 文件浏览模块化：选择互斥规则收口

文件库和项目文件区原本各自实现“单选文件时清空文件夹选择、再次点击取消”的逻辑，项目文件区还单独实现了文件夹的 Ctrl/Cmd 切换。现将这些无副作用的集合操作收进 `useFileSelection`，页面仍保留预览、目录进入、框选和 Shift 范围等场景编排，因此没有改变卡片 DOM、样式、拖拽或缓存时序。补充了文件/文件夹互斥选择和重复点击取消的单元测试。

## 2026-07-16 · 文件浏览模块化：单文件删除与批量删除共用回收站边界

单文件删除原先仍在 `files.py` 路由中重复执行归属查询、物理移入回收站和 `deleted_at` 写入，现与批量删除一样收进 `services/files/selection.py`。路由仍负责 404 映射、事务提交和事件发布，软删除语义与回收站规则保持不变。

## 2026-07-16 · 文件浏览模块化：右键菜单内容统一、动作留在页面

文件库和项目文件区的右键菜单内容已收进 `FileBrowserContextMenuContent.vue`，通过能力 props 保留文件夹复制、删除分隔线和空白区操作等场景差异；菜单定位、关闭、缓存、剪贴板和 API 动作仍由页面负责，避免把回收站和项目范围规则塞入通用组件。

## 2026-07-16 · 文件浏览模块化：回收站单文件永久删除下沉

回收站单文件永久删除的归属查询、存储对象删除和数据库删除已收进 `services/files/trash.py`；路由仍负责 404 映射、事务提交、缩略图缓存清理和事件发布。文件夹整树永久删除、清空回收站和批量/文件夹恢复流程暂不合并，等待 devserver 端到端基线后再拆。

单文件和批量文件恢复也已沿用同一边界：service 负责归属查询、父目录仍在回收站的冲突判断和物理恢复，路由只把领域冲突映射为原有 HTTP 409，再负责提交和事件发布。文件夹恢复仍保持原路径。

已确认顶层回收站文件夹的整树永久删除也下沉到同一 service：顶层可删除单元的查询仍由路由负责，service 负责已删子树遍历、文件对象清理、目录物理清理并返回缩略图待清理 ID，避免把“哪些文件夹可删除”的 HTTP/权限判断复制进领域层。

清空当前用户回收站也复用该 service 边界：路由只查询顶层恢复单元并提交事务，service 统一清理文件对象、目录对象和物理存储，仍由路由负责缩略图缓存与事件发布；系统级过期清理暂不混入用户请求路径。

## 2026-07-16 · 文件浏览模块化：上传边界继续下沉但保留页面副作用

文件浏览重构继续按“展示 → 状态 → 操作 → 边界”推进。前端已统一文件库和项目文件区的基础选择 toggle、Shift 范围纯算法、文件操作 API facade，以及上传批次的冲突决策、跳过过滤、顶层文件夹 ghost 分组和生命周期执行；实际网络请求、缓存更新、失败回滚仍由页面回调保留。后端新增批量文件删除/下载服务边界，并把预签名上传的项目/文件夹校验、冲突 key 和配额准备、OSS 确认登记移到 `services/files/upload.py`，路由只负责 HTTP、事务/事件和 OSS URL。

本轮刻意没有把完整 `FileBrowserPanel`、文件夹卡片、ProjectModal 文件区或上传生命周期一次性合并：两边现有卡片 DOM、拖拽克隆、缩略图加载和缓存时序存在真实差异，继续强行抽象会把视觉/交互回归风险藏进通用组件。当前保留这些边界，作为后续需要手动验收后再决定的事项；详见 [【已完成】文件浏览系统模块化重构方案](docs/refactor/【已完成】文件浏览系统模块化重构方案.md)。

## 2026-07-15 · 抽屉↔画布拖拽收尾：连续几轮"改了又崩"最后靠录屏/trace/探针才收敛

项目卡在抽屉和画布之间来回拖拽，接连报了一串问题：抽屉里的虚线占位框会跳一下、画布卡拖回
抽屉时会变透明等一两秒才淡入、克隆飞行途中偶尔退化成缩小动画、揭示瞬间本体和克隆会短暂重叠。
每一版修复都基于读代码推理出的假设——"应该是这个时序""应该是这个 CSS 优先级"——结果连续三四轮
都是改了一个症状、暴露或引入另一个，纯靠猜完全没收敛。转折点是放弃继续读代码猜测，改用三种
实测手段：

1. **DevTools 性能录制（Performance trace）**：把 `traceEvents` 里的 `Animation`/`LayoutShift`
   事件按 `nodeId` 分组重放，直接看到真实的 DOM 位置变化和 class 组合——例如抓到离场卡片同时
   挂着 `leave-active` 和 `move` 两个 class（Vue 把一个正在离场的元素也一并当成"位置变了的兄弟"
   塞了内联 transform），以及真实的 `old_rect`/`new_rect` 证明"虚线框跳一下"是元素被摆到了
   `position:absolute` 容器的左上角，不是过渡时序问题。
2. **屏幕录像逐帧分析**（`ffmpeg -vf fps=30` 抽帧再挨个看）：肉眼读代码怎么也想不到"克隆消失后
   卡片会先变全透明、隔了近 3 秒才淡入"，而逐帧看录屏能直接确认"飞行全程屏幕上根本没有可见的
   飞行克隆"——这比对着日志猜"是不是揭示慢了"直接得多。
3. **console.log 探针**：在猜不出问题出在传输链路哪一环时，与其继续读三四层文件之间的 prop/emit
   透传代码找茬，不如直接在每一跳（子组件 emit 处、中间组件转发处、父组件监听处）各打一行日志，
   一次测试就能看出事件卡在哪一环——最后就是这样才发现 Vue 对已卸载组件实例的 `emit` 会静默
   失败（不报错、不转发），而不是我反复读了好几遍代码都没看出来的什么"传参漏了一个字段"。

这一轮最终揪出来的是四个各自独立、彼此无关的具体 bug（不是同一个根因的不同症状）：
- `_cloneLanding()` 摘"占位态 class"的清单里漏了会话中途新增的 `drawer-pending-absorb`，飞行
  克隆顶着占位态空壳飞了几百毫秒才在落地瞬间露出真身。
- `flyMorph()` 的 `trackCanvasCamera` 参数传的是 `targetEl !== sourceEl`——凡是落到新挂载的
  具体卡片这个条件就是 `true`，给根本不在画布世界坐标系里的抽屉卡克隆套了一层画布相机跟随
  变换，套错之后经常被挪到看不见的地方，表现为"卡片消失好几秒"。这个恒等式从很早就是错的，
  只是之前很少走到"落到新挂载节点"这条路径才没暴露。
- 直接改 `el.style.opacity` 会被元素自身的 CSS `transition` 接住变成一次可见的淡出/淡入，跟同时
  发生的克隆动画叠在一起就是"本体闪一下"——需要复用 `.phys-reveal-snap` 那套"临时关过渡、强制
  提交、再摘掉"的技巧才能让这类状态切换真正瞬间生效。
- Vue 对已卸载组件实例调用 `emit()` 会静默不转发给父级监听器（不报错、不警告），而这类"物理
  动画收尾时才触发"的回调，触发时对应的 Vue 组件往往早就因为数据更新被卸载了。最终改用直接
  下发函数引用（当 prop 传，而不是当 event 发）绕开整个 Vue 组件实例存活检查。

**教训：遇到"改了又崩、崩了又不对，连续三轮以上都靠读代码猜不中"的信号，应该立刻停止继续猜，
换成能拿到真实运行时数据的手段——性能录制看真实 DOM 事件、屏幕录像逐帧看真实视觉表现、
console.log 探针看真实调用链路，三者分别对应"布局/动画层""视觉呈现层""跨组件通信层"三种不同
的失效面，读代码静态推理在这三层都容易系统性想错。另外，Vue 组件卸载后 `emit()` 静默失效这个
坑值得记住：任何"异步回调触发时，发起该回调的组件可能已经因为同一次操作被卸载"的场景（乐观
更新导致源数据先消失、组件跟着卸载），都不能用 `emit` 通知父级，得用不依赖组件实例生命周期的
函数引用透传。**

**后续追加**：上面这轮修完之后又冒出两个问题：某个状态分组只剩最后一张卡被拖走时整块分组
瞬间消失（反过来创建新分组时也是瞬间蹦出来）——根因是 `drawer-project-groups` 这层
TransitionGroup 之前只写了 `-move` 过渡，没写 `-leave-active`/`-enter-active`，之前给单卡
（`drawer-project-cards`）补的处理漏了同步给外层分组。没有照抄"补一份 leave/enter 动画"了事，
而是从需求上把三个状态分组改成常驻渲染（不因为数量归零就整块增删），从结构上消掉了这个
过渡时机问题，副作用是外层 TransitionGroup 的 `-move` FLIP（其它分组跟着让位）也一并被摘掉，
得留着壳只用它的 `-move`。

另一个是画布卡拖回抽屉的落地飞行中途被重新抓起后没法再放回画布：`usePhysicsDrag.ts` 的
`delegateLandingRegrab`（把中途抓起的手势转手给落点本体自己接力）只在"抽屉拖出→画布"这一个
方向接了完整的收发两端（`ProjectDrawerCard.vue` 触发、`ProjectRefCard.vue` 监听
`physics-landing-regrab` 接力），反方向"画布拖回→抽屉"从一开始就没接——`delegateLandingRegrab`
是个可选 boolean，只接一半完全不报错、不 typecheck 失败，代码看起来是完整的，只有真跑到这条
交互路径才会发现转手落进没人接的地方。

**教训（追加）：双向交接类机制（A 能转手给 B，B 也应该能转手回 A）容易只实现单边**——可选参数
+ 两端分别在不同组件文件里实现，编译期完全看不出少了一半。新增或复用这类机制时，两个方向的
收发两端都要各自确认接了没有，不能默认"这机制是通用的，另一边大概率也接了"。

## 2026-07-14 · 咕咕几乎写不进笔记：blocks 参数在结构化输出层系统性退化

咕咕的 `create_note`/`update_note` 工具报"content 必须是行内内容数组"，怎么换内容、换块类型都是
同一句错。一开始怀疑是 `reference` 块单独有问题，逐项二分排查（去掉 marks、去掉混排、单条
reference）都复现同一个错——但这条排查路径本身走错了：咕咕对自己"发过什么参数"的复述是靠事后
重新组织语言编出来的，不是真的读到了自己吐出的原始字节，越排查越对不上。改用探针（在
`serialize_mind_blocks` 失败的 `except` 分支里打一行原始 `blocks` 参数的日志）后，第一眼就看穿了：
真实发送的 `content` 是 `{"item": {"text": "hello", "type": "text"}}`，不是一个数组，而是被套了一层
通用兜底包装。

根因是 `blocks` 字段的 JSON Schema 只声明了 `"type": "array"`，没有 `items` 子模式——嵌套结构全靠
`description` 文字描述。模型的结构化参数生成一旦遇到没有形状提示的数组/对象，就会退化成训练里
学到的某种通用兜底：该是数组的地方包一层 `{"item": 值}`，无 schema 的对象整个被 `JSON.stringify`
塞进 `{"$text": "..."}`。这跟传了什么内容完全无关，是 schema 层缺失导致的系统性问题，之前只在
description 里补例子完全没用——description 对提示词有帮助，但管不住结构化输出这层的生成约束。

补齐两层完整 schema（行内内容 `_INLINE_ITEM_SCHEMA` + 8 种块类型 `_BLOCK_ITEM_SCHEMA`）后，`content`
（`paragraph`/`heading`/`task_list` 用）不再被包装，但 `bullet_list.items`/`blockquote.paragraphs`
（"数组的数组"两层裸嵌套）依旧退化——不管 schema 写多完整，两层嵌套数组这个形状本身，这个模型的
结构化输出就是生成不稳定。改成跟 `task_list` 同构的"一层数组 + 对象包 content"（`items:
[{"content":[...]}, ...]`）后才彻底稳定。中间还踩了第三个坑：给 `items` 用 `anyOf` 区分"纯 content
项"和"带 checked 的 task 项"，结果模型面对两个 object 分支的选择歧义，直接吐空对象 `{}`——干脆合并
成一个扁平形状（`checked` 设为可选字段），服务端校验层继续按 block 类型强制 `task_list` 必须带
`checked`，两边分工不冲突。

**教训：JSON Schema 里的 `items`/`properties` 不是可选的文档，是结构化输出的硬约束依据；只写
`description` 文字说明，模型看得懂但生成时用不上。排查这类"看起来每次都错在不同地方"的 bug，第一
反应该是怀疑"复述是不是真的"——模型对自己已发送参数的转述不可靠，直接在失败路径打一行原始参数
日志，比反复靠对话里的二分法猜测快得多。且这类"结构化输出在无约束时退化"的具体行为（包一层
`{"item":...}`、两层嵌套数组不稳定、`anyOf` 分支歧义吐空对象）没有任何官方文档说明，纯粹是黑盒实测
摸出来的，换一个模型/推理框架未必是同样的退化模式。**

---

## 2026-07-14 · 抽屉项目卡落地交接：可见克隆与节点身份必须连续

项目从画布右侧抽屉拖入画布后，首次落地动画尚未结束时再次抓取，卡片有时会立刻跳到鼠标下；
服务端回写后的第二次拖拽又可能直接瞬移到最终落点。问题并不在物理参数，而在两段交接各自
读了不同的“卡片”。

落地画面实际由第二个视觉克隆 `clone2` 绘制，但旧逻辑重抓时量的是物理 holder；普通画布卡
两者尺寸相近而不易暴露，抽屉项目卡却会经历“抽屉实体尺寸 → 画布缩放尺寸”，两份矩形不再
相同。重抓起点改为优先读取可见的 `clone2`，仅在它失效时才回退 holder，因此新的物理手势
从用户眼前的卡片续上。

另一处是乐观创建的画布项目：服务端首次回写若直接整体替换本地项，会丢掉仅前端使用的
`clientKey`，Vue 的 key 会从临时身份突然换成真实 id，正在播放的落地克隆被重挂载切断。回填
服务端字段时保留 `clientKey`，使首次落库、连续抓取与后续移动始终指向同一个节点。

**教训：物理动画的交接对象必须是当前可见对象，乐观节点的前端身份必须跨服务端回写保持稳定。**
抽屉拖入属于“新节点出现”，需要临时节点和落地交接；项目看板与文件库移动已有卡片，沿用本地
先更新、失败回滚的乐观更新即可，不应再叠一层占位动画。

---

## 2026-07-14 · 写后复查慢：多等了一次没有新信息的模型回合

咕咕此前执行写工具后，不会立刻进入复查。它会先再请求一次模型生成“已完成”的收尾文本，
核心循环才注入复查提示；模型随后再选择查询工具，查询完成后还要生成一次收尾。这使普通的
项目、日历、文件或笔记修改至少多出一次没有新信息的模型往返，网页上便表现为写入后长时间
停在“复查”。

改为把成功工具结果回灌进上下文后立刻追加复查提示：下一轮直接查询，读回后的最终确认才展示。
工具结果明确带 `error` 时不进入复查，避免失败操作额外等待；`mind_get` / `mind_search` 加入有效
读取集合，修复思维笔记已经读回却仍被反复要求复查的问题。核心循环的 Anthropic/OpenAI 双路特征
测试补齐即时复查、失败写入和思维读取场景，本地及 devserver 均通过 18 项。

这次是时序优化，不把模型自主查询伪装成确定性校验：运行时仍未校验查询是否对应刚写入的目标。
后续若实施完整 Execution Verifier，应让成功写入产生 mutation receipt，再由服务端直接读回同一
资源并核对预期字段；外部瞬时动作则以平台回执为边界。

---

## 2026-07-13 · 活动引用先弹“加载中”：显示状态早于数据就绪

思维面板中点击日历活动引用时，全局 `EventEditModal` 收到活动 id 就立刻显示；组件随后才
请求活动详情并加载提醒，因此用户会先看到一个短暂的“加载中”空弹窗，再看到真正的编辑表单。
项目页的已归档弹窗曾出现同类体验问题，后来通过预取避免了可见加载态。

这次活动编辑弹窗改为以“活动 id 已指定且编辑数据已准备好”作为入场条件：先取活动详情、
初始化提醒表单，最后才写入 `event` 并打开 `BaseModal`。同时给请求加序号，快速连续点击不同
活动时，较早返回的请求不能覆盖最新目标；关闭期间返回的响应也会被丢弃。

**教训：弹窗的可见性不应只代表“开始加载”，而应代表“用户能开始操作”。** 对没有必要展示
独立 loading UI 的轻量编辑窗口，数据准备完成后再入场，比先开空壳再替换内容更稳定。

---

## 2026-07-13 · 画布此前会把无限空间里的所有卡片都挂进 DOM

画布虽有无限坐标系和相机平移/缩放，但此前 `MindCanvas` 直接对完整 `items` 做 `v-for`，
`RelationLayer` 也会对完整关系集生成 SVG path。卡片数量少时没有问题；节点和连线增多后，即使
大部分内容已经在视口外，DOM、`ResizeObserver` 和关系路径计算仍会持续参与响应式更新，拖动一张
卡片也会放大为全量关系重算。

修复在前端渲染层引入窗口化：按相机反推世界坐标中的视口范围，再额外扩 420px 的**屏幕像素**缓冲
（按当前缩放倍率换算，缩放前后缓冲体感一致）。只有与该范围相交的贴纸会挂载；关系线仅在两个端点
至少一端位于窗口内时计算和渲染：可见贴纸的线会继续伸向窗口外的远端节点，但远端贴纸本身不会
重新挂载。完整 items 不会被删掉，拖拽落点、连线命中、持久化和画布切换仍以完整数据集为准。首次
挂载尚未取得 DOM 尺寸时保守地完整渲染一帧，避免首屏被误判为空。

新增纯几何单测，覆盖屏幕缓冲到世界坐标的换算和边界相交判断；普通与 strict 前端类型检查均通过。
这只是客户端窗口化，不是后端分页：当前仍会一次性拉取单张画布的全部 items/relations，未来超大
画布再按实际规模补服务端视口查询或分页。

---

## 2026-07-13 · 思维入口和画布相机都没有完整收尾保存

侧栏始终链接到 `/mind`，路由过去固定重定向到笔记；用户即使刚在画布里工作，再从别的页面
回来也会被带回笔记。画布相机虽然已有 500ms 防抖保存到画布 `data`，但最后一次移动后立刻
切页、切换画布或点击重置时，定时器可能来不及执行；窗口尺寸变化还会调用旧的 `onResize()`
强制重新居中，直接覆盖用户正在看的位置。另有一个同会话恢复漏洞：store 跨路由保留
`activeCanvasId`，但重新进入时 `MindCanvas` 是新的组件、相机从 `scale=1` 开始；旧代码把
“当前 id 已加载”误当成“当前组件已恢复”，直接跳过 `restoreView()`，于是每次回来都是 100%。

修复分成两层：浏览器本地只记“最后停在笔记还是画布”以及最后画布 id，`/mind` 据此重定向；
具体的相机 `x/y/scale` 仍保存在对应画布的服务端 `data`，不把可跨设备恢复的状态降级成仅本地。
相机保存保留防抖，但切换路由、切画布、组件卸载会主动冲刷待保存值；工具栏重置和自动居中也
通过同一条 `viewChange` 管线写回。每次 `MindCanvas` 挂载都会恢复视角，网络加载仍只在画布 id
变化时发生。移除了 resize 时无条件居中的行为，窗口大小变化不再抹掉用户的浏览位置。

**教训：防抖保存不是持久化策略的全部。** 任何能结束当前交互上下文的路径（离开、切换、卸载）
都必须显式 flush；“适应窗口大小”也不能默认等同于“重置用户相机”。

---

## 2026-07-13 · 不可逆操作的“二次确认”只验布尔值，模型可一步绕过

回收站里的两份短文先被普通删除移入回收站；用户随后说“彻底删除”，咕咕直接清空了回收站，没有先展示会永久删除的数量并等待下一轮确认。工具本身并未漏标：`permanent_delete` 是 `destructive=True`，handler 也调用了 `confirm.needs_confirmation()`；项目、活动、客户和定时任务同样如此。

真正的漏洞在确认门的语义。旧实现只要本次工具参数中有 `confirm=true` 就放行，模型可以把用户的第一句删除意图直接翻译成这个字段。提示词要求“先询问”，但服务端没有任何证据证明影响范围曾经展示给用户，因此所谓二次确认仍可被单轮模型调用绕过。

修复把确认改为短时、签名的确认凭证：首次调用只返回影响摘要和五分钟有效的 `confirm_token`；后续只有同时携带 `confirm=true`、该凭证、同一用户和同一份影响摘要才会执行。对象在确认期间变化（例如回收站数量改变）会使摘要不匹配，必须重新展示影响并确认。凭证由服务端密钥签名，模型无法凭空构造；仅写 `confirm=true` 会再次返回确认拦截。

这套规则统一接入项目、日历活动、客户、定时任务和回收站永久删除，并更新工具 schema 与 agent 操作提示。新增回归覆盖“直接 `confirm=true` 必须拒绝”和“携带上一轮凭证才执行”；确认门测试、跨用户工具测试、确认门静态守卫与归属守卫全部通过。

**教训：确认按钮/布尔参数不是确认流程。** 对不可逆操作，服务端必须验证“本次执行”与“上一轮已展示的具体影响范围”之间存在可校验的关联；仅靠模型遵守提示词，等于把安全边界交给概率。

---

## 2026-07-13 · 拖拽克隆文字变模糊和换行：不是 3D，也不是尺寸，真正丢的是字体继承

画布便签、项目卡和文件卡的物理拖拽一直有一个很顽固的落地跳变：拖起来的克隆文字比本体略模糊，长一点的单行文字会提前折成两行；松手回到本体时，卡片内容像突然换了一次排版。卡片外框的宽高和 3D 抬起效果看上去都正确，因此一度怀疑是 `perspective`、缩放壳或浏览器子像素渲染造成的。

最终用源卡与克隆的实际布局数据对比才把范围缩到字体：两者的视觉外框、`clientWidth` 和缩放比例一致，但源卡继承的是 `"PingFang SC"` 字体栈，克隆却继承了 `body` 的 `Inter` 字体栈；同一段数字文本的真实行宽因此不同，克隆先换行，抗锯齿也随字体变化。物理克隆一直 append 到 `body`，这正好切断了源卡在项目页/画布容器里获得的继承性排版属性。此前看到的 `scrollWidth` 差异只是连接点溢出带来的旁支，不是根因。

修复集中在 `usePhysicsDrag.ts`：新增一处受控的字体继承复制，并在单卡主克隆、落地克隆、多选主卡和影子卡创建时统一调用。只带走会影响字形与字距的字体栈、kerning、字体特性、字距和文本渲染属性；第一次把 `line-height` 等全部继承属性也复制过去，反而覆盖了项目卡子元素的继承关系，造成每行间距变大、克隆变高，因此没有保留那种粗暴做法。3D 后仰效果和缩放壳继续保留，问题与它们无关。

**教训：`cloneNode` 后移到 `body` 不是纯粹的定位操作，它会改变整条 CSS 继承链。** 排查「同尺寸却换行不同」时，应先直接比较 clone 与 source 的 `font-family` 和文本实际宽度；先调缩放、变换或像素对齐，只会在错误层级里打转。定位完成后也应及时撤掉布局探针，避免把拖拽热路径的临时日志带进常驻代码。

---

## 2026-07-12 · Canvas 项目卡 `pr-wrap`：四套盒模型各算各的，连线和拖拽永远对不齐

画布上的项目引用卡连续出现了几个看似无关的问题：连接线左端比圆点低、项目卡抓取后鼠标位置比卡片中心高、卡片底部被撑出一大片空白、缩放后连线又会相对卡片上下漂移。文件卡没有同样的问题，导致排查一度怀疑是项目卡组件本身的 CSS。

真正根因是 `ProjectRefCard.vue` 多包了一层 `pr-wrap`。这层外壳按画布默认尺寸是 `240×120`，但里面的 `ProjectCard` 是按内容自然撑开的，实际常见高度约 `96px`。此前有意让内卡 `height: 100%`，但外壳只有 `min-height`、没有可解析的确定高度，百分比高度不会生效；于是视觉上的卡体、连线几何、拖拽落点换算和 physics 克隆先后读到了不同尺寸。为了“对齐”而继续增改高度常数，只会在短文案、长文案、缩放和缺失态之间反复制造新偏差。

修复不再让 `pr-wrap` 充当正常项目卡的布局外壳：画布直接定位 `ProjectCard` 的真实根节点，物理拖拽也克隆这张真实卡，而不是克隆一个尺寸不同的透明容器。`ProjectCard` 通过 `defineExpose({ rootEl })` 提供根元素；由于它同时有 Teleport，必须显式转发 `$attrs`，否则 Vue 会把外部 class/style/listener 视为多根组件属性而丢在注释锚点上。项目/文件卡用 `ResizeObserver` 上报实际世界尺寸，`RelationLayer` 只在运行时拿这份测量值定位端点，不把内容高度反写为持久化画布数据。连接点需要露在卡片边缘外，因此卡根在 canvas 模式下允许 `overflow: visible`，内部需要裁切的缩略图仍由自己的子区域处理。

**教训：画布里“卡片大小”必须有唯一的视觉事实来源。** 默认尺寸可以用来首次摆放和没有 DOM 时兜底；一旦组件允许自然高度，连线、拖拽命中、落点换算和克隆体都必须读取同一个真实根元素。用额外 wrapper 硬凑坐标，看似隔离组件，实际上会引入第二套盒模型，越修越难收敛。

---

## 2026-07-11 · 咕咕回复结尾冒出 `[e~[`：探针放错路径追了大半天，真身是 MiniMax 尾标记

用户反馈：咕咕说话偶尔会以 `[e~[` 这几个字符结尾，尤其是带代码块的回复之后。看着简单，实际排查绕了好几圈——**每一圈的误判都栽在"没先确认探针真的挂在了会执行的那条路径上"**。

**第一层误判：以为是前端渲染问题。** 用户说"这次没有空格""结尾空格"，咕咕自己也把 `[e~[` 认成"空格"，一度以为是某个不可见字符被前端转义/渲染成了 `[e~[`。查了 `GuguChat.vue` 的流式 token 拼接（`text += evt.content`）、`_revealMessage` 的逐字 slice、marked 渲染管线、Debug 面板的日志展示——全都只是**透传**，没有任何地方会凭空生成或转换字符。这条线索排查完，结论应该是"前端干净，问题在后端数据里"，但**当时没有立刻确定下来**，又在"是不是尾随空格"这个假设上来回绕了几轮。

**第二层误判：探针加了却一直不响，一度怀疑判断方向错了。** 在 `agent/sanitize.py` 加了 `probe_leak_tail`，先后三版：只匹配「结尾是 `[`」→ 不响；扩大到匹配任意 Unicode 控制/格式字符 → 不响；再扩大到「任意尾随空白（含普通空格）」→ **还是不响**。每次不响都会怀疑"是不是判断条件又不对"，但真正的原因始终是同一个、更底层的问题：**探针被加在了 `agent/runner.py` 的 `run_stream`/`run_collect`/`run_ephemeral` 三个函数里，而网页 `/chat` 端点实际走的是 `agent/gateway/web.py::_generate`**——这是一条完全独立的后台任务路径，有自己的 `full_reply` 组装和落库逻辑，跟 runner.py 那几个函数毫无关系。探针挂错文件，加多少版、改多严都不可能触发。

**捅破这层之后，才是真正卡住的地方：探针补到 `web.py` 后，还是隔了两次「重启时间差」才对上一次真实复现。** 每次让用户复现，探针代码虽然在磁盘上改好了，但后端进程还没重启、或者复现发生在重启完成前几秒——`ps -o lstart` 查进程启动时间、`stat` 查文件改动时间，两两对比才确认"这次复现在重启之前，探针没生效"。这提醒了一件容易漏想的事：**改探针代码 ≠ 探针生效，中间隔着一次进程重启，验证时一定要先比对时间戳，不能假设"我改了就该响"。**

**真正的根因，最后是靠读原始流式日志、而不是靠探针拿到的。** 直接查生产 `gugu.log` 里 `[agent.traj]` 记录，在带 `[e~[` 的一次生成里找到了确切的十六进制片段：`0a 60 60 60 5b 65 7e 5b 0a`，解码正是「换行 + 代码围栏 `  CASEPROTECT4 bash
ps aux --sort=-%cpu | head        # CPU 谁占满
free -h                            # 内存
journalctl -u gugu-backend -n 40   # 有没有崩/被杀
 CASEPROTECT5 
网关(qq/feishu) 收消息 → 入队 ──→ worker 消费 → run_collect(大脑) → 发回 + publish事件
   ↑ gateway 管这些                  ↑ 这个进程我从没重启过
 CASEPROTECT6 
工具成功 → events.publish(user_id, 资源)  →  Redis PUBLISH events:{user_id}
                                          →  SSE /live/stream（前端 fetch streaming 订阅）
                                          →  bump rev[资源] → store/视图 watch 重新拉
 CASEPROTECT7 
[qq:3] 收到 BBFF2AB9...: 'hello'
[worker] qqbot 回复 → 'hey～今天有什么要推进的…'
 CASEPROTECT8 
飞书私聊消息
  → 网关 gateway/feishu.py（lark-oapi WebSocket 长连，收 im.message.receive_v1）
  → produce_sync 入队 Redis Streams（im:inbound）
  → worker.py 独立进程 consume
  → run_collect(AgentRequest)：复用 loaders/builder/core/sanitize，攒完整回复（人格+记忆+41工具）
  → feishu.send_text（lark.Client im.v1.message.create）发回飞书
 CASEPROTECT9 text
duration = clamp(abs(targetHeight - currentHeight) / speed, 200, 350)
 CASEPROTECT10 
[vite:vue] <template v-for> key should be placed on the <template> tag.
```

Vue 3 编译器明确禁止在 `<template v-for>` 的子元素上放 `:key`——key 必须挂在 `<template>` 标签上。但要让外层 TransitionGroup 区分开 button 和 TransitionGroup 做 FLIP，就得让它们都是 TransitionGroup 的直接子项、各自带稳定 key，`<template v-for>` 这种结构天然冲突。

另一个绕路是「同元素 v-for + v-if 过滤」，但 v-for 优先级低于 v-if，v-if 拿不到 v-for 变量，模板里写不出来。

**最终方案**：拆成 4 个独立 v-for，每个 v-for 的源数据是已过滤的 computed——把「过滤」挪到 computed 里，模板里 v-for 拿到的就是已经过滤好的列表。

| v-for 源 | 渲染什么 | key 模板 |
|---|---|---|
| `groupedByYear` | 所有年份的 year-row button | `year-row-${yg.year}` |
| `openYearsList`（按 `openYears` 过滤） | 已展开年份的 year-body TransitionGroup | `year-body-${yg.year}` |
| `yg.months`（在 openYearsList 内层） | 展开年内所有月份的 month-row button | `month-row-${yg.year+mg.month}` |
| `openMonthList(yg)`（按 `openMonths` 过滤） | 双层展开的 month-cards TransitionGroup | `month-cards-${yg.year+mg.month}` |

未展开的 year-body 完全不挂载，未展开月份的 month-cards 完全不挂载，保留原版「按需挂载」性能——`openYearsList` / `openMonthList` 是 computed，`openYears` / `openMonths` 变化时自动重算，Vue 拿到的是稳定引用。

「未设置日期」区按同款思路拆：year-row 始终渲染（`v-if="undatedProjects.length"` 控制可见性），卡片组用 `v-if="undatedProjects.length && openYears.has('__undated')"` 控制挂载。

### CSS 跟着改

`.year-group` / `.month-group` 包装层没了，原本挂在它们身上的 `margin-bottom` 失效（这俩选择器现在匹配不到任何东西）。间距挪到 `.year-row:not(:last-child) { margin-bottom: 4px }` 和 `.month-row:not(:last-child) { margin-bottom: 1px }` 上，等价于原 wrapper 提供的视觉间距。

### 教训

**先实测再改模板结构**：Vue 3 对 `<template v-for>` 的 `:key` 位置、v-for / v-if 优先级、TransitionGroup 子元素要求都有硬约束，肉眼「看着对」不代表编译器放过。下次改 Vue 模板结构前先在 devserver / `vite build` 上过一遍编译，比反复改模板试错快得多。

### 验证

- `npx vite build` 通过（编译报错是先发现再修的，不是产品问题）。
- HMR 行为待用户桌面端手测：①抽屉项目卡拖入/拖出时分组标题是否平滑让位；②已完成列年内/年内月间卡片增减时折叠按钮是否平滑让位；③跨年/跨月让位时整组（按钮 + 卡片）是否同步平移。

## 2026-07-16 · 画布项目拖回抽屉时的延迟让位

### 现象

把画布项目拖回已打开的项目抽屉，且目标卡位在当前视野上方、需要向上滚动时，飞入的 clone2 会先与原先第一张可见卡重叠；直到 clone2 收尾，后续卡片才向下让出一张卡的空间。向下滚动不明显。

### 排查结果

probe 证明 `canvasItems.splice()` 后约 1ms 内，`canvasProjectIds` 与 `filteredProjects` 已完成更新；不是接口或 Vue 响应式更新延迟。

问题在于抽屉的两层 `TransitionGroup` 正在执行 `.42s` FLIP 时，`getBoundingClientRect()` 返回的是带 transform 的视觉中间位置。落地逻辑把它当作滚动和 clone2 的终点，等 FLIP 结束后真实布局与初始快照相差约一张卡高度。

曾尝试在 clone2 揭示前用 `scrollTop` 强制校正；这会让整列内容在收尾瞬间跳动。后续尝试把校正放到飞行中段并每帧 retarget clone2，性能 trace 显示每帧都会重置落地完成计时，飞行被延长，虽然让位改成了动画，仍是事后补偿。

### 修复

在 `interaction/dom.ts` 增加 `layoutBoxInScroller()`：沿目标与滚动容器各自的 `offsetParent` 链累计 `offsetTop` / `offsetLeft`，推导不受 FLIP transform 影响的最终布局盒。抽屉吸入路径从第一帧便用这份布局盒计算滚动终点和 clone2 飞行终点，删除延迟校正与其逐帧 retarget。

### 教训

**动画期间的 `getBoundingClientRect()` 是视觉坐标，不等于布局坐标。** 若终点由 FLIP 中的元素决定，应先拿 transform-free 的布局位置，而不是在动画结束后再让滚动容器补偿；后者会把布局误差转化成用户可见的整列跳动。

### 验证

- `npm run typecheck` 通过。
- 用户手测确认：目标在当前视野上方、抽屉需要向上滚动的回收路径已恢复正常。
## 2026-07-15 · 文件浏览系统渐进式模块化

本轮重构没有直接替换成一个全能 `FileBrowserPanel`，而是按展示、状态、操作和后端边界逐步抽取。`FileBrowserGrid/List/Breadcrumb/ContextMenu` 只承担展示壳，`useFileSelection`、`useFolderNavigation`、`useFileProjection` 和 `useFileActions` 不直接维护页面缓存或 UI 状态。

文件库和项目文件区继续分别负责乐观更新、版本冲突、回滚、ghost 生命周期、项目范围和回收站差异。后端新增的 `services/files/*` 目前只接收响应组装、查询构造、上传冲突/文件名解析和预览转换等低风险边界；鉴权、事务、存储归属、删除和回收站语义仍保留在原有边界。

这条边界是有意保留的兼容策略：文件卡片 DOM、拖拽克隆、缩略图时序和项目文件归属都曾出现过高风险回归，不能仅凭 typecheck 证明安全。完整 `ProjectModal` 区域拆分和后端写操作 service 化需要 devserver 端到端验收后再继续。

## 2026-07-16 · 文件浏览选择范围下沉

文件库与项目文件区原本都各自完成 Shift 范围计算，再把文件和文件夹集合写回响应式状态。本次将“范围解析 + 混合选中集合替换”收进 `useFileSelection`，两个页面只保留可见项目列表、框选 DOM 和锚点生命周期编排；没有改变选择模式、快捷键或框选行为。

框选暂不继续抽象：它依赖页面容器、数据属性和回收站特殊前缀，继续下沉会把页面 DOM 约定带进通用 composable，反而扩大边界。前端测试现为 18 个文件、200 个用例全部通过，typecheck 通过。

## 2026-07-16 · 文件服务迁移后的旧 helper 引用

把响应组装、缩略图和预览逻辑下沉后，隔离运行当前分支的后端全量测试时发现旧调用方仍从 `app.api.v1.files` 导入已删除的 `_to_resp`、`_color`、`_delete_thumb_cache`、`_thumb_dir` 等符号，导致测试收集阶段失败。问题不在业务逻辑，而是迁移边界没有完成调用方收口。

现已将回收站、Agent 文件/回收站工具、账户注销、应用启动清理和 Agent 预览接口统一改为依赖 `services/files/{response,previews}.py`；同时修正 `FileService.move_folder` 直接传入 `target_project_id` 时未识别为显式目标项目的问题。当前分支在 devserver 临时隔离副本中后端全量测试通过，原 devserver 工作树未被覆盖。

同一轮继续把批量上传冲突检查从 `files.py` 下沉到 `services/files/upload.py`；路由仍负责 Pydantic 请求解析和响应投影，上传协议、冲突判断和返回结构保持不变。

## 2026-07-16 · ProjectModal 面板拆分：InfoPanel / StagesPanel 抽取收尾

阶段 6 的剩余工作：抽取 `ProjectInfoPanel`、`ProjectStagesPanel` 和对应的 composable。

`ProjectInfoPanel.vue` 承担项目名称、状态、颜色、日期、客户编辑，`ProjectInfoPanel.vue` 承担阶段展示、排序、编辑和待办增删改查。`useProjectDraft` 统一管理草稿脏状态和保存/取消，`useProjectStages` 提供阶段/待办操作的编排函数。

### 踩坑

1. **`saveTodos` 回调缺失**：`ProjectStagesPanel` 通过 `onSaveTodos` prop 调用父级的保存函数，但抽取时 `ProjectModal` 中没有定义 `saveTodos` 函数，导致待办保存静默失败。补上 `saveTodos` 函数，调用 `projectStore.saveTodos` 并传入进度参数。

2. **CSS 样式未迁移**：`ProjectStagesPanel.vue` 只有 template 和 script，缺少 `<style scoped>` 块。原有的阶段/待办 CSS 全部留在了 `ProjectModal.vue` 中。将样式从 `ProjectModal` 迁移到 `ProjectStagesPanel` 后恢复正常。

3. **文件末尾残留生成标记**：`ProjectStagesPanel.vue` 末尾残留了 `</VUEEOF` 和 `echo "ProjectStagesPanel.vue created"` 两行无效代码，导致 Vue 编译器报 `Invalid end tag`。

### 当前状态

- `ProjectModal.vue` 从 ~2900 行降到 2264 行
- `ProjectStagesPanel.vue` 314 行（含阶段展示、拖拽排序、待办编辑、待办跨阶段拖拽）
- `ProjectInfoPanel.vue` 约 120 行
- 后端 `upload.py` 进度编排状态确认已完成，更新方案文档

## 2026-08-03 · 文件库入口非手测收口审计

### 审计范围

针对文件库模块化重构的 9.5 收尾，检查 `views/Files/index.vue` 是否仍重复实现通用能力，并核对页面级组件与文件能力 composable 的边界。

### 结果

- 存储统计已由 `useFileStorageUsage` 负责。
- 文件夹图标、强调色和展示映射已由 `useFileLibraryFolderPresentation` 负责。
- 文件夹创建、下载、删除已由 `useFileLibraryFolderActions` 负责。
- 单文件下载、删除已由 `useFileLibraryFileActions` 负责。
- 拖拽目标解析、重命名、右键菜单、回收站动作转发和键盘快捷键仍依赖文件库页面上下文，保留在入口作为适配层，没有发现重复的通用实现。
- 清理了入口内未使用的重复选择函数。

### 验证

前端 `typecheck`、`typecheck:strict`、Vitest（26 个测试文件 / 246 passed）和 `git diff --check` 均通过；文件库 Playwright 冒烟此前已在 devserver 验证为 10 passed、1 skipped。剩余工作是 devserver 浏览器手测，不属于静态收口审计范围。

## 2026-08-05 · PR #7 合并前安全审查收尾

### 本轮复审

- OSS 直传确认使用服务端 HEAD 的真实大小和 MIME，在用户行锁之后重新计算配额；回归覆盖虚假客户端大小、单文件超限、覆盖配额和锁语句顺序。
- Redis shortcut 读取失败时继续走完整 worker；QQ、飞书入口均有回归测试证明消息仍会进入 Stream，取消状态写入失败只记录告警。
- 定时任务将数据库目标保存为 `target_map`，把提示词展示文本单独命名为 `target_description`，并测试完整执行到群聊/私聊投递的目标不串。
- IM 媒体下载使用流式读取，限制单附件 50MB、单消息总量 100MB，并在连接层复核 DNS 结果；URL 安全测试覆盖重定向内网、混合 DNS 和 IPv4-mapped IPv6。
- 定时任务异常日志改为受限诊断出口和脱敏摘要，不再把原始异常文本写入可见日志或执行结果。

### 验证结果

- 后端：`644 passed`，ownership/confirmation guard 通过，Python compileall 通过。
- 前端：typecheck、strict typecheck、246 个 Vitest 测试和 build 全部通过；build 仅保留既有 chunk/import 警告。
- 迁移：在临时 PostgreSQL 上从项目的现有 schema 基线 `20260804000002` 升级至 `20260804000007`，执行一次 downgrade 到 `20260804000006` 后再次 upgrade，最终为 head。
- 空 PostgreSQL 可直接执行 `alembic upgrade head`：`alembic/env.py` 检测真正空库后用当前 metadata 建立基础表并写入当前 head；已有业务表则仍走正常 revision 链，不会被误判为空库。临时 PostgreSQL 18 空库实测建出 31 张表，版本为 `20260804000007`。
- devserver 工作树存在其他未归属改动，未在其目录执行迁移。通过只读 `pg_dump --schema-only` 获取远端生产结构副本，在本地 PostgreSQL 18 临时库中从 head 回退到 `20260804000002`，再升级到 `20260804000007`，最终 head 验证通过；未修改远端数据库。
- 真实 OSS 对象和人工 IM 交互仍需部署后手测，不能由本地单测替代。

### 复审收尾补充

- 清理了上传服务的导入顺序问题，保持项目统一的标准库导入规范。
- 复审时发现并修复 OSS confirm 新建文件分支遗漏实际配额复核的问题，新增“已有占用 + 新对象真实大小”回归测试；覆盖分支原有的替换配额检查保持不变。
- 在临时 PostgreSQL 18 中执行真实双会话并发 confirm，结果为一条成功、一条配额拒绝，总占用保持 `95`，证明用户行锁和服务端配额复核生效。
- 生产结构副本迁移复核命令输出：`production_schema_copy_downgrade_upgrade_ok`，最终版本 `20260804000007`。
- 迁移补充复核：已有业务表路径先 stamp head，再 downgrade 到 `20260804000002` 并 upgrade 回 head，最终版本仍为 `20260804000007`；bootstrap 路径确认提交事务，避免连接关闭时回滚建表结果。
- 总体清理：移除已完成排查的 QQ 表情前端探针和文件拖拽临时 `debugLabel`，未保留调试输出或无调用的探针模块。

## 2026-08-10 · 日历模块化 Phase 3/5 收尾

- 日历页面的持久化活动编辑统一接入全局 `EventEditModal` 与 `eventModal` store；页面内只保留带定位的新建活动表单，删除了重复的编辑状态、定位、保存和删除逻辑。
- 从“更多”活动菜单打开编辑时先关闭菜单，避免页面捕获点击与全局弹窗状态互相干扰；活动保存、删除和提醒更新继续通过 `liveStore` 触发日历刷新。
- `MonthGrid`、`WeekTimeline` 已成为月/周视图的样式边界，清理父页面迁移后遗留的周视图重复 CSS，避免以后修改出现双份样式来源。
- 日历 Playwright 用例加入 runtime integration CI，并在 devserver 实际验证月视图、周视图及其切换；全量前端测试、普通/严格 typecheck 均通过。

## 2026-08-21 · Prompt 缓存断点验证

- OpenAI 兼容路径接入 conversation 末尾缓存断点后，Qwen 连续三轮测试的后两轮缓存命中率达到 98%+。
- Kimi 多数轮次达到 94%+，偶发低命中随后自动恢复，暂未发现业务侧组装异常。
- 将“Session baseline 与 conversation 分段缓存”记录为后续可选方案，待确认多断点兼容性和实际收益后再实施。

## 2026-08-24 · History 完整性审计：引用修复后的下一处边界

### 背景

近期修复了 IM 引用消息在下一轮 History 中丢失的问题：引用正文继续单独保存在
`ConversationMessage.quoted_text`，模型侧通过稳定的引用上下文前缀恢复，网页展示仍使用原始
`content`，避免把引用正文直接拼进聊天气泡。

### 审计结论

对照 `ConversationMessage` 持久化字段、Web/IM runner、History builder 和 Provider adapter 后，
发现当前轮模型输入与后续 History 仍有一处重要差异：附件解析结果只存在当前轮的 `aug_text`。
消息落库时保存的是原始用户正文和附件卡片；下一轮 History 只恢复图片附件的轻量 `attach_id` 引用，
不会恢复文本文件解析内容、语音转写结果或普通文件附件的稳定存在信息。

因此当前策略表现为：

- 图片：保留 `attach_id`，不重复写入 base64，模型需要时可再次读取；
- 文本/文档附件：当前轮可以注入解析正文，后续 History 不再看到解析结果；
- 语音：当前轮可以使用转写文本，后续 History 不再看到该转写文本；
- thinking/reasoning：Provider 切换时主动清除，属于兼容策略，不是意外丢失；
- UI-only 交互状态：保存在交互表和前端事件中，不作为模型历史，属于正确隔离；
- 工具调用、工具结果、Skill/Tool Schema、RAG：已使用 canonical block 保存，再由 Provider adapter 转换。

### 规范方向

现有 `canonicalize_tool_messages()` 只覆盖工具及上下文事件，不能完整表达普通消息、引用、附件、
发言人和时间。后续应建立统一 History Contract，并在持久化边界做一次归一化：

1. 原始正文保持不可变，用于网页/IM 展示；
2. 模型上下文使用 canonical blocks 表达文本、引用、附件引用、转写文本、工具事件和 RAG；
3. Provider adapter 只负责把 canonical history 转换成各自 wire format；
4. 明确省略策略：不持久化 base64、供应商 thinking 签名和 UI-only 状态；
5. 未知 block 必须有统一的保留或文本化规则，不能由 OpenAI/Anthropic 路径分别决定；
6. 为 Web、QQ、微信、飞书及 OpenAI/Anthropic 建立同一组 History 完整性回归测试。

### 当前状态

引用恢复已补充跨平台测试并通过。附件上下文持久化和完整 History 归一化暂未在本条目中实施，
后续优先补稳定附件引用/转写文本的历史契约，再考虑是否新增数据库字段。

## 2026-08-24 · 上下文预算口径统一：移除本地估算对压缩触发的影响

### 问题

此前上下文链路同时存在两套“预算”概念：一套来自 provider 实际返回的输入 token，另一套来自
本地 `estimate_tokens()` 对 system、snapshot、history、RAG 和工具 schema 的估算。两套口径对
中文、工具块、动态尾部和 provider 开销的处理并不一致，导致同一 session 可能出现上一轮看似未超限、
下一轮却提前压缩，或者压缩后再次按旧估算截断的情况；这也会让 baseline 更新点和下一轮输入大小漂移。

### 修复原则

- 正常请求的压缩触发、重试和预算判断只接受 provider 的实际 usage 或 overflow 结果；
- `ContextBudget` 只作为统一的预算分项/诊断结构，不再作为历史读取或压缩触发器；
- 本地 token 估算仅保留给回归测试、诊断展示和 provider overflow 后的确定性兜底，不得提前改变正常上下文；
- 压缩结果通过 LoopScope 的 `Context compaction` span 记录，后续以 baseline 生命周期继续追踪；
- provider 边界保留 `context-layout` 元数据，用于核对 history 顺序、消息数量和序列指纹，不记录正文。

### 回归覆盖

新增压缩回归：在强制压缩路径中替换本地 `estimate_tokens()` 为失败桩，压缩仍必须成功，证明正常压缩
不依赖本地 token 估算。现有 `ContextBudget` 分项、provider overflow 兜底、工具轮次原子性和 baseline
测试继续覆盖兼容诊断与确定性保护路径。

### 验证

后端上下文相关测试通过；后续新增预算字段或压缩触发条件时，必须同时验证 provider usage 与 LoopScope
的压缩 span，禁止重新引入第二套本地预算触发逻辑。

## 2026-08-25 · PRD-AGENT-4 文档与发布收口

### 收口内容

- 将 `ContextBudget`、provider overflow retry、90% usage 收尾压缩、baseline 增量读取和 pending 生命周期的权威说明统一收口到 PRD-AGENT-4。
- 归档 PRD-AGENT-3 的旧固定窗口语义；PRD-LLM-8 保留缓存目标但不再承载上下文压缩实现；PRD-IM-6 保留渠道复用与物理保留规则。
- 保留 `context-layout` 和 baseline 生命周期诊断字段。它们只记录数量、token、hash/摘要指纹和阶段，不记录消息正文、附件内容或凭据，也不注入模型上下文。

### 验证

- ContextBudget、历史读取、压缩、消息原子边界、core retry 和 provider history 专项：`72 passed`。
- 本次没有伪造迁移前后的线上 token/cache 对比；真实脱敏长群 trace 继续作为上线后的观察项，避免把不同 provider、模型和会话状态混为可比数据。

## 2026-08-25 · DeepSeek 前缀缓存限制整理

- DeepSeek 走 OpenAI-compatible 自动前缀缓存，当前不发送未经确认的显式 `cache_control`；缓存命中依赖请求前缀结构稳定，客户端不能指定服务端断点。
- 20-run 脱敏测试中，首轮为冷缓存；Run 3 起曾稳定命中约 `12,032` token，但随着工具历史增长命中量没有继续推进，缓存率从 `78.04%` 降至 `68.10%`。该现象只能说明早期前缀稳定，不能直接归因于 provider 能力或某一个业务字段。
- 已将约束、已确认事实、未确认假设和后续 A/B 验证方案整理到 `docs/reports/DEEPSEEK-PREFIX-CACHE-CONSTRAINTS-20260825.md`。后续以 canonical/wire/schema/tail digest 的首个差异为准，不把 `12,032` 或假设的缓存粒度硬编码进实现。

## 2026-08-25 · 用户 Skill Phase 4 按需注入与变更生效

- 用户 Skill metadata 现在按 owner 合并到每次运行的 Capability Snapshot；首轮目录只包含简介，不加载 Skill 正文。
- `use_skill` 通过数据库 owner 隔离查询启用中的用户 Skill，正文仍按需进入工具结果；正文更新后以 content digest 判断并重新加载，停用后不会从旧 session 扩大能力范围。
- Web、IM 和定时任务统一使用用户能力快照；关联工具在快照构建时按当前授权集合收窄，实际执行仍由 registry/dispatch 权限检查决定。
- LoopScope 只记录 Skill source、owner fingerprint 和 content digest 等脱敏元数据，不记录 Skill 正文或用户标识。

验证：用户 Skill 与能力注入专项 `27 passed`，Python `compileall` 通过。

## 2026-08-25 · AGENT-5 分支式上下文压缩与缓存保持收口

- inline compaction 与持久 baseline 现在共用同一份 branch/fallback 候选生成策略：历史输入不超过 `96,000` 字符时只发一次摘要请求，超限才按 `48,000` 字符块滚动合并。
- 新增摘要候选契约：必须为非空纯文本、最多 `10,000` 字符，不能重复携带外层 `<compacted-summary>` 标记；校验失败直接丢弃，当前消息和 baseline 均不变化。
- baseline 提交前抽出纯 CAS 判断，baseline id 或 hash 任一变化都会丢弃旧候选；provider overflow 重试继续通过 `protected_from` 保留当前 run 的用户消息、工具调用和工具结果。
- 诊断只保留模式、数量、长度、耗时和 hash 等脱敏字段，不记录历史正文。

验证：上下文压缩专项 `41 passed`，Python compileall 与 `git diff --check` 通过；各 provider 的真实线上复测保留为发布后观测项。

## 2026-08-26 · RAG scope 缓存与召回并行优化

- 群组/成员记忆文档使用 `scope_version + updated_at` revision，并保留 30 分钟进程内投影缓存；记忆变更事件会主动失效对应 owner 的 scope 投影。
- 自动召回把同一请求的群组与成员 scope 合并为一次检索；来源 Retriever、scope 文档加载和持久化索引查询不再串行等待。
- Rust sidecar 继续作为跨 worker 的长期索引持有者；新增 `sidecar_reused`、`index_build_ms`、`search_ms`、来源 `retrieve_ms` 等脱敏阶段日志，区分本地缓存命中与 sidecar 复用。
- 自动召回超时任务现在有完成回收和 32 个后台任务上限，避免上游超时导致任务无限堆积；超时仍不会取消可能持有数据库连接的查询协程。

验证：RAG 模块 compileall、完整后端 pytest 与 `git diff --check` 通过；线上继续观察 `t=rag` 的 stages 和 `sidecar_reused` 分布。
### 清理临时探针（2026-08-26）

- 移除 IM 文本选项消费路径中遗留的原始诊断输出。
- 清理 QQ 表情解析器中已过期的“入站探针”注释；保留 Context 布局审计、RAG 阶段耗时、能力检测和媒体元数据探测等正式功能。

## 2026-08-26 · 工具 Schema 原文精简

- 直接收短工具定义中的 `description` 与参数说明，去掉重复操作手册和大段示例；保留工具用途、关键限制、必填关系和危险操作提示。
- 思维笔记块协议改为简短结构说明，真实 JSON Schema 的 `type`、`enum`、`required`、`items` 等约束未改变；Provider 仍直接使用 canonical schema，不再维护第二套投影或运行时补丁。
- 颜色枚举、字段名和 handler 均未改动，便于后续继续按单个工具审阅文案。
