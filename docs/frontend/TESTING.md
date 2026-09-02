# 前端测试规则

## 测试层级

- 纯函数、store、composable、InteractionSync 和竞态逻辑放在 `frontend/src/**.test.ts` 或 `frontend/test/`，使用 Vitest。
- 全局样式、主题 token、公共组件结构和样式 owner 使用 `frontend/src/assets/styles/*regression.test.ts` 或现有 CSS 检查脚本。
- 页面跨组件流程使用 `frontend/e2e/` 的 Playwright；稳定主路径集中在 `test:e2e:stable`，拖拽和阶段性实验路径集中在 `test:e2e:experimental`。
- E2E 默认连接已启动的 devserver，通过 `PLAYWRIGHT_BASE_URL` 切换环境，不在测试中重复启动前后端。

## 常用命令

```bash
cd frontend
npm run typecheck
npm run typecheck:strict
npm run test:run
npm run test:css-glass
npm run test:ui-dialogs
npm run build
npm run test:e2e:stable
```

按改动范围运行最小集合，但提交前应完成 typecheck；涉及公共组件、主题或同步层时补充对应回归测试。

## 必测契约

- `InteractionSync`：apply 立即发生、成功收敛、失败回滚、连续意图不被旧失败覆盖、同客户端 Live 回声不重复刷新。
- 表单与公共控件：props/emits、键盘焦点、disabled、亮暗主题、选中/hover 状态和取消路径。
- Runtime 交互：拖拽 landing、proxy/target 交接、surface 注册、节点身份稳定、鼠标停留时不得出现重复 hover 或 opacity `1 -> 0 -> 1` 闪烁。
- Markdown 与链接：危险协议被拒绝、HTML 消毒、聊天 `gugu://` 动作只通过受控分发器。
- 多语言：中文、日文、英文不溢出，新增文案通过 i18n 注册表并通过完整性检查。

## 浏览器验收

- 浏览器评论或截图只作为定位线索，最终必须验证实际 DOM、计算样式和交互结果。
- 主题问题至少检查亮色/暗色；涉及拖拽、Teleport 或动画时检查鼠标停留、快速连续操作和失败回滚。
- 性能 trace、console 探针和临时诊断代码只用于定位，验证结束后必须清理，不得进入提交。
- 失败测试产生的 `test-results/`、trace 和截图属于诊断产物，不应当被误加入业务提交。

## CI 语言约定

- CI 的 Playwright E2E 默认固定使用简体中文 locale（`zh-CN`），并显式设置测试用户的语言偏好；主流程不随浏览器或 devserver 的系统语言变化。
- E2E 选择器优先使用稳定的 `data-testid`、role、aria-label、表单 name 和 URL，不要把中文可见文案作为唯一选择器。
- 必须断言文案时，主 CI 只断言中文资源；英文和日文放入独立的 locale 矩阵或专项 smoke 测试，不与主流程共享脆弱的文本选择器。
- 新增页面、组件或文案时，先保证 `zh-CN` 下的 E2E 通过，再补充其他语言的溢出、缺失翻译和关键路径检查。
- 测试夹具、seed 数据、快照标题和测试用户可见内容统一使用中文；不得依赖真实用户语言设置。
