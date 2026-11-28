import { onMounted, onUnmounted, ref, watch, type ComputedRef } from 'vue'
import type { MailInboxWatch } from '@gugu/email/contracts'
import type { MailAccess } from '@/api/mail'

function watchId() {
  // getRandomValues 在局域网 HTTP 预览中也可用。
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function useInboxWatch(request: MailAccess['request'], accountIds: ComputedRef<string[]>, invalidate: (id: string) => void, updateCount: (id: string, count: number) => void) {
  const visible = ref(false)
  const syncVisibility = () => { visible.value = document.visibilityState === 'visible' }
  const subscriptions = new Map<string, () => Promise<void>>()
  function subscribe(accountId: string) {
    const id = watchId()
    let stopped = false
    let cursor: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let pending = false

    async function renew() {
      pending = true
      let delay = 0
      try {
        const result = await request<MailInboxWatch>({ action: 'watchInbox', accountId, watchId: id, cursor })
        if (stopped) return
        if (typeof result.unreadCount === 'number') updateCount(accountId, result.unreadCount)
        if (result.changed || failures > 0) invalidate(accountId)
        cursor = result.cursor
        failures = 0
        delay = result.idle ? (result.changed ? 500 : 0) : 60_000
      } catch {
        delay = Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5))
      } finally {
        pending = false
        if (!stopped) timer = setTimeout(() => { void renew() }, delay)
      }
    }

    void renew()
    return async () => {
      stopped = true
      clearTimeout(timer)
      if (pending) await request({ action: 'stopInboxWatch', accountId, watchId: id }).catch(() => {})
    }
  }

  watch([visible, accountIds], ([enabled, ids]) => {
    const wanted = new Set(enabled ? ids : [])
    for (const [id, stop] of subscriptions) {
      if (!wanted.has(id)) { void stop(); subscriptions.delete(id) }
    }
    for (const id of wanted) {
      if (!subscriptions.has(id)) subscriptions.set(id, subscribe(id))
    }
  })

  onMounted(() => {
    document.addEventListener('visibilitychange', syncVisibility)
    syncVisibility()
  })
  onUnmounted(() => {
    document.removeEventListener('visibilitychange', syncVisibility)
    for (const stop of subscriptions.values()) void stop()
    subscriptions.clear()
  })

  return function refreshInboxCount(accountId: string) {
    const stop = subscriptions.get(accountId)
    if (!stop) return
    // 先让旧响应失效，再重新读取服务端计数，避免旧 IDLE 响应覆盖新状态。
    const restart = stop()
    subscriptions.set(accountId, () => restart)
    const marker = subscriptions.get(accountId)
    void restart.then(() => {
      if (subscriptions.get(accountId) === marker) subscriptions.set(accountId, subscribe(accountId))
    })
  }
}
