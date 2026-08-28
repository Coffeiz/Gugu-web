# GuguChat 窗口展开/收起动画重绘优化 PRD

> 状态：⏸️ 暂不实施（现状性能已满足需求，保留低风险优化；后续如出现新的可复现瓶颈再重启评估）
> 创建：2026-08-06
> 最近更新：2026-08-06
> 关联模块：`frontend/src/components/common/GuguChat.vue`、`frontend/src/components/common/gugu-chat/GuguChatComposer.vue`、`frontend/src/components/common/gugu-chat/GuguChatMessageList.vue`
> 背景参考：本次会话人工排查 + 已回滚的两次尝试性修复（commit `226ea37e` 关闭 backdrop-filter 已 revert；ResizeObserver 写后即读的 layout-thrash 修复也已撤销，未合入）

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：问题排查 + 低风险合成层提示 | ✅ 已完成 | 定位到问题根源（见第 3 节），给 `.chat-window` 加 `isolation: isolate`、`.chat-main` 加 `will-change: backdrop-filter`，纯提示性质，不改变行为，已随本次会话提交。 |
| Phase 1：展开/收起动画改造方案选定 | ⏸️ 暂不实施 | 主要性能问题已由 Markdown 优化和消息列表虚拟化解决，暂不为潜在收益引入 FLIP 或交叉淡化的视觉风险。 |
| Phase 2：方案实施 | ⏸️ 暂不实施 | 没有新的可复现卡顿证据前不实施；现有布局动画保持不变。 |

---

## 1. 背景与目标

### 现状痛点

- GuguChat 小窗↔大窗的展开/收起动画，通过 CSS `transition: top/left/right/bottom`（[GuguChat.vue:785-793](../../../frontend/src/components/common/GuguChat.vue)）实现位移和尺寸变化。这四个是布局属性，动画期间每一帧都会触发浏览器重新走 layout，无法像 `transform`/`opacity` 那样完全交给合成线程处理。
- `.chat-main` 常驻 `backdrop-filter: var(--glass-blur)` 玻璃模糊效果，在窗口连续变尺寸期间要跟着重算模糊采样区域，开销叠加在上面这条布局动画之上，用户反馈"收起放大窗口的时候容易引发重绘，页面会闪一下"。
- 曾定位到另一个真实的性能问题：`enterExpanded`/`exitExpanded` 里用 `ResizeObserver` 在动画期间持续跟底（`el.scrollTop = 999999`），回调里"写完立刻读"（`lastTop.value = el.scrollTop`）的模式，会在每一帧强制触发一次同步布局（layout thrashing）。这个问题本身独立于上面两点，修复本身不改变任何视觉效果，但当时因为要撤销同批次的其他改动被一并撤销，尚未重新提交。

### 目标

让窗口展开/收起动画不再有可感知的闪烁/重绘，同时不引入新的、更明显的视觉缺陷（比如动画途中文字被拉伸变形）。

### 不做的事

- 不做 GuguChat 主体的 Canvas/WebGL 化，也不做自研 GPU 渲染引擎——GuguChat 是文本/表单/markdown 型界面，脱离 DOM 会丧失文字排版、输入法组合、文本选中、可访问性等浏览器原生能力，成本收益不成比例（结论已在会话中确认，见第 5 节）。
- 本 PRD 不预先替用户做"动画观感是否可以从『长大』变成『切换』"这个产品决策，方案选择留待确认。
- 项目页面（`ProjectFilesPanel.vue`）、思维笔记面板（Mind 相关组件）虽有相同的"尺寸动画 + backdrop-filter"结构、且部分已有类似修复先例，但本 PRD 范围仅覆盖 GuguChat，其余面板留待各自观察到实际问题后再单独立项。

---

## 2. 功能需求

### FR-PERF-1：低风险合成层提示（✅ 已完成）

- `.chat-window` 加 `isolation: isolate`：建立独立层叠上下文，窗口内部的合成变化不牵连页面其余部分。
- `.chat-main` 加 `will-change: backdrop-filter`：提示浏览器为该属性单独准备合成层。
- 纯提示性质，不改变任何行为/样式表现，预期只能带来有限改善，不能根治。

