/**
 * 项目进度口径（全站统一）：总完成度 = 所有阶段待办里「已完成 / 总数」，不按阶段位置。
 * 没有任何待办时退回按当前阶段位置（(当前阶段序号 + 1) / 阶段数）。
 *
 * 看板卡 / 总览页 / 项目编辑卡头部 / 日历项目条 / Dashboard 近期节点胶囊 都应使用这一口径。
 */
export function projectProgress(project) {
  const stages = project?.stages ?? []
  if (!stages.length) return 0
  let done = 0, total = 0
  for (const s of stages) {
    const todos = s.todos ?? []
    done += todos.filter(t => t.done).length
    total += todos.length
  }
  if (total > 0) return Math.round(done / total * 100)
  const idx = stages.findIndex(s => s.key === project.currentStage)
  return idx < 0 ? 0 : Math.round((idx + 1) / stages.length * 100)
}
