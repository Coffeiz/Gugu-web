import { describe, expect, it } from 'vitest'
import { agentContextPolicy } from '../../../src/agent/context/source-policy.js'

describe('agentContextPolicy', () => {
  it('仅将可信 IM member 和 unknown 限制为自身上下文，并保留 owner 连续能力', () => {
    expect(agentContextPolicy({ source: 'web', imRole: 'member', memoryEnabled: true })).toEqual({
      isIm: false, restricted: false, loadOwnerContext: true, memoryEnabled: true,
      allowContinuityBridge: false, allowMemoryReflection: true,
    })
    expect(agentContextPolicy({ source: 'qq', actorContext: { role: 'member' }, imRole: 'owner', memoryEnabled: true })).toEqual({
      isIm: true, restricted: true, loadOwnerContext: false, memoryEnabled: true,
      allowContinuityBridge: false, allowMemoryReflection: false,
    })
    expect(agentContextPolicy({ source: 'feishu', actorContext: { role: 'unknown' }, memoryEnabled: true })).toEqual({
      isIm: true, restricted: true, loadOwnerContext: false, memoryEnabled: true,
      allowContinuityBridge: false, allowMemoryReflection: false,
    })
    expect(agentContextPolicy({ source: 'telegram', actorContext: { role: 'owner' }, memoryEnabled: true })).toEqual({
      isIm: true, restricted: false, loadOwnerContext: true, memoryEnabled: true,
      allowContinuityBridge: true, allowMemoryReflection: true,
    })
  })

  it('旧载荷没有 actorContext 时才读取 imRole，非 IM 来源始终按 owner 策略处理', () => {
    const restricted = agentContextPolicy({ source: 'wechat', actorContext: null, imRole: 'unknown', memoryEnabled: false })
    expect(restricted).toMatchObject({ restricted: true, loadOwnerContext: false, memoryEnabled: false })
    expect(agentContextPolicy({ source: 'qq', actorContext: { role: null }, imRole: 'member', memoryEnabled: true }).restricted).toBe(false)
    expect(agentContextPolicy({ source: 'scheduled_task', imRole: 'unknown', memoryEnabled: true })).toEqual({
      isIm: false, restricted: false, loadOwnerContext: true, memoryEnabled: true,
      allowContinuityBridge: false, allowMemoryReflection: true,
    })
  })
})
