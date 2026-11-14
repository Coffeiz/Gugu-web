import { describe, expect, it, vi } from 'vitest'
import { restoreStartupSession } from '@/components/common/gugu-chat/composables/startupSessionRestore'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('启动会话恢复', () => {
  it('恢复会话被后续导航取代时保留新会话消息和恢复记录', async () => {
    const recovery = deferred<'loaded' | 'superseded' | 'unavailable' | 'failed'>()
    const messages = ['会话 B 的消息']
    const recoveryRecord = { sessionId: 202 }
    const onUnavailable = vi.fn(() => {
      messages.splice(0, messages.length, '默认问候')
      delete (recoveryRecord as { sessionId?: number }).sessionId
    })
    const onFailure = vi.fn()

    const pendingRestore = restoreStartupSession({
      loadSession: () => recovery.promise,
      onUnavailable,
      onFailure,
    })

    // 用户已导航到 B；A 的过期加载随后返回“已被新视图取代”。
    recovery.resolve('superseded')
    await pendingRestore

    expect(messages).toEqual(['会话 B 的消息'])
    expect(recoveryRecord.sessionId).toBe(202)
    expect(onUnavailable).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('明确找不到恢复会话时才清除恢复记录并回到默认问候', async () => {
    const onUnavailable = vi.fn()
    const onFailure = vi.fn()

    await restoreStartupSession({
      loadSession: async () => 'unavailable',
      onUnavailable,
      onFailure,
    })

    expect(onUnavailable).toHaveBeenCalledOnce()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('临时加载失败保留恢复记录，不伪装成新对话', async () => {
    const onUnavailable = vi.fn()
    const onFailure = vi.fn()

    await restoreStartupSession({
      loadSession: async () => 'failed',
      onUnavailable,
      onFailure,
    })

    expect(onUnavailable).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledOnce()
  })
})