### FR-PERF-2：ResizeObserver 读写合并（⏸️ 暂不实施）

- `enterExpanded`/`exitExpanded` 的 `ResizeObserver` 回调改为只写 `el.scrollTop = 999999`，不在回调内读回 `el.scrollTop`；`lastTop` 挪到动画结束（`ResizeObserver.disconnect()` 那一刻）统一读一次。
- 不改变滚动跟随的最终效果（动画期间本就是程序化强制滚底，不存在"用户上翻"需要 `lastTop` 实时更新的场景）。
- 风险低、不涉及视觉效果，可以不等 Phase 1 方案定案就先落地——之前已经写过一版（见本 PRD 头部背景参考），后续可以直接重新应用。

### FR-PERF-3：展开/收起动画改造（⏸️ 暂不实施）

两个候选方案，详见第 3 节技术方案：

- **方案 A**：`transform` + FLIP，保持"窗口长大/缩小"的观感，但要接受动画期间内容（文字、虚拟列表）跟着整体缩放变形的新缺陷。
- **方案 B**：交叉淡化，位置/尺寸直接跳变、纯 `opacity` 过渡，彻底走合成层不会闪，但动画质感从"长大"变为"切换"。

---

## 3. 技术方案

### 现状实现

`windowStyle`（[GuguChat.vue:335-348](../../../frontend/src/components/common/GuguChat.vue)）根据 `expanded` 返回不同的 `top/left/right/bottom` 绝对像素值，CSS `transition` 负责平滑过渡。小窗态还额外依赖 `smallH`（跟随消息内容真实高度、由 `contentH`/`syncSmallH` 驱动）计算窗口高度。

小窗→大窗不是纯粹的"同一份内容被拉伸"，是"内容本身也在重新排版"：

| 差异点 | 小窗 | 大窗 |
|---|---|---|
| 宽度 | 固定 `SMALL_W`(360px) | `vw * 0.4` 起算，随视口宽度变 |
| 字号/气泡最大宽度 | 默认 | `.chat-main.is-expanded` 覆盖，更大 |
| 消息列表顶部留白 | 12px | 20px（`GuguChatMessageList.vue` 的 `msgsPadTop`） |
| 输入框宽度 | 离屏量高度重新换行（`GuguChatComposer.vue` 的 `textareaWidthForMode`） | 同上，不同目标宽度 |
| 侧边栏 | 不挂载 | `v-if="expanded"` 挂载 |
| 发送按钮/图标尺寸 | 28px / 13px | 32px / 14px |

这些差异是方案 A 的核心卡点：`transform: scale()` 只能整体缩放，无法表达"字号从 13px 变 14px、留白从 12px 变 20px"这类排版级变化。

### 方案 A：FLIP（内容跟随缩放）

动画开始瞬间将 DOM 切到目标（大窗）布局和真实尺寸，同时计算"目标状态相对起始状态的缩放/位移差"，用 `transform: scale() translate()` 让它视觉上还停在起点，再把 `transform` 过渡回 `none`。

**要改的地方**：
1. `windowStyle` 重写为恒定返回目标状态的最终样式 + 一个临时 `transform`
2. `enterExpanded`/`exitExpanded` 新增前后矩形（起止 rect）计算逻辑
3. CSS transition 从 `top/left/right/bottom` 换成 `transform`
4. `win-grow`（流式生成时小窗即时长高，见 [GuguChat.vue:40](../../../frontend/src/components/common/GuguChat.vue) 附近注释）依赖同一套 top 过渡机制的即时跟随逻辑，需要重新对齐
5. 侧边栏挂载时机、迷你播放器/通知气泡锚点（`miniPlayerStyle`/`notifyAnchor`/`notifyOrigin`，均读 `smallH`/`expanded`）大概率要跟着调整触发时序

**已知缺陷**：动画过程中文字、虚拟列表内容会跟着 `scale()` 整体变形发虚，动画结束瞬间还要"啪"一下切回真实排版（字号跳变、留白跳变），可能比当前的闪烁更违和。

