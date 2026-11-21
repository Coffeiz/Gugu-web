const QUEUE_ID_STORAGE_KEY = 'gugu-chat-pending-queue-id-v1'
const QUEUE_RECOVERY_STORAGE_KEY = 'gugu-chat-pending-queue-recovery-v1'
/** 正式队列由会话 ID 唯一确定，各浏览器自然读写同一条队列。 */
export function getSessionPendingQueueId(sessionId: number): string {
  return `session-${sessionId}`
}

/** 新会话尚未获得服务端 session_id 时，用标签级 ID 暂存并恢复草稿队列。 */
export function getDraftPendingQueueId(): string {
  try {
    if (typeof window === 'undefined') return 'server-rendered'
    const existing = window.sessionStorage.getItem(QUEUE_ID_STORAGE_KEY)
    if (existing) return existing
    const value = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`
    window.sessionStorage.setItem(QUEUE_ID_STORAGE_KEY, value)
    return value
  } catch {
    return `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/** 队列 key 需要跨页面实例唯一，避免不同浏览器都从 1 开始后覆盖彼此的消息。 */
export function createPendingQueueKey(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const words = new Uint32Array(2)
    crypto.getRandomValues(words)
    const key = (words[0] & 0x1fffff) * 0x100000000 + words[1]
    return key || 1
  }
  return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

/** 只存恢复标记，不在浏览器存队列正文；正文始终以服务端为准。 */
export function setPendingQueueRecoveryNeeded(needed: boolean): void {
  try {
    if (typeof window === 'undefined') return
    if (needed) window.sessionStorage.setItem(QUEUE_RECOVERY_STORAGE_KEY, '1')
    else window.sessionStorage.removeItem(QUEUE_RECOVERY_STORAGE_KEY)
  } catch {
    // sessionStorage 不可用时仍可通过启动时的一次服务端读取恢复。
  }
}

export function isPendingQueueRecoveryNeeded(): boolean {
  try {
    return typeof window !== 'undefined'
      && window.sessionStorage.getItem(QUEUE_RECOVERY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
