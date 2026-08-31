# 开发记录 · 2026-07-16 · ProjectModal 面板拆分：InfoPanel / StagesPanel 抽取收尾

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
