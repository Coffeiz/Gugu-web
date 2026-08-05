# 文件浏览系统模块化重构 · Phase 6 验收报告

日期：2026-08-03

## 结论

Phase 6 的展示层、状态层、操作层和场景扩展已完成收口。普通文件目录通过 `FileBrowserPanel` 接入公共工具栏能力；项目文件区继续通过 `ProjectFileToolbar` 提供项目阶段扩展；回收站和存储统计仍保留在文件库页面层。

## 分阶段审查

| 阶段 | 审查结论 |
| --- | --- |
| 阶段 1：展示层 | Grid/List/Breadcrumb/ContextMenu、FileCard、FolderCard、上传 ghost 和上传按钮已共享；未改拖拽克隆、缩略图时序和卡片 DOM 外壳。 |
| 阶段 2：状态层 | 选择、Shift/框选、目录历史、排序投影均通过共享 composable；项目范围、全局导航和回收站范围仍是场景边界。 |
| 阶段 3：操作层 | 上传、冲突处理、重命名、下载、删除、批量操作、剪贴板和拖拽移动分别由 composable/facade 收口；页面只保留目标范围和回滚协调。 |
| 阶段 4：边界层 | 右键菜单使用公共展示组件和动作入口；回收站恢复、彻底删除、清空操作未塞进通用面板。 |
| 阶段 5：文件库扩展 | 个人/项目/普通文件夹导航由文件库页面保留；普通目录使用面板默认工具栏，回收站按钮通过 `toolbar-extra` 扩展。 |
| 阶段 6：面板收口 | `FileBrowserPanel` 统一布局和公共工具栏受控状态；`FileBrowserToolbar` 提供粘贴、多选、视图、新建文件夹和排序；项目工具栏可通过 `toolbar` 插槽覆盖。 |

## 当前公共面板 API

`FileBrowserPanel` 接收 `viewMode`、`selectionMode`、`canPaste`、新建文件夹状态和排序状态，并通过对应的 `update:*`、`paste`、`toggle-selection`、`create-folder`、`sort-select` 事件回传。 `breadcrumb`、`toolbar-extra`、`trailing` 和 `toolbar` 插槽用于面包屑、回收站/存储统计和项目专属工具栏。

## 验证

- `npm run typecheck -- --pretty false`：通过。
- `npm run typecheck:strict -- --pretty false`：通过。
- `npm run test:run`：26 个测试文件、245 个测试通过。
- devserver Playwright：8 个测试通过，覆盖文件库普通目录、项目文件区和回收站扩展。
- `npm run build`：通过（仅保留既有动态导入和大 chunk 警告）。
- `git diff --check`：通过。
- `mutagen sync flush gugu-web`：通过。

## 保留边界

通用面板不持有文件缓存、API 副作用、项目权限、拖拽物理或回收站列表数据；这些由页面场景和既有 composable 继续负责，避免把差异分支重新集中到一个全能组件。
