import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ChatSession } from '../chatTypes'

/** 仅保存本机当前账号的已读版本；运行状态始终来自服务端快照。 */
export function useWebSessionBadges(options: {
  sessions: Ref<ChatSession[]>
  sessionId: Ref<number | null>
  visible: Ref<boolean>
  accountId: Ref<string | null>
}) {
  const readVersions = ref<Record<string, number>>({})
  // 切账号后，旧账号列表在新请求返回前不能参与新账号的基线或展示。
  const staleSessions = ref<ChatSession[] | null>(null)
  const foreground = ref(document.visibilityState !== 'hidden')
  const updateVisibility = () => { foreground.value = document.visibilityState !== 'hidden' }
  document.addEventListener('visibilitychange', updateVisibility)
  onScopeDispose(() => document.removeEventListener('visibilitychange', updateVisibility))
  // 版本化缓存，迁移掉首次上线时由缺失字段错误建立的零基线。
  const storageKey = computed(() => options.accountId.value ? `gugu:web-session-read:v1:${options.accountId.value}` : null)
  watch(storageKey, (key, previous) => {
    if (previous !== undefined && key !== previous) staleSessions.value = options.sessions.value
    readVersions.value = {}
    if (!key) return
    try {
      localStorage.removeItem(`gugu:web-session-read:${options.accountId.value}`)
      const saved = JSON.parse(localStorage.getItem(key) || '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        readVersions.value = Object.fromEntries(Object.entries(saved)
          .filter(([, version]) => Number.isSafeInteger(version) && Number(version) >= 0)) as Record<string, number>
      }
    } catch { /* 本机缓存损坏时按首次使用建立基线，不推断历史未读。 */ }
  }, { immediate: true, flush: 'sync' })

  watch([options.sessions, options.sessionId, options.visible, foreground, storageKey], () => {
    if (!storageKey.value) return
    if (staleSessions.value === options.sessions.value) return
    staleSessions.value = null
    const next = { ...readVersions.value }
    for (const session of options.sessions.value) {
      if (session.source && session.source !== 'web') continue
      // 旧服务、更新中的缓存和无版本响应不具备建立已读基线的资格。
      if (!Number.isSafeInteger(session.lastAssistantId) || Number(session.lastAssistantId) < 0) continue
      const version = session.lastAssistantId!
      const viewing = options.visible.value && foreground.value && session.id === options.sessionId.value
      if (next[session.id] === undefined || viewing) next[session.id] = Math.max(next[session.id] ?? 0, version)
    }
    readVersions.value = next
    try { localStorage.setItem(storageKey.value, JSON.stringify(next)) } catch { /* 禁止存储时仍保留当前页面状态。 */ }
  }, { immediate: true })

  return computed<Record<number, 'running' | 'unread'>>(() => {
    const result: Record<number, 'running' | 'unread'> = {}
    if (!options.accountId.value || staleSessions.value === options.sessions.value) return result
    for (const session of options.sessions.value) {
      if (session.source && session.source !== 'web') continue
      if (session.isRunning) result[session.id] = 'running'
      else if ((session.lastAssistantId ?? 0) > (readVersions.value[session.id] ?? session.lastAssistantId ?? 0)) {
        result[session.id] = 'unread'
      }
    }
    return result
  })
}
