import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { CanonicalRunPreparationPorts,ContextSourcePorts,Json,PreparationPorts,SessionSnapshotState } from "../../../../src/agent/harness/index.js"
import { createCanonicalRunLoader,createCanonicalSourceLoader,prepareContext,prepareRunContextSources,stableJson } from "../../../../src/agent/harness/index.js"
const identity = { ownerId: 'owner', sessionId: 'session', runId: 'run' }
function fixture() {
  let id = 0, now = 0, builds = 0, ragCalls = 0
  const events: string[] = []
  let stored: SessionSnapshotState = { ...identity, contextEpoch: 0, context: null, snapshotExpiresAt: null, baselineMessageSeq: 0, snapshotHash: null, sessionInfoHash: null }
  const services = { digest: (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex'), nextId: () => `entry-${++id}` }
  const ports: ContextSourcePorts = {
    ...services, now: () => now,
    readSnapshot: async () => { events.push('owned-snapshot'); return structuredClone(stored) }, currentRevision: async () => 4,
    select: async () => {
      events.push('selection'); return {
        modelIdentity: 'model', contextWindow: 128000, locale: 'zh-CN', groupChat: false,
        workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true }
      }
    },
    historyReader: {
      read: async scope => {
        events.push('history'); return {
          baselineSeq: 0, rows: [1, 2, 3].map(index => ({
            ownerId: scope.ownerId, sessionId: scope.sessionId,
            id: String(index), conversationSeq: index, role: 'user', content: `消息${index}`
          }))
        }
      }
    },
    currentTurn: async () => { events.push('current-turn'); return { currentUser: { message: { role: 'user', content: '消息3' }, persistedMessageId: '3' } } },
    data: {
      loadTimezone: async () => { events.push('timezone'); return 'Asia/Shanghai' },
      loadProjects: async () => { events.push('projects'); return [{ name: '合成项目' }] }, loadEvents: async () => [], loadNotes: async () => [], loadFilesOverview: async () => ({}),
      loadStylePreferences: async () => ({}), loadImChannels: async () => ({}), loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => []
    },
    builder: {
      buildSnapshot: data => { builds++; return { systemPrompt: '原有兼容system', snapshotContext: `项目概览${builds}`, sessionInfo: { projects: data.projects }, userTimezone: data.userTimezone } },
      buildRequest: snapshot => ({ systemPrompt: '本Run最新静态system', systemInMessages: true, fixedPrefix: [{ role: 'system', content: `[system-reminder]\n${snapshot.snapshotContext}\n[/system-reminder]` }] })
    }
  }
  const preparation: PreparationPorts = {
    ...services, buildRag: async input => {
      ragCalls++; expect(input.beforeMessageId).toBe('3'); expect(input.history.map(row => row.id)).toEqual(['1', '2'])
      return { tail: [{ role: 'user', content: '合成RAG' }] }
    }
  }
  return {
    ports, preparation, events, builds: () => builds, ragCalls: () => ragCalls,
    stored: () => stored, store: (value: SessionSnapshotState) => { stored = structuredClone(value) }, advance: (value: number) => { now += value }
  }
}
describe('Core标准上下文来源组合', () => {
  it.each([{ frozen: [] as Json[] }, { frozen: [{ name: '合成用户技能', content_digest: '版本一' }] as Json[] }])('用户Skill首次冻结入同一快照候选，下一Run只接收该冻结元数据：%j', async ({ frozen }) => {
    const value = fixture(), original = structuredClone(value.stored()), seen: unknown[] = []
    const run: CanonicalRunPreparationPorts = {
      configuration: async owner => ({ identity: { ownerId: owner.ownerId, subject: { kind: 'session', id: owner.sessionId }, workspaceId: null }, source: 'web', toolNames: [] }),
      discover: async () => [], formatPrefix: ({ snapshot }) => [{ role: 'user', content: snapshot }],
      capabilities: {
        workspaceSupported: false, filterConfigured: async names => names, shellPolicy: async () => ({ allowed: false, needsConfirmation: false }),
        shellState: async () => null, appendShellProtocol: system => system,
        catalog: async (_names, _owner, _tools, _signal, context) => {
          seen.push(structuredClone(context))
          return { metadataOnly: true, toolCatalog: '', skillCatalog: '冻结Skill目录', userSkills: context?.userSkillSnapshot ?? frozen }
        },
      },
    }
    const load = createCanonicalRunLoader(createCanonicalSourceLoader(value.ports).load, run, value.preparation)
    const first = await load(identity, new AbortController().signal)
    if ('kind' in first) throw new Error('测试不应早退')
    expect(first.sourceEffects?.sessionSnapshot.state.context?.user_skill_snapshot).toEqual(frozen)
    expect(value.stored()).toEqual(original)
    value.store(first.sourceEffects!.sessionSnapshot.state)
    const second = await load({ ...identity, runId: 'next' }, new AbortController().signal)
    if ('kind' in second) throw new Error('测试不应早退')
    expect(seen).toEqual([{ query: '消息3' }, { query: '消息3', userSkillSnapshot: frozen }])
    expect(second.capabilities?.userSkillSnapshot).toEqual(frozen)
    run.capabilities.catalog = async () => ({ metadataOnly: true, toolCatalog: '', skillCatalog: '漂移目录', userSkills: [{ name: '不应偷换的新版本' }] })
    await expect(load({ ...identity, runId: 'drift' }, new AbortController().signal)).rejects.toThrow('已冻结')
  })

  it('切换actor作用域重建时不保留owner冻结Skill元数据', async () => {
    const value = fixture(), first = await prepareRunContextSources(identity, value.ports)
    first.sourceEffects.sessionSnapshot.state.context!.user_skill_snapshot = [{ name: 'owner私人技能' }]
    value.store(first.sourceEffects.sessionSnapshot.state)
    const select = value.ports.select
    value.ports.select = async (...args) => ({ ...await select(...args), groupChat: true, contextScopeKey: 'restricted-actor', contextPolicy: { loadOwnerContext: false, memoryEnabled: false } })
    const restricted = await prepareRunContextSources(identity, value.ports)
    expect(restricted.sourceEffects.sessionSnapshot.phase).toBe('rebuild')
    expect(restricted.sourceEffects.sessionSnapshot.state.context).not.toHaveProperty('user_skill_snapshot')
  })
  it('owned snapshot→模型→数据快照→历史→current顺序，返回原子snapshot候选而不独立提交', async () => {
    const value = fixture(), original = structuredClone(value.stored())
    const loaded = await createCanonicalSourceLoader(value.ports).load(identity, new AbortController().signal)
    expect(value.events[0]).toBe('owned-snapshot'); expect(value.events.indexOf('selection')).toBeLessThan(value.events.indexOf('projects'))
    expect(value.events.indexOf('history')).toBeLessThan(value.events.indexOf('current-turn'))
    expect(loaded.sourceEffects.sessionSnapshot).toMatchObject({ expectedEpoch: 0, phase: 'rebuild', state: { contextEpoch: 1 } })
    expect(value.stored()).toEqual(original)
    expect(loaded.input.systemPrompt).toBe('本Run最新静态system'); expect(loaded.input.snapshotText).toBe('项目概览1')
  })
  it('标准loader接prepareContext有效历史只召回一次RAG且不重复当前已持久user', async () => {
    const value = fixture(), loaded = await prepareRunContextSources(identity, value.ports)
    expect(value.ragCalls()).toBe(0)
    const prepared = await prepareContext(loaded.input, value.preparation)
    expect(value.ragCalls()).toBe(1)
    expect(prepared.area.messages.filter(message => message.content === '【消息正文】\n消息3')).toHaveLength(1)
    expect(prepared.area.messages.findIndex(message => message.content === '合成RAG')).toBeLessThan(prepared.area.messages.findIndex(message => message.content === '【消息正文】\n消息3'))
  })
  it('标准sources把显式原始query透传到真实prepare召回，保持已持久当前水位', async () => {
    const value = fixture(), seen: unknown[] = []
    value.ports.currentTurn = async () => ({ query: '  原始检索问题\n第二行  ', currentUser: { persistedMessageId: '3', message: { role: 'user', content: '包含UI引用的投影' } } })
    value.preparation.buildRag = async input => { seen.push({ query: input.query, before: input.beforeMessageId, ids: input.history.map(row => row.id) }); return { tail: [] } }
    const loaded = await createCanonicalSourceLoader(value.ports).load(identity, new AbortController().signal)
    await prepareContext(loaded.input, value.preparation)
    expect(seen).toEqual([{ query: '  原始检索问题\n第二行  ', before: '3', ids: ['1', '2'] }])
  })
  it('快照命中不重复读数据域但静态system每Run重建，sliding TTL仍通过首次checkpoint effect交接', async () => {
    const value = fixture(), first = await prepareRunContextSources(identity, value.ports)
    value.store(first.sourceEffects.sessionSnapshot.state); value.advance(1000); value.events.length = 0
    const second = await prepareRunContextSources({ ...identity, runId: 'next-run' }, value.ports)
    expect(value.builds()).toBe(1); expect(value.events).not.toContain('projects')
    expect(second.sourceEffects.sessionSnapshot.phase).toBe('hit')
    expect(second.sourceEffects.sessionSnapshot.state.snapshotExpiresAt).toBe(1_801_000)
  })
  it('会话所有权先于model/current/任何owner数据读取，不能用空会话掩盖越权', async () => {
    const value = fixture(); value.ports.readSnapshot = async () => ({ ...value.stored(), ownerId: 'foreign' })
    await expect(prepareRunContextSources(identity, value.ports)).rejects.toThrow('不存在')
    expect(value.events).toEqual([]); expect(value.builds()).toBe(0)
  })
  it('坏库epoch在来源层被拒绝，不产生snapshot写候选或继续查询model/用户数据', async () => {
    const value = fixture(); value.ports.readSnapshot = async () => ({ ...value.stored(), contextEpoch: -1 })
    await expect(prepareRunContextSources(identity, value.ports)).rejects.toThrow('epoch')
    expect(value.events).toEqual([]); expect(value.builds()).toBe(0)
  })
  it('受限成员的标准路径不会调用owner领域loader', async () => {
    const value = fixture(), select = value.ports.select
    value.ports.select = async (...args) => ({ ...await select(...args), groupChat: true, contextScopeKey: 'group:synthetic-member', contextPolicy: { loadOwnerContext: false, memoryEnabled: true } })
    const loaded = await prepareRunContextSources(identity, value.ports)
    expect(value.events).not.toContain('projects')
    expect(loaded.sourceEffects.sessionSnapshot.state.context!.session_info).toEqual({ projects: [] })
  })
  it('owner已热缓存后切restricted必须重建，不复用owner项目正文或再读取owner数据源', async () => {
    const value = fixture(), first = await prepareRunContextSources(identity, value.ports)
    first.sourceEffects.sessionSnapshot.state.context!.snapshot_context = 'owner项目私有资料'
    value.store(first.sourceEffects.sessionSnapshot.state); value.events.length = 0
    const select = value.ports.select
    value.ports.select = async (...args) => ({ ...await select(...args), groupChat: true, contextScopeKey: 'group:member-a', contextPolicy: { loadOwnerContext: false, memoryEnabled: true } })
    const restricted = await prepareRunContextSources({ ...identity, runId: 'restricted-run' }, value.ports)
    expect(restricted.sourceEffects.sessionSnapshot.phase).toBe('rebuild')
    expect(restricted.sourceEffects.sessionSnapshot.state.context!.session_info).toEqual({ projects: [] })
    expect(stableJson(restricted.input)).not.toContain('owner项目私有资料')
    expect(stableJson(restricted.input)).not.toContain('合成项目')
    expect(value.events).not.toContain('projects')
    expect(restricted.sourceEffects.sessionSnapshot.state.context!.access_scope_hash).not.toBe(first.sourceEffects.sessionSnapshot.state.context!.access_scope_hash)
  })
  it('两个受限群actor不能共享同一快照，无可信actor绑定时在读取数据前拒绝', async () => {
    const value = fixture(), select = value.ports.select
    value.ports.select = async (...args) => ({ ...await select(...args), groupChat: true, contextScopeKey: 'group:member-a', contextPolicy: { loadOwnerContext: false, memoryEnabled: true } })
    const first = await prepareRunContextSources(identity, value.ports)
    value.store(first.sourceEffects.sessionSnapshot.state)
    value.ports.select = async (...args) => ({ ...await select(...args), groupChat: true, contextScopeKey: 'group:member-b', contextPolicy: { loadOwnerContext: false, memoryEnabled: true } })
    expect((await prepareRunContextSources(identity, value.ports)).sourceEffects.sessionSnapshot.phase).toBe('rebuild')
    value.events.length = 0
    value.ports.select = async (...args) => ({ ...await select(...args), groupChat: true, contextPolicy: { loadOwnerContext: false, memoryEnabled: true } })
    await expect(prepareRunContextSources(identity, value.ports)).rejects.toThrow('actor作用域')
    expect(value.events).toEqual(['owned-snapshot', 'selection'])
  })
})
