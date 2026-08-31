# 前端测试分层审查

> Phase 3 复核记录。前端 Vitest、静态检查和 Playwright 按运行时边界分开统计，不因测试名称相似而合并。

## 分类规则

| 类别 | 目录/入口 | 职责 | 处置 |
|---|---|---|---|
| 同目录纯逻辑 | `frontend/src/**/*.test.ts` | 与实现同目录的 formatter、composable、domain、样式回归和局部组件契约 | 保留原地，随 `test:fast`/`test:run` 执行 |
| 跨模块契约 | `frontend/test/**/*.test.ts` | 文件、项目、画布和乐观更新等跨模块状态契约 | 保留 `frontend/test`，不移动到实现目录 |
| 样式回归 | `frontend/src/assets/styles/*regression.test.ts` | CSS token、玻璃材质、focus 和结构回归 | 保留独立文件，不与业务逻辑 Vitest 合并 |
| 静态检查 | `frontend/scripts/check-*.mjs` | i18n、CSS 和统一对话框源码规则 | 保留脚本入口，不改造成 Vitest |
| 稳定 E2E | `npm run test:e2e:stable` | CI 确定性关键路径 | CI 执行 |
| 实验 E2E | `npm run test:e2e:experimental` | 依赖个人文件、目录或长期账号数据的场景 | 显式专项执行，不进入稳定 CI |

## 相似文件复核

| 文件组合 | 表面相似 | 实际边界 | 结论 |
|---|---|---|---|
| `src/components/common/gugu-chat/markdown.test.ts` / `frontend/test/markdown.test.ts` | 都测试 Markdown | 前者锁定聊天表格/转义，后者锁定全站消毒和 XSS 边界 | 保留 |
| `file-browser-visual-regression.test.ts` / `fileSelection.test.ts` | 都涉及文件库 | 前者锁定视觉结构，后者锁定选择状态和交互逻辑 | 保留 |
| `projectStages.test.ts` / `projectStagesComposable.test.ts` | 都涉及项目阶段 | 前者是阶段纯逻辑矩阵，后者是 composable 适配契约 | 保留 |
| 稳定 E2E / 实验 E2E | 都访问文件页面 | 稳定路径不依赖可变文件数据，实验路径含数据前置 skip | 分入口执行 |

## 当前结论

- 已覆盖 `frontend/src` 同目录测试、`frontend/test` 跨模块测试、样式回归和静态检查四类职责。
- 未发现同一生产入口、同一输入边界、同一结果断言的前端重复测试。
- `file-drag-runtime.spec.ts` 和 `filesystem-phases.spec.ts` 的数据依赖已移出稳定 CI；其余 E2E 通过 `test:e2e:stable` 作为关键路径执行。
