import { onMounted, onScopeDispose, watch } from 'vue'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'

export function useFileWatch(url: () => string | undefined, refresh: (signal: AbortSignal) => void | Promise<void>) {
  let controller: AbortController | undefined
  let retry: number | undefined
  let focusOnly = false
  let mounted = false

  function stop() {
    window.clearTimeout(retry)
    controller?.abort()
    controller = undefined
  }

  async function subscribe(address: string, signal: AbortSignal, delay = 1000) {
    try {
      const response = await fetch(address, { signal, credentials: 'include', cache: 'no-store' })
      if (response.status === 204) {
        focusOnly = true
        await refresh(signal)
        return
      }
      if (response.status === 401 || response.status === 403) return
      if (response.ok && response.body) {
        const reader = response.body.getReader()
        try {
          while (!signal.aborted) {
            const { done } = await reader.read()
            if (done || signal.aborted) break
            delay = 1000
            await refresh(signal)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
    } catch {
      if (signal.aborted) return
    }
    if (!signal.aborted) retry = window.setTimeout(() => {
      void subscribe(address, signal, Math.min(delay * 2, 30000))
    }, delay)
  }

  function restart() {
    stop()
    if (!mounted || document.hidden) return
    const address = url()
    if (!address) return
    controller = new AbortController()
    if (focusOnly) void refresh(controller.signal)
    else void subscribe(address, controller.signal)
  }

  watch([url, accountBoundaryEpoch], () => {
    focusOnly = false
    restart()
  })
  onMounted(() => {
    mounted = true
    document.addEventListener('visibilitychange', restart)
    window.addEventListener('focus', restart)
    restart()
  })
  onScopeDispose(() => {
    stop()
    document.removeEventListener('visibilitychange', restart)
    window.removeEventListener('focus', restart)
  })
}
