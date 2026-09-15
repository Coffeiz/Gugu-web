import { onUnmounted, reactive } from 'vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'

type Translate = (key: string) => string
type AdminStore = { authFetch: (url: string, options?: RequestInit) => Promise<Response> }

export function useIndexRebuild(adminStore: AdminStore, t: Translate) {
  const rebuild = reactive({ running: false, done: 0, total: 0, documents: 0, msg: '', error: false })
  let timer: ReturnType<typeof setInterval> | null = null

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  async function poll() {
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/index-rebuild/status')
      const data = await res.json()
      if (data.status === 'running') {
        rebuild.running = true
        rebuild.done = data.done || 0
        rebuild.total = data.total || 0
        rebuild.documents = data.documents || 0
        rebuild.msg = t('adminAgentMemory.indexRebuildingProgress')
          .replace('{done}', String(rebuild.done)).replace('{total}', String(rebuild.total))
        rebuild.error = false
        if (!timer) timer = setInterval(() => void poll(), 2000)
      } else if (data.status === 'done' || data.status === 'error') {
        rebuild.running = false
        rebuild.documents = data.documents || 0
        rebuild.error = data.status === 'error'
        rebuild.msg = data.message || (rebuild.error
          ? t('adminAgentMemory.indexRebuildFailed')
          : t('adminAgentMemory.indexRebuildDone').replace('{documents}', String(rebuild.documents)))
        stop()
      } else {
        rebuild.running = false
        stop()
      }
    } catch (error) {
      rebuild.running = false
      rebuild.error = true
      rebuild.msg = `${t('adminAgentMemory.indexRebuildRequestFailed')}: ${error instanceof Error ? error.message : String(error)}`
      stop()
    }
  }

  async function start() {
    if (!await confirmDialog({
      title: t('adminAgentMemory.indexRebuildConfirmTitle'),
      message: t('adminAgentMemory.indexRebuildConfirmMessage'),
      tone: 'warning',
      confirmText: t('adminAgentMemory.indexRebuildConfirm'),
    })) return
    rebuild.msg = ''
    rebuild.error = false
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/index-rebuild', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        rebuild.running = true
        rebuild.done = 0
        rebuild.total = data.total || 0
        rebuild.documents = 0
        rebuild.msg = t('adminAgentMemory.indexRebuildStarted').replace('{total}', String(rebuild.total))
      } else {
        rebuild.error = true
        rebuild.msg = data.message || t('adminAgentMemory.indexRebuildFailed')
      }
      void poll()
    } catch (error) {
      rebuild.error = true
      rebuild.msg = `${t('adminAgentMemory.indexRebuildRequestFailed')}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  onUnmounted(stop)
  return { rebuild, pollIndexRebuild: poll, startIndexRebuild: start }
}
