import { describe, expect, it } from 'vitest'
import { runChatNavigation, type ChatNavigationRequest } from '@/components/common/gugu-chat/composables/chatNavigation'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('聊天消息导航请求竞态', () => {
  it('旧会话导航完成等待时不清除或定位更新的导航请求', async () => {
    let currentRequestId = 0
    let currentSessionId: number | null = null
    let pending: ChatNavigationRequest | null = null
    const events: string[] = []
    const layoutStarted = new Map<number, ReturnType<typeof deferred>>()
    const layoutReady = new Map<number, ReturnType<typeof deferred>>()

    const navigate = (request: ChatNavigationRequest) => runChatNavigation(request, {
      isCurrent: (requestId) => requestId === currentRequestId,
      open: () => events.push(`open:${request.requestId}`),
      mount: async () => {},
      loadSession: async (sessionId) => { currentSessionId = sessionId },
      waitForSessionSettlement: async () => {},
      waitForStableScrollLayout: () => {
        layoutStarted.get(request.requestId)!.resolve()
        return layoutReady.get(request.requestId)!.promise
      },
      currentSessionId: () => currentSessionId,
      clear: (requestId) => {
        if (requestId !== currentRequestId || pending?.requestId !== requestId) return false
        pending = null
        events.push(`clear:${requestId}`)
        return true
      },
      reveal: async (messageId) => { events.push(`reveal:${messageId}`); return true },
      flash: (messageId) => events.push(`flash:${messageId}`),
      showUnavailable: () => events.push(`unavailable:${request.requestId}`),
    })

    const first: ChatNavigationRequest = { requestId: 1, sessionId: 101, messageId: 1001 }
    const second: ChatNavigationRequest = { requestId: 2, sessionId: 202, messageId: 2002 }
    for (const request of [first, second]) {
      layoutStarted.set(request.requestId, deferred())
      layoutReady.set(request.requestId, deferred())
    }

    currentRequestId = first.requestId
    pending = first
    const firstRun = navigate(first)
    await layoutStarted.get(first.requestId)!.promise

    currentRequestId = second.requestId
    pending = second
    const secondRun = navigate(second)
    await layoutStarted.get(second.requestId)!.promise

    layoutReady.get(first.requestId)!.resolve()
    await firstRun
    expect(pending).toEqual(second)
    expect(events).not.toContain('clear:1')
    expect(events).not.toContain('reveal:1001')

    layoutReady.get(second.requestId)!.resolve()
    await secondRun
    expect(pending).toBeNull()
    expect(events).toContain('clear:2')
    expect(events).toContain('reveal:2002')
    expect(events).toContain('flash:2002')
    expect(events).not.toContain('unavailable:1')
  })
})
