import { onUnmounted, reactive } from 'vue'

type AdminStore = { authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }

export function useEmbeddingRebuild(adminStore: AdminStore) {
  const rebuild = reactive({ running: false, done: 0, total: 0, msg: '', error: false })
  let timer: ReturnType<typeof setInterval> | null = null

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  async function poll() {
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/embedding-rebuild/status')
      const data = await res.json()
      if (data.status === 'running') {
        rebuild.running = true; rebuild.done = data.done || 0; rebuild.total = data.total || 0
        rebuild.msg = `重建中 ${rebuild.done}/${rebuild.total}`; rebuild.error = false
        if (!timer) timer = setInterval(() => void poll(), 2000)
      } else if (data.status === 'done') {
        rebuild.running = false; rebuild.error = false
        rebuild.msg = `完成：重算了 ${data.done || 0} 个用户的 pattern + 长期记忆向量（${data.with_facts || 0} 个有 pattern）`
        stop()
      } else if (data.status === 'error') {
        rebuild.running = false; rebuild.error = true; rebuild.msg = '失败：' + (data.message || '')
        stop()
      } else {
        rebuild.running = false; stop()
      }
    } catch (error) {
      rebuild.running = false; rebuild.error = true
      rebuild.msg = error instanceof Error ? `请求失败：${error.message}` : '请求失败'
      stop()
    }
  }

  async function start() {
    rebuild.msg = ''; rebuild.error = false
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/embedding-rebuild', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        rebuild.running = true; rebuild.total = data.total || 0; rebuild.done = 0
        rebuild.msg = `已启动，共 ${data.total || 0} 个用户`
      } else {
        rebuild.error = true; rebuild.msg = data.message || '启动失败'
      }
      void poll()
    } catch (error) {
      rebuild.error = true; rebuild.msg = error instanceof Error ? `请求失败：${error.message}` : '请求失败'
    }
  }

  onUnmounted(stop)
  return { rebuild, pollRebuild: poll, startRebuild: start }
}
