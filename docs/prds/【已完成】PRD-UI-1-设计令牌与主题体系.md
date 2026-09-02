# PRD-UI-1 设计令牌与主题体系

> 状态：Phase 0-5 已完成（2026-08-15）

## 目标

建立一套可复用、可主题化、可观察的前端设计令牌体系，并提供 `/design` 运行时实验室，作为主应用与 Admin 后续视觉迁移的基线。

## 范围

- 主应用支持 `light`、`dark`、`system` 三种主题偏好。
- Admin 保持独立暗色主题，仅共享基础尺度、状态和动效契约。
- 间距、字号、圆角各保留四个主档位；胶囊圆角为形状例外。
- 颜色、表面、边框、文字、状态、阴影、动效和滚动条通过 CSS 语义变量消费。
- `/design` 直接读取 CSS 变量，展示真实值、主题和共享组件状态。
- 画布 camera、物理、landing 和 connection 参数不属于本 PRD 的普通 UI 令牌迁移范围。

## 不在范围内

- 一次性替换所有业务组件中的历史裸色值。
- 修改 Interaction Runtime 的拖拽物理和 camera 行为。
- 强制统一项目品牌色、文件类型色等数据驱动颜色。
- 改变 Admin 的信息密度或深色产品定位。

## 交付物

- `frontend/src/assets/styles/tokens/` 分层令牌目录。
- `frontend/src/composables/useTheme.ts` 主题状态与首屏初始化配合。
- `/design` 运行时令牌实验室与主题/状态预览。
- `.scroll-surface`、`compact`、`editor`、`hidden` 滚动容器契约。
- 多行输入框 `.control-resizable` 与 `--control-resizer-bg` 缩放柄契约，供 Admin、前台和 Dev 页面复用。
- Admin `.admin-theme` 独立语义作用域。

## 验收

- `light/dark/system` 可切换，`system` 监听系统主题变化。
- `/design` 显示的值来自 `getComputedStyle`，catalog 不保存第二份实际值。
- 四档间距、字号、圆角由自动化测试锁定。
- 前端源码中的局部滚动条规则收敛到全局语义类；横向笔记区和编辑器保留明确特例。
- 可缩放 textarea 统一使用 `.control-resizable`；不得在业务页面重复实现 `::-webkit-resizer`，缩放柄 token 必须能在 `/design` 页面观察并适配主题。
- `npm run typecheck:strict`、`npm run test:run`、`npm run build` 通过。

## 关联工程方案

- `docs/refactor/设计令牌与Design页面重构方案.md`
