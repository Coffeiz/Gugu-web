import { ref, watch, type ComputedRef } from 'vue'
import { showAppError } from '@/composables/core/useAppToast'
import { projectsApi } from '@/services/api'

/** 文件数由服务端事务投影维护；文件变更后只读取小型项目计数摘要。 */
export function useProjectFileCounts(filesRevision: ComputedRef<unknown>) {
  const counts = ref<Map<number, number> | null>(null)
  let requestVersion = 0

  async function refresh() {
    const version = ++requestVersion
    try {
      const rows = await projectsApi.fileCounts()
      if (version !== requestVersion) return
      counts.value = new Map(rows.map(row => [row.projectId, row.fileCount]))
    } catch (error) {
      if (version === requestVersion) showAppError(error)
    }
  }

  watch(filesRevision, () => { void refresh() }, { flush: 'post' })
  return { counts, refresh }
}
