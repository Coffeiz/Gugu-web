import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { CanonicalMessage,ContextDataPorts,ContextServices } from "../../../src/agent/index.js"
import { MessageArea,buildOwnerReflectionInput,loadContextData,stableJson } from "../../../src/agent/index.js"
const identity = { ownerId: 'owner', sessionId: 'session', accessScopeHash: 'scope-owner' }
const user = (content: string): CanonicalMessage => ({ role: 'user', content })
function services(): ContextServices {
  let id = 0
  return { nextId: () => `id-${++id}`, digest: value => createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16) }
}
function dataPorts(events: string[]): ContextDataPorts {
  return {
    loadTimezone: async () => { events.push('timezone'); return 'Asia/Shanghai' },
    loadProjects: async () => { events.push('projects'); return [] }, loadEvents: async () => { events.push('events'); return [] },
    loadNotes: async () => { events.push('notes'); return [] }, loadFilesOverview: async () => { events.push('files'); return {} },
    loadStylePreferences: async () => { events.push('style'); return {} }, loadImChannels: async () => { events.push('channels'); return {} },
    loadMemory: async () => { events.push('memory'); return {} }, loadImMemory: async () => { events.push('im-memory'); return {} },
    loadKnowledge: async () => { events.push('knowledge'); return [] }
  }
}
describe('可信上下文读取策略与并发边界', () => {
  it('受限群成员不调用任何owner项目/文件/记忆/渠道源，只保留时区和scope记忆', async () => {
    const events: string[] = [], data = await loadContextData(identity, { loadOwnerContext: false, memoryEnabled: true }, dataPorts(events))
    expect(events).toEqual(['timezone', 'im-memory'])
    expect(data.projects).toEqual([]); expect(data.memory).toEqual({}); expect(data.imChannels).toEqual({})
    expect(data.userTimezone).toBe('Asia/Shanghai')
  })
  it('串行使用同一DB session，辅助源与它并发且在返回前全部完成', async () => {
    const events: string[] = [], ports = dataPorts(events)
    let activeDb = 0, maxDb = 0, finishMemory!: () => void
    const waitMemory = new Promise<void>(resolve => { finishMemory = resolve })
    ports.loadMemory = async () => { events.push('memory-start'); await waitMemory; events.push('memory-end'); return { summary: '合成记忆' } }
    for (const field of ['loadProjects', 'loadNotes', 'loadFilesOverview', 'loadStylePreferences', 'loadImChannels'] as const) {
      ports[field] = async () => { activeDb++; maxDb = Math.max(maxDb, activeDb); await Promise.resolve(); activeDb--; events.push(field); return [] }
    }
    const pending = loadContextData(identity, { loadOwnerContext: true, memoryEnabled: true }, ports)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(events).toContain('memory-start'); expect(events).not.toContain('memory-end')
    finishMemory()
    const data = await pending
    expect(maxDb).toBe(1); expect(data.memory).toEqual({ summary: '合成记忆' }); expect(events).toContain('memory-end')
    expect(events.filter(event => event.startsWith('load'))).toEqual(['loadProjects', 'loadNotes', 'loadFilesOverview', 'loadStylePreferences', 'loadImChannels'])
  })
  it('DB失败主动取消并收束辅助任务，不遗留后台读取或吞掉原始错误', async () => {
    const events: string[] = [], ports = dataPorts(events)
    const awaitCancel = async (_identity: unknown, signal?: AbortSignal): Promise<never> => {
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }) })
      events.push('aux-drained'); throw signal?.reason
    }
    ports.loadMemory = awaitCancel; ports.loadImMemory = awaitCancel; ports.loadKnowledge = awaitCancel
    ports.loadProjects = async () => { throw new Error('合成DB读取失败') }
    await expect(loadContextData(identity, { loadOwnerContext: true, memoryEnabled: true }, ports)).rejects.toThrow('合成DB读取失败')
    expect(events.filter(event => event === 'aux-drained')).toHaveLength(3)
  })
  it('memory开关关闭不读长期记忆，辅助源失败不能当空数据返回', async () => {
    const events: string[] = [], ports = dataPorts(events)
    await loadContextData(identity, { loadOwnerContext: true, memoryEnabled: false }, ports)
    expect(events).not.toContain('memory')
    ports.loadKnowledge = async () => { throw new Error('合成资料源失败') }
    await expect(loadContextData(identity, { loadOwnerContext: true, memoryEnabled: false }, ports)).rejects.toThrow('合成资料源失败')
  })
})
describe('群聊个人记忆证据', () => {
  it('owner群反思只提取当前owner输入与私人工具结果，不吸收群用户或助手回复', () => {
    const area = new MessageArea(services(), [])
    area.append(user('其他群成员发言'), { source: 'user' })
    area.append({ role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '私人工具结果' }] }, { source: 'tool_round' })
    const result = buildOwnerReflectionInput({ ownerMessage: 'owner原文', groupChat: true, reply: '群聊助手回复不用于owner记忆' }, area)
    expect(result).toEqual({ userMessage: 'owner原文', assistantEvidence: '私人工具结果' })
    expect(buildOwnerReflectionInput({ ownerMessage: '私聊', groupChat: false, reply: '私聊回复' }, area).assistantEvidence).toBe('私聊回复')
  })
})
