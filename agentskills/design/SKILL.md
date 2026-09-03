---
name: design
description: 产品设计规范摘要。Glassmorphism 视觉风格、色板系统、排版、交互规范、组件契约。涉及 UI 修改时参考，完整设计文档见 references/。
---

# 设计规范摘要

完整设计文档见 [references/frontend-design.md](references/frontend-design.md)（前台）和 [references/admin-design.md](references/admin-design.md)（Admin 后台）。

## 技术栈

- 前端：Vue 3 + Vite + TypeScript + Pinia
- 后端：FastAPI + SQLAlchemy (async) + PostgreSQL + Redis
- 设计风格：Glassmorphism（毛玻璃）+ 冷紫灰调色板

## 核心设计原则

- **ToC 优先**：面向个人/小团队的项目管理工具
- **Glassmorphism**：半透明背景 + backdrop-filter 模糊 + 微妙边框高光
- **冷紫灰调色板**：主色 `#7b7fb2`，所有颜色通过 CSS 变量（design token）管理

## 交互规范

- Hover 提升：`translateY(-2px)` + 阴影加深
- 按下回弹：`translateY(1px)` + 透明度降低
- 拖拽代理：Interaction Runtime 管理，CSS `!important` 不得覆盖 Runtime 控制的属性
- 模态框：`BaseModal.vue` 统一管理，scale + fade 动画

## 组件规范

- 按钮：圆角 8-9px，主色填充或 ghost 描边
- **卡片悬浮操作按钮**：跨域契约统一定义在 `frontend/src/assets/styles/components/card-actions.css`
  （`.file-card-btn` / `.file-list-btn`，file- 前缀仅为历史兼容）。实底 `--control-bg` +
  毛玻璃 + `--elevation-card` 投影，背景/前景 `0.15s` 淡入淡出；破坏性操作加 `del`（或
  `danger`）类取红色 hover。文件库/Dashboard/ProjectModal 直接挂类；画布卡片经
  `CardAffordances.vue` 的 `:deep(button)` 复用同一口径。**新卡片类型一律消费该契约，
  禁止另画透明底、无过渡的按钮**；改动契约时 `card-actions.css` 与 `CardAffordances.vue`
  两处声明同步（归属说明见 `assets/styles/STYLE-OWNERS.md`）。
- 输入框：`--control-bg` 背景，focus 时 `--border-focus` 描边 + `--control-focus-shadow` 光晕
- 卡片：`--surface-card-solid` 或毛玻璃背景，圆角 12-16px
- 侧边栏：220px 固定宽度，Glassmorphism 背景

## 新增/修改 UI 时

1. 先确认使用 design token（`var(--xxx)`），不硬编码颜色
2. 参考 references/ 中的完整设计文档了解具体页面规范
3. 暗色模式通过 `html[data-theme='dark']` 选择器适配

### 玻璃主题的边框令牌陷阱（多次踩坑）

`--border-hairline` / `--border-subtle` 等玻璃主题边框 token 在**亮色玻璃主题下接近纯白**
（如 glass-light 的 hairline 是 `rgba(255,255,255,.30)`）——它们设计给毛玻璃表面，落到
实心表面（面板、图表 canvas、表格）上会不可见。规则：

- **图表（canvas）的所有颜色——网格线、刻度/文字、线条、tooltip——一律走令牌**，
  禁止写死 `rgba(255,255,255,…)` 或按暗色风格硬编码配色；透明变体在 canvas 里用
  `color-mix()` 派生（现代浏览器 canvas 支持 CSS color-mix）。
- 实心表面上的分隔线/网格线，禁止使用玻璃边框 token；用从内容色派生的语义令牌
  （如 `--border-document-table`、`--chart-grid-line`、`--chart-tick`，定义在
  `tokens/semantic.css`，均为 `color-mix` 自内容色，随主题明暗自动反转）。
- 需要新的"实心表面线色"或图表专用色时，先在 `semantic.css` 加语义令牌再消费，
  不要在组件里单独写亮色兜底；canvas 图表（chart.js 不继承 CSS 颜色）用
  `getComputedStyle` 运行时解析令牌值（参考 `_shared.ts` 的 `cssVar` /
  `AdminBarChart` 的 `resolveColor`）。

### 开合箭头统一组件 FlipChevron（方向语义全站默认，勿手写）

所有「收起/展开」箭头一律使用公共组件 `frontend/src/components/common/controls/FlipChevron.vue`，
禁止在组件里手写 svg + `transform: rotate(...)` 复刻（历史上多次因方向写反返工）。方向语义：

- **默认（不传 direction）= right-down：收起朝右（rotate -90°）、展开转回朝下（rotate 0°）**。
  这是全站统一默认——树/分组、折叠面板、下拉触发器都用它，调用点无需任何方向参数。
- 仅「收起朝下、展开朝上」的场景显式传 `direction="up-down"`（如个别顶部横向下拉）。
- 如果发现某个调用点"方向不对"，先怀疑是调用点自己传错 direction 或手写了旋转样式，
  而不是去改公共组件的默认值——默认值方向改动曾导致全站回归，不允许再动。
- 见到旧代码里遗留的 `.xxx-chev { transform: rotate(-90deg) }` 手写箭头，顺手替换为
  FlipChevron；替换时注意保留原尺寸（`size`）与过渡时长（`transition`）。
