import { describe, expect, it, vi } from 'vitest'
import { dispatchPendingQueueItem } from './chatPendingQueueDispatch'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve: () => resolve() }
}

describe('待发消息跨端派发', () => {
  it('持久化期间切换会话仍按队列项归属派发并携带认领令牌', async () => {
    const persistStarted = deferred()
    const persistGate = deferred()
    let sessionId: number | null = 41
    const item = { key: 9, queueId: 'shared', sessionId: 41, viewGeneration: 4 }
    const dispatch = vi.fn(async (value: typeof item, token: string | null) => {
      expect(value.sessionId).toBe(41)
      expect(token).toBe('claim-token')
      expect(sessionId).toBe(52)
    })

    const draining = dispatchPendingQueueItem('shared', 9, {
      findItem: (queueId, key) => queueId === 'shared' && key === 9 ? item : undefined,
      persist: async () => {
        persistStarted.resolve()
        await persistGate.promise
      },
      claim: async () => 'claim-token',
      release: vi.fn(async () => {}),
      dispatch,
      isCancelled: () => false,
    })

    await persistStarted.promise
    sessionId = 52
    persistGate.resolve()

    await expect(draining).resolves.toBe(true)
    expect(dispatch).toHaveBeenCalledWith(item, 'claim-token')
  })

  it('没有拿到服务端认领权时不会重复派发', async () => {
    const dispatch = vi.fn(async () => {})
    const item = { key: 10, queueId: 'shared', sessionId: 41, viewGeneration: 4 }

    await expect(dispatchPendingQueueItem('shared', 10, {
      findItem: () => item,
      persist: vi.fn(async () => {}),
      claim: vi.fn(async () => null),
      release: vi.fn(async () => {}),
      dispatch,
      isCancelled: () => false,
    })).resolves.toBe(false)

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('认领后若用户移除消息就释放认领权，不再发送', async () => {
    const item = { key: 11, queueId: 'shared', sessionId: 41, viewGeneration: 4 }
    const release = vi.fn(async () => {})
    const dispatch = vi.fn(async () => {})
    let cancelled = false

    await expect(dispatchPendingQueueItem('shared', 11, {
      findItem: () => item,
      persist: vi.fn(async () => {}),
      claim: vi.fn(async () => 'claim-token'),
      release,
      dispatch,
      isCancelled: () => {
        if (!cancelled) {
          cancelled = true
          return false
        }
        return true
      },
    })).resolves.toBe(false)

    expect(release).toHaveBeenCalledWith(item, 'claim-token')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('尚未绑定会话的草稿不执行跨浏览器认领', async () => {
    const item = { key: 12, queueId: 'draft-tab', sessionId: null, viewGeneration: 4 }
    const claim = vi.fn(async () => 'unused')
    const dispatch = vi.fn(async (_item: typeof item, token: string | null) => expect(token).toBeNull())

    await expect(dispatchPendingQueueItem('draft-tab', 12, {
      findItem: () => item,
      persist: vi.fn(async () => {}),
      claim,
      release: vi.fn(async () => {}),
      dispatch,
      isCancelled: () => false,
    })).resolves.toBe(true)

    expect(claim).not.toHaveBeenCalled()
  })
})
