import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { filesApi } from '@/services/api'

/** 用轻量文件树聚合计数维护看板徽标，不把完整文件清单拉入页面。 */
export function useProjectFileCounts(filesRevision: Readonly<Ref<number>>) {
  const counts = ref<Map<number, number> | null>(null)
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let requestRevision = 0

  async function refresh() {
    const requestId = ++requestRevision
    try {
      const tree = await filesApi.tree()
      if (requestId !== requestRevision) return
      counts.value = new Map(tree.projects.map(project => [project.id, project.totalCount]))
    } catch {
      if (requestId === requestRevision) counts.value = null
    }
  }

  watch(filesRevision, () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, 120)
  })

  onScopeDispose(() => {
    requestRevision += 1
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = null
  })

  return { counts, refresh }
}