**工作量评级**：中大。预计触及 4-5 个文件，新增矩形计算逻辑，且要重新过一遍全部相关交互（流式生成中展开、侧边栏、迷你播放器联动、通知气泡定位、窄屏/宽屏 resize）的手动测试。

### 方案 B：交叉淡化

放弃"长大/缩小"的位移观感，改为两套内容（小窗态、大窗态）短暂共存，纯靠 `opacity` 淡入淡出切换，位置尺寸直接跳变（不做 top/left 过渡）。`opacity` 是合成层动画，不触发 layout，天然不会闪。

**要改的地方**：
1. `windowStyle` 不再需要过渡值，直接返回目标状态（比现状更简单）
2. 用 Vue 内置 `<Transition>` 包一层做 fade
3. 不涉及矩形计算、`win-grow`、虚拟列表/输入框宽度逻辑，改动面小

**代价**：动画质感从"窗口长大"变成"内容切换/闪现"，失去位移的连贯感和分量感——这是一个产品体验取舍，不是纯技术决策。

**工作量评级**：小。预计一两个文件，CSS 为主。

---

## 4. 验证与上线

- 本 PRD 涉及的改动都是纯前端视觉/动画调整，不改变数据或业务逻辑，现有 vitest 用例不覆盖动画视觉效果，验证只能靠人工在开发服务器上过一遍：
  - 展开大窗 → 收起小窗，反复几次观察有无闪烁/半透明/内容跳变
  - 流式生成过程中展开/收起（`win-grow` 场景）
  - 侧边栏 IM 抽屉展开状态下收起大窗
  - 迷你播放器悬浮时展开/收起
  - 通知气泡出现时展开/收起，确认定位不跑偏
  - 窄屏（`vw` 较小）下反复展开/收起，确认宽度计算无异常
- 上线方式：随前端构建直接发布，不需要灰度/开关，风险等级低（CSS-only 改动为主，方案 A 才涉及 JS 逻辑改动，需要更完整的回归）。
- 上线后无需监控指标/日志，纯视觉问题，靠用户反馈是否还有闪烁。

---

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 方案 A 下内容跟着 `scale()` 整体缩放变形 | 引入比现状更明显的新视觉缺陷（文字发虚、动画尾声排版跳变） | 优先评估方案 B，或维持现状不动 |
| 直接禁用 `backdrop-filter` 而不换等效纯色兜底 | 面板露出背景内容，呈现"半透明"（已实际踩坑，commit `226ea37e` 已 revert） | 记录在案，之后任何"关闭 backdrop-filter"的尝试必须同时给一个高不透明度纯色兜底，或直接放弃这个思路 |
| `ResizeObserver` 写后即读引发的 layout thrashing | 潜在的真实卡顿来源，目前未修复（改动已撤销） | 见 FR-PERF-2，可独立于方案 A/B 的选择先单独修复 |

### 待确认问题

- ⏸️ 方案 B（交叉淡化）不再推进：当前没有足够的用户可感知收益来抵消动画观感变化。
- ⏸️ FR-PERF-2（ResizeObserver 读写合并）不单独推进：当前未观察到由它造成的实际卡顿；如后续 trace 重新证明它成为热点，再单独恢复评估。
- ✅ 已确认：不做 GuguChat 主体的 Canvas/WebGL 化，不做自研 GPU 渲染引擎。结论依据：DOM 型界面脱离浏览器原生排版/输入/可访问性能力后自建成本远超收益，且该重绘问题本质是合成层开销而非绘制复杂度，换渲染方式并不能绕开。
- ✅ 已确认：项目页面、思维笔记面板暂不纳入本次优化范围——项目页面（`ProjectFilesPanel.vue`）已有类似问题的历史修复先例，思维笔记面板结构类似但未观察到实际问题，留待各自独立立项。

### 当前结论

本 PRD 暂不继续实施。此前主要性能问题来自 Markdown 渲染和消息列表缺少虚拟滚动，相关优化完成后 GuguChat 已达到当前使用场景所需的流畅度。窗口尺寸动画和 ResizeObserver 读写合并仍属于潜在优化，不应在缺少新的可复现性能证据时扩大修改范围。
