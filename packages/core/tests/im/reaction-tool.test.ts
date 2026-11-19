import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../../src/agent/tools/registry.js'
import type { ToolScope } from '../../src/agent/tools/contracts.js'
import { createImReactionTools } from '../../src/im/reaction-tool.js'

const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
const scope = (): ToolScope => ({ identity, roundId: 'round-a', signal: new AbortController().signal, execute: vi.fn(), resolution: null })

describe('平台reaction真实注册与执行边界', () => {
  it('QQ/微信/Telegram不向模型注册react Schema，飞书缺能力时明确拒绝装配', async () => {
    for (const platform of ['qq', 'wechat', 'telegram'] as const) {
      const registry = createToolRegistry({ tools: createImReactionTools(platform), authorize: async () => true })
      expect(await registry.capabilities(identity)).toEqual([])
      expect(await registry.tools.dispatch({ id: 'call-a', name: 'react', input: { mood: 'love' } }, scope()))
        .toMatchObject({ successful: false, executed: false })
    }
    expect(() => createImReactionTools('feishu')).toThrow('能力未配置')
  })

  it('飞书经现有registry规范化mood并仅把可信运行绑定及映射emoji交给Host', async () => {
    const react = vi.fn(async () => 'accepted' as const)
    const registry = createToolRegistry({ tools: createImReactionTools('feishu', { react, recover: async () => 'unknown' }), authorize: async () => true })
    expect((await registry.capabilities(identity)).map(tool => tool.name)).toEqual(['react'])
    const result = await registry.tools.dispatch({ id: 'call-a', name: 'react', input: { mood: ' LOVE ', ownerId: 'owner-b', botId: 'bot-b' } }, scope())
    expect(result).toMatchObject({ successful: true, mutated: true })
    expect(react).toHaveBeenCalledWith({ identity, roundId: 'round-a', toolCallId: 'call-a', emoji: 'HEART', signal: expect.any(AbortSignal) })
    expect(react).toHaveBeenCalledTimes(1)
  })

  it('权限撤销使已发现工具不能执行；未知恢复只查询收据不重复表情', async () => {
    let allowed = true
    const react = vi.fn(async () => 'unknown' as const)
    const recover = vi.fn(async () => 'unknown' as const)
    const registry = createToolRegistry({ tools: createImReactionTools('feishu', { react, recover }), authorize: async () => allowed })
    expect(await registry.capabilities(identity)).toHaveLength(1)
    allowed = false
    const call = { id: 'call-a', name: 'react', input: { mood: 'ok' } }
    expect(await registry.tools.dispatch(call, scope())).toMatchObject({ executed: false, successful: false })
    expect(react).not.toHaveBeenCalled()
    allowed = true
    expect(await registry.tools.dispatch(call, scope())).toEqual({ kind: 'unknown' })
    expect(await registry.tools.reconcile(call, { ...identity, roundId: 'round-a' })).toEqual({ kind: 'unknown' })
    expect(react).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('非法mood不调用平台；明确拒绝返回安全业务结果', async () => {
    const react = vi.fn(async () => 'rejected' as const)
    const registry = createToolRegistry({ tools: createImReactionTools('feishu', { react, recover: async () => 'rejected' }), authorize: async () => true })
    expect(await registry.tools.dispatch({ id: 'invalid', name: 'react', input: { mood: 'unknown-mood' } }, scope()))
      .toMatchObject({ successful: false, executed: false })
    expect(react).not.toHaveBeenCalled()
    expect(await registry.tools.dispatch({ id: 'valid', name: 'react', input: { mood: 'ok' } }, scope()))
      .toMatchObject({ successful: false, mutated: false, value: { ok: false } })
  })
})
