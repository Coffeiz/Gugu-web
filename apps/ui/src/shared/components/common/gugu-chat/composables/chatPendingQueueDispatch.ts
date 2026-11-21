export interface PendingQueueDispatchItem {
  key: number
  queueId: string
  sessionId: number | null
  viewGeneration: number
}

/**
 * 先确认队列项已持久化，再通过服务端租约抢占派发权。
 * 尚未绑定 session 的草稿队列按标签隔离，不需要跨浏览器认领。
 */
export async function dispatchPendingQueueItem<T extends PendingQueueDispatchItem>(
  queueId: string,
  key: number,
  options: {
    findItem: (queueId: string, key: number) => T | undefined
    persist: (item: T) => Promise<void>
    claim: (item: T) => Promise<string | null>
    release: (item: T, claimToken: string) => Promise<void>
    dispatch: (item: T, claimToken: string | null) => Promise<void>
    isCancelled: (item: T) => boolean
    onPersistError?: (error: unknown) => void
    onDispatchError?: (error: unknown) => void
  },
): Promise<boolean> {
  const initial = options.findItem(queueId, key)
  if (!initial) return false
  try {
    await options.persist(initial)
  } catch (error) {
    options.onPersistError?.(error)
    throw error
  }
  if (options.isCancelled(initial)) return false

  const claimToken = initial.sessionId == null ? null : await options.claim(initial)
  if (initial.sessionId != null && !claimToken) return false
  if (options.isCancelled(initial)) {
    if (claimToken) await options.release(initial, claimToken)
    return false
  }

  try {
    await options.dispatch(initial, claimToken)
  } catch (error) {
    // 请求是否已被后端接收可能不确定。保留租约到期，避免网络断开后另一标签重复发送。
    options.onDispatchError?.(error)
    throw error
  }
  return true
}
