import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { CanonicalMessage,ContextDataPorts,ContextServices,PassiveGroupTailPorts,PersistedHistoryRow,ReflectionProjectionPort,ReflectionRecoveryPorts,ReflectionSnapshot } from "../../../../src/agent/harness/index.js"
import { MessageArea,ReflectionSnapshots,buildOwnerReflectionInput,buildRebuiltReflectionSnapshot,extendGroupReflectionSnapshot,loadContextData,prepareReflectionSnapshot,reflectionEligibility,stableJson } from "../../../../src/agent/harness/index.js"
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
describe('反思输入、资格与群被动尾部', () => {
  const projectionPort: ReflectionProjectionPort<CanonicalMessage[]> = { append: (projection, tail) => ({ ...projection, wire: [...projection.wire, ...structuredClone(tail)], dynamicTailSize: 0 }) }
  function fixture(): { snapshot: ReflectionSnapshot<CanonicalMessage[]>; services: ContextServices; area: MessageArea } {
    const service = services(), area = new MessageArea(service, [{ ...user('主Run用户原文'), _history_id: '1' }])
    const snapshots = new ReflectionSnapshots<CanonicalMessage[]>(service, () => 0)
    const snapshot = snapshots.capture({
      ...identity, runId: 'main-run', modelIdentity: 'model', area,
      projection: { ...area.identity('model'), wire: area.messages, dynamicTailSize: 0 }, replyText: '主Run收尾', systemPrompt: '人格', tools: [], providerContextInput: 85
    }, projectionPort)!
    return { snapshot, services: service, area }
  }
  function row(id: number, extra: Partial<PersistedHistoryRow> = {}): PersistedHistoryRow {
    return { ...identity, id: String(id), conversationSeq: id, role: 'user', content: `群消息${id}`, senderId: 'member', ...extra }
  }
  function tailPorts(rows: PersistedHistoryRow[]): PassiveGroupTailPorts<CanonicalMessage[]> {
    return {
      ...projectionPort, ownsGroupSession: async () => true, readTail: async () => rows,
      renderTail: async values => values.map(value => user(String(value.content)))
    }
  }
  it('普通群/成员共用主快照原始前缀，只追加按事件时间排序的被动用户消息，usage变未知', async () => {
    const { snapshot, services: service } = fixture()
    const rows = [row(3, { platformSentMs: 3000 }), row(2, { platformSentMs: 2000 })], port = tailPorts(rows)
    const before = structuredClone(snapshot)
    const extended = await extendGroupReflectionSnapshot(snapshot, { ...identity, modelIdentity: 'model', taskRows: rows, throughMessageId: '3' }, port, service)
    expect(extended!.projection.wire).toEqual([...snapshot.projection.wire, user('群消息2'), user('群消息3')])
    expect(extended!.source).toBe('in_memory_extended'); expect(extended!.providerContextInput).toBeNull()
    expect(snapshot).toEqual(before)
  })
  it.each([{ runId: 'different-run' }, { ownerId: 'foreign' }])('尾部出现其他run/owner时拒绝复用%j', async extra => {
    const { snapshot, services: service } = fixture(), rows = [row(2, extra)]
    expect(await extendGroupReflectionSnapshot(snapshot, { ...identity, modelIdentity: 'model', taskRows: rows }, tailPorts(rows), service)).toBeNull()
  })
  it('任务包含无法证明覆盖的旧行或会话绑定已变更，等待新快照', async () => {
    const { snapshot, services: service } = fixture(), port = tailPorts([row(2)])
    expect(await extendGroupReflectionSnapshot(snapshot, { ...identity, modelIdentity: 'model', taskRows: [row(0)] }, port, service)).toBeNull()
    port.ownsGroupSession = async () => false
    expect(await extendGroupReflectionSnapshot(snapshot, { ...identity, modelIdentity: 'model', taskRows: [row(2)] }, port, service)).toBeNull()
  })
  it('资格校验跨session/model，压力只依据同快照实际85%输入且压缩后不重复触发', () => {
    const { snapshot } = fixture()
    const input = { ...identity, modelIdentity: 'model', bufferedSessionIds: ['session'], scope: 'group' as const, contextWindow: 100, reason: 'idle' as const }
    expect(reflectionEligibility(input, snapshot)).toEqual({ mode: 'reuse', reason: 'eligible', compactBeforeReflection: true })
    expect(reflectionEligibility(input, { ...snapshot, providerCompacted: true }).compactBeforeReflection).toBe(false)
    expect(reflectionEligibility(input, { ...snapshot, providerContextInput: null }).compactBeforeReflection).toBe(false)
    expect(reflectionEligibility({ ...input, bufferedSessionIds: ['other'] }, snapshot).mode).toBe('defer')
    expect(reflectionEligibility({ ...input, modelIdentity: 'other' }, snapshot).reason).toBe('provider_switched')
    expect(reflectionEligibility({ ...input, scope: 'owner' }, null).mode).toBe('defer')
    expect(reflectionEligibility({ ...input, scope: 'owner', ownerIdleRebuildAuthorized: true }, null).mode).toBe('rebuild')
  })
  it('跨actor访问binding不能复用owner快照，group/member同主访问binding允许共享', async () => {
    const { snapshot, services: service } = fixture()
    const input = { ...identity, modelIdentity: 'model', bufferedSessionIds: ['session'], contextWindow: 100, reason: 'idle' as const }
    expect(reflectionEligibility({ ...input, scope: 'member', accessScopeHash: 'scope-member' }, snapshot).reason).toBe('access_scope_mismatch')
    expect(reflectionEligibility({ ...input, scope: 'member', accessScopeHash: undefined }, snapshot).mode).toBe('defer')
    expect(reflectionEligibility({ ...input, scope: 'group' }, snapshot).mode).toBe('reuse')
    expect(reflectionEligibility({ ...input, scope: 'member' }, snapshot).mode).toBe('reuse')
    expect(await extendGroupReflectionSnapshot(snapshot, { ...identity, accessScopeHash: 'scope-member', modelIdentity: 'model', taskRows: [row(2)] }, tailPorts([row(2)]), service)).toBeNull()
  })
  it('显式owner idle重建仍须核验Data当前访问binding，不能从旧owner scope恢复新member请求', async () => {
    const { snapshot } = fixture(), events: string[] = []
    const ports: ReflectionRecoveryPorts<CanonicalMessage[]> = {
      readSession: async () => ({ ...identity, accessScopeHash: 'old-owner-binding', executionState: 'idle', pendingMessageCount: 0 }),
      acquire: async () => { events.push('acquire'); return 'lease' }, release: async () => { }, compactBaseline: async () => 'not_needed',
      rebuild: async () => { events.push('rebuild'); return snapshot }
    }
    const result = await prepareReflectionSnapshot({
      ...identity, accessScopeHash: 'new-access-binding', modelIdentity: 'model', bufferedSessionIds: ['session'], scope: 'owner',
      contextWindow: 100, reason: 'idle', allowOwnerIdleRebuild: true
    }, null, ports)
    expect(result.status).toBe('deferred'); expect(result.reason).toBe('session_not_owned_idle'); expect(events).toEqual([])
  })
  it('owner无快照默认defer，只有显式闲置重建且owned idle无pending、持有租约才恢复', async () => {
    const { snapshot } = fixture(), events: string[] = []
    const input = { ...identity, modelIdentity: 'model', bufferedSessionIds: ['session'], scope: 'owner' as const, contextWindow: 100, reason: 'idle' as const }
    const ports: ReflectionRecoveryPorts<CanonicalMessage[]> = {
      readSession: async () => ({ ...identity, executionState: 'idle', pendingMessageCount: 0 }),
      acquire: async () => { events.push('acquire'); return 'lease' }, release: async () => { events.push('release') },
      rebuild: async () => { events.push('rebuild'); return snapshot }, compactBaseline: async () => 'not_needed'
    }
    expect((await prepareReflectionSnapshot(input, null, ports)).status).toBe('deferred'); expect(events).toEqual([])
    const rebuilt = await prepareReflectionSnapshot({ ...input, allowOwnerIdleRebuild: true }, null, ports)
    expect(rebuilt.status).toBe('ready'); expect(events).toEqual(['acquire', 'rebuild', 'release'])
    ports.readSession = async () => ({ ...identity, executionState: 'running', pendingMessageCount: 0 })
    expect((await prepareReflectionSnapshot({ ...input, allowOwnerIdleRebuild: true }, null, ports)).status).toBe('deferred')
  })
  it('持久历史重建保留Provider投影边界，不凭空追加assistant或声称主请求usage', () => {
    const { area, services: service } = fixture()
    const rebuilt = buildRebuiltReflectionSnapshot({
      ...identity, modelIdentity: 'model', systemPrompt: '人格', area,
      projection: { ...area.identity('model'), wire: area.messages, dynamicTailSize: 0 }
    }, projectionPort, service, 0)
    expect(rebuilt.source).toBe('persisted_history'); expect(rebuilt.runId).toBe('idle')
    expect(rebuilt.projection.wire).toEqual(area.messages); expect(rebuilt.providerContextInput).toBeNull()
    expect(rebuilt.persistedMessageIds).toEqual(['1'])
  })
  it('反思pressure先压正式baseline后重建，不继续用旧wire；失败/blocked释放租约', async () => {
    const { snapshot } = fixture(), events: string[] = []
    const ports: ReflectionRecoveryPorts<CanonicalMessage[]> = {
      readSession: async () => ({ ...identity, executionState: 'idle', pendingMessageCount: 0 }),
      acquire: async () => 'lease', release: async () => { events.push('release') },
      compactBaseline: async () => { events.push('compact'); return 'compacted' },
      rebuild: async () => { events.push('rebuild'); return { ...snapshot, providerCompacted: true } }
    }
    const input = { ...identity, modelIdentity: 'model', bufferedSessionIds: ['session'], scope: 'owner' as const, contextWindow: 100, reason: 'idle' as const }
    expect((await prepareReflectionSnapshot(input, snapshot, ports)).reason).toBe('persisted_history_rebuilt')
    expect(events).toEqual(['compact', 'rebuild', 'release'])
    events.length = 0; ports.compactBaseline = async () => 'blocked'
    expect((await prepareReflectionSnapshot(input, snapshot, ports)).status).toBe('blocked')
    expect(events).toEqual(['release'])
  })
  it('被动群尾部授权或空tail读取期间取消，不继续IO也不能成功回旧prefix', async () => {
    for (const phase of ['ownership', 'tail'] as const) {
      const { snapshot, services: service } = fixture(), controller = new AbortController(), port = tailPorts([])
      let reads = 0
      port.ownsGroupSession = async () => { if (phase === 'ownership') controller.abort(); return true }
      port.readTail = async () => { reads++; controller.abort(); return [] }
      await expect(extendGroupReflectionSnapshot(snapshot, { ...identity, modelIdentity: 'model', taskRows: [] }, port, service, controller.signal)).rejects.toThrow()
      expect(reads).toBe(phase === 'ownership' ? 0 : 1)
    }
  })
  it('pressure的not_needed异步返回若已取消仍拒绝且释放lease；84%不触发压缩', async () => {
    const { snapshot } = fixture(), controller = new AbortController(), events: string[] = []
    const ports: ReflectionRecoveryPorts<CanonicalMessage[]> = {
      readSession: async () => ({ ...identity, executionState: 'idle', pendingMessageCount: 0 }),
      acquire: async () => 'lease', release: async () => { events.push('release') },
      compactBaseline: async () => { events.push('compact'); controller.abort(); return 'not_needed' }, rebuild: async () => { events.push('rebuild'); return snapshot }
    }
    const input = { ...identity, modelIdentity: 'model', bufferedSessionIds: ['session'], scope: 'owner' as const, contextWindow: 100, reason: 'idle' as const }
    expect((await prepareReflectionSnapshot(input, { ...snapshot, providerContextInput: 84 }, ports)).status).toBe('ready')
    expect(events).toEqual([])
    await expect(prepareReflectionSnapshot(input, snapshot, ports, controller.signal)).rejects.toThrow()
    expect(events).toEqual(['compact', 'release'])
  })
  it('owner群反思只提取当前owner输入与私人工具结果，不吸收群用户或助手回复', () => {
    const { area } = fixture()
    area.append(user('其他群成员发言'), { source: 'user' })
    area.append({ role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '私人工具结果' }] }, { source: 'tool_round' })
    const result = buildOwnerReflectionInput({ ownerMessage: 'owner原文', groupChat: true, reply: '群聊助手回复不用于owner记忆' }, area)
    expect(result).toEqual({ userMessage: 'owner原文', assistantEvidence: '私人工具结果' })
    expect(buildOwnerReflectionInput({ ownerMessage: '私聊', groupChat: false, reply: '私聊回复' }, area).assistantEvidence).toBe('私聊回复')
  })
})
