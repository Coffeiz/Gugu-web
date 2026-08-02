# PR6 第四批收尾清单

## 当前基线

- Gugu-web：`runtime-integration-backup-20260731`
- Runtime：`4f1f39f7df88e5c4ccd0094af792071b08768da1`
- Runtime 通过同级源码目录接入，暂不切换 npm 包。

## 已完成

- 第二批安全、FLIP 和媒体资源问题已提交。
- 第三批 Owner、CSS 作用域、重命名回滚和 probe 清理已提交。
- 前端 `npm run typecheck` 通过。
- 前端 `npm run test:run` 通过：18 个测试文件、223 个测试。
- Runtime `typecheck`、`test`（68 个测试）和 `build` 均通过。
- 前端 `build` 通过；仅保留既有的动态导入和大 chunk 警告。
- devserver 后端 pytest 已执行：458 个通过，1 个既有的跨项目文件夹移动用例失败，与本批改动无关。
- 已增加 Runtime 集成 CI，固定 Runtime commit 并复现同级源码目录布局。
- 第三轮审查 P0–P2 收口：媒体输出硬上限、画布加载/重命名竞态、路径迁移唯一性、孤儿导入归属校验、错位截断提示和结构化媒体错误结果均已落地。
- CI 的 frontend/runtime job 已改用 `npm ci`；devserver 后端全量 pytest 当前为 471 passed。

## PR 前验证

### 自动验证

- [x] `npm run typecheck`
- [x] `npm run test:run`
- [x] `npm run typecheck:strict`
- [x] `npm run build`
- [x] 后端完整 pytest（devserver：458 passed；`test_move_folder_across_projects_relocates_subtree` 既有失败）
- [x] Runtime 仓库 typecheck/test/build

> 自动验证已完成。后端失败项已单独记录，不能作为本批第四批改动的回归失败；合并前仍应单独修复或确认该既有用例。

### 人工联调

- [ ] 项目页同列、跨列、无效落点、快速 regrab。
- [ ] 完成列年月组展开/收起和底部卡片 FLIP。
- [ ] 归档弹窗展开/收起及拖拽后回归。
- [ ] 画布新建、切换、删除、重命名失败回滚。
- [ ] 文件路径迁移：过期扫描、占用路径、跨用户路径均被拒绝。

## 提交边界

本批只负责固定联调基线、补 CI 和记录验证清单，不直接合并主分支。CI 需要仓库具备读取 Runtime 私有仓库的 `RUNTIME_REPO_TOKEN`；没有该 Secret 时，工作流会使用默认 `GITHUB_TOKEN`，若权限不足应在仓库设置中补充而不是改回浮动源码引用。
