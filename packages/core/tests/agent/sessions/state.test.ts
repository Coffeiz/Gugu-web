import { describe, expect, it, vi } from 'vitest'
import { createAgentSessionStateReader } from '../../../src/agent/sessions/state.js'

describe('Agent 会话状态读取', () => {
  it('先校验 owner，再恢复孤儿并刷新状态，最后读取运行态', async () => {
    const calls: string[] = []
    const read = vi.fn(async (ownerId: string, sessionId: number) => {
      calls.push(`read:${ownerId}:${sessionId}`)
      return { executionState: calls.length === 1 ? 'running' : 'idle', pendingMessageCount: 2 }
    })
    const recover = vi.fn(async (ownerId: string, sessionId: number) => { calls.push(`recover:${ownerId}:${sessionId}`) })
    const isActive = vi.fn(async (sessionId: number) => { calls.push(`active:${sessionId}`); return false })
    const readState = createAgentSessionStateReader({ read, recover, isActive })

    const ownerId = '00000000-0000-4000-8000-000000000099'
    await expect(readState(ownerId, 42)).resolves.toEqual({ executionState: 'idle', pendingMessageCount: 2, active: false })
    expect(calls).toEqual([`read:${ownerId}:42`, `recover:${ownerId}:42`, `read:${ownerId}:42`, 'active:42'])
  })

  it('owner 不存在时不触发恢复或 Redis 状态查询', async () => {
    const recover = vi.fn()
    const isActive = vi.fn()
    const readState = createAgentSessionStateReader({ read: async () => null, recover, isActive })

    await expect(readState('00000000-0000-4000-8000-000000000099', 42)).resolves.toBeNull()
    expect(recover).not.toHaveBeenCalled()
    expect(isActive).not.toHaveBeenCalled()
  })
})
