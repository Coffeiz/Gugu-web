import { useProjectAccess } from '@/api/projects'
import { ref, watch, type ComputedRef } from 'vue'
import { showAppError } from '@/composables/core/useAppToast'

/** 文件数由服务端事务投影维护；文件变更后只读取小型项目计数摘要。 */
export function useProjectFileCounts(filesRevision: ComputedRef<unknown>) {
  const loadCounts = useProjectAccess().fileCounts
  const counts = ref<Map<number, number> | null>(null)
  let requestVersion = 0

  async function refresh() {
    if (!loadCounts) return
    const version = ++requestVersion
    try {
      const rows = await loadCounts()
      if (version !== requestVersion) return
      counts.value = new Map(rows.map(row => [row.projectId, row.fileCount]))
    } catch (error) {
      if (version === requestVersion) showAppError(error)
    }
  }

  watch(filesRevision, () => { void refresh() }, { flush: 'post' })
  return { counts, refresh }
}
