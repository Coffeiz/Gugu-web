import type { ConfirmationTargetSnapshot } from '../../../src/agent/tools/confirmation.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KnowledgeReadPort } from '../../../src/agent/tools/knowledge/index.js'
import { createKnowledgeDeleteTool, createKnowledgeReadTool, createKnowledgeWriteTools, type KnowledgeDeletePort, type KnowledgeWritePort } from '../../../src/agent/tools/knowledge/index.js'
import { parseAgentKnowledgeEntry, serializeAgentKnowledgeEntry, type AgentKnowledgeEntry } from '../../../src/agent/knowledge/entry.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const owner = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
let allowed = true
let observed: unknown[]
let registry: ReturnType<typeof createToolRegistry>

const entry = {
  knowledge_id: 'k-1', title: '发布回滚', topic: '发布', description: '回滚边界', keywords: ['发布', '回滚'],
  confidence: 'confirmed', source_type: 'user', scope_type: 'owner', created_at: '2026-01-01T00:00:00+00:00',
  updated_at: '2026-01-02T00:00:00+00:00', content: '保留上一版本', version: 3,
}
const hit = (content: string) => ({ knowledge_id: 'k-1', title: entry.title, topic: entry.topic, description: entry.description,
  keywords: '发布、回滚', confidence: 'confirmed', source_type: 'user', source_ref: '', source_label: '', content,
  score: 0.8, updated_at: entry.updated_at, version: '3' })
const identity = (ownerId = owner) => ({ ownerId, sessionId: '1', runId: 'knowledge-run' })
const scope = (ownerId = owner) => ({ identity: identity(ownerId), roundId: 'round-1', signal: new AbortController().signal,
  resolution: null, execute: async () => { throw new Error('知识读取不能执行宿主进程') } })
const call = (input: unknown) => ({ id: 'knowledge-call', name: 'read_knowledge', input })

it('round-trips Python Knowledge Markdown field order and microsecond timestamps', () => {
  const entry: AgentKnowledgeEntry = {
    id: 'knowledge-roundtrip', title: '回归', content: '正文\n第二行', topic: '知识', keywords: ['回滚'], description: '恢复时使用',
    scope: { type: 'owner', owner_user_id: owner, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
    source: { type: 'user', ref: '', label: '', checked_at: 1_760_000_000.123456 }, confidence: 'confirmed', version: 2,
    parent_id: null, created_at: 1_760_000_000, updated_at: 1_760_000_000.654321, active: true,
    history: [{ version: 1, title: '旧版', content: '旧正文', keywords: [], source: { type: 'user', ref: '', label: '', checked_at: null }, confidence: 'confirmed', updated_at: 1_760_000_000.333333 }],
  }
  const raw = new TextDecoder().decode(serializeAgentKnowledgeEntry(entry))
  expect(raw).toMatch(/created_at: 2025-10-09T08:53:20\.000000Z/u)
  expect(raw).toMatch(/updated_at: 2025-10-09T08:53:20\.654321Z/u)
  expect(raw).toMatch(/checked_at":"2025-10-09T08:53:20\.123456Z/u)
  const parsed = parseAgentKnowledgeEntry(new TextEncoder().encode(raw))
  expect(Math.abs(parsed.updated_at - entry.updated_at)).toBeLessThan(0.000001)
  expect(Math.abs(parsed.source.checked_at! - entry.source.checked_at!)).toBeLessThan(0.000001)
  expect(Math.abs(parsed.history[0]!.updated_at - entry.history[0]!.updated_at)).toBeLessThan(0.000001)
})

beforeEach(() => {
  allowed = true
  observed = []
  const port: KnowledgeReadPort = {
    async read(current, id) {
      observed.push({ operation: 'read', current, id })
      return current.ownerId === owner && id === entry.knowledge_id ? entry : null
    },
    async search(current, keyword, scopeType, limit) {
      observed.push({ operation: 'search', current, keyword, scopeType, limit })
      return { results: [hit('保留'), hit('上一版本')], has_more: true }
    },
  }
  registry = createToolRegistry({ groups: [{ id: 'knowledge', name: '知识', tools: [createKnowledgeReadTool(port)] }],
    authorize: async () => allowed })
})
afterEach(() => { registry.configure({}) })

describe('read_knowledge through the Core tool dispatcher', () => {
  it('uses trusted owner for exact reads and returns the full body/version', async () => {
    expect(await registry.tools.dispatch(call({ knowledge_id: ' k-1 ' }), scope())).toMatchObject({
      kind: 'completed', successful: true, mutated: false, value: { success: true, entry: { content: entry.content, version: 3 } },
    })
    expect(observed).toEqual([{ operation: 'read', current: identity(), id: 'k-1' }])
    expect(await registry.tools.dispatch(call({ knowledge_id: 'k-1' }), scope(other))).toMatchObject({
      kind: 'completed', successful: false, value: { error: expect.stringContaining('不存在或已停用') },
    })
  })

  it('uses BM25 port, owner identity and the Python default limit, then merges chunks by entry', async () => {
    expect(await registry.tools.dispatch(call({ keyword: '发布 回滚', owner_id: other }), scope())).toMatchObject({
      kind: 'completed', successful: true, value: { strategy: 'bm25', returned: 1, has_more: true,
        entries: [{ knowledge_id: 'k-1', content: '保留\n\n上一版本' }] },
    })
    expect(observed).toEqual([{ operation: 'search', current: identity(), keyword: '发布 回滚', scopeType: '', limit: 5 }])
  })

  it('preserves Python handler errors, ID precedence and range checks without searching invalid input', async () => {
    const missing = await registry.tools.dispatch(call({}), scope())
    expect(missing).toMatchObject({ kind: 'completed', successful: false, executed: true,
      value: { error: expect.stringContaining('keyword') } })
    const exact = await registry.tools.dispatch(call({ keyword: 'ignored', knowledge_id: 'k-1' }), scope())
    expect(exact).toMatchObject({ kind: 'completed', successful: true, value: { entry: { knowledge_id: 'k-1' } } })
    const invalidLimit = await registry.tools.dispatch(call({ keyword: 'x', limit: 26 }), scope())
    expect(invalidLimit).toMatchObject({ kind: 'completed', successful: false, executed: true,
      value: { error: expect.stringContaining('1 到 25') } })
    for (const input of [null, []]) {
      const result = await registry.tools.dispatch(call(input), scope())
      expect(result).toMatchObject({ kind: 'completed', successful: false, executed: false })
    }
    expect(observed).toEqual([
      { operation: 'read', current: identity(), id: 'k-1' },
    ])
  })

  it('rechecks permission and does not reveal indexed content after revocation', async () => {
    allowed = false
    expect(await registry.tools.dispatch(call({ keyword: '发布' }), scope())).toMatchObject({
      kind: 'completed', successful: false, executed: false,
    })
    expect(observed).toEqual([])
  })
})

describe('save_knowledge and update_knowledge through the Core tool dispatcher', () => {
  it('saves normalized owner data, reuses same-topic records and records content history on update', async () => {
    const entries: AgentKnowledgeEntry[] = []
    const commits: Array<{ identity: unknown; entry: AgentKnowledgeEntry }> = []
    const port: KnowledgeWritePort = {
      async list(current) {
        expect(current.ownerId).toBe(owner)
        return structuredClone(entries)
      },
      async commit(current, next) {
        commits.push({ identity: current, entry: structuredClone(next) })
        const index = entries.findIndex(item => item.id === next.id)
        if (index < 0) entries.push(structuredClone(next)); else entries[index] = structuredClone(next)
      },
    }
    const writes = createKnowledgeWriteTools(port, () => 1_800_000_000)
    const writer = createToolRegistry({ groups: [{ id: 'knowledge', name: '知识', tools: writes }], authorize: async () => true })
    const dispatch = (name: string, input: unknown) => writer.tools.dispatch({ id: 'write-call', name, input }, scope())
    try {
      const saved = await dispatch('save_knowledge', { title: '  回滚 手册 ', content: '保留 当前 版本', topic: '上线 发布', keywords: [' 回滚  ', '回滚', ' 发行'], description: ' 发布时使用  ' })
      expect(saved).toMatchObject({ kind: 'completed', successful: true, mutated: true,
        value: { success: true, title: '回滚 手册', source_type: 'user', confidence: 'confirmed', index_status: 'queued' } })
      expect(entries).toHaveLength(1)
      const first = entries[0]!
      expect(first).toMatchObject({ content: '保留 当前 版本', topic: '上线 发布', keywords: ['回滚', '发行'],
        description: '发布时使用', scope: { type: 'owner', owner_user_id: owner }, source: { type: 'user' }, version: 1 })
      expect(commits[0]?.identity).toEqual(identity())

      const duplicate = await dispatch('save_knowledge', { title: '修订', content: '已更新 版本', topic: '上线发布', keywords: ['上线'], description: '发布时使用' })
      expect(duplicate).toMatchObject({ kind: 'completed', successful: true, value: { id: first.id } })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ id: first.id, version: 2, content: '已更新 版本', history: [{ version: 1, content: '保留 当前 版本' }] })

      const updated = await dispatch('update_knowledge', { knowledge_id: first.id, content: '最终回滚步骤', keywords: ['正式', 2026, true, { ignored: true }] })
      expect(updated).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { version: 3, unchanged: false } })
      expect(entries[0]).toMatchObject({ version: 3, content: '最终回滚步骤', keywords: ['正式', '2026', 'True'], history: [
        { version: 1, content: '保留 当前 版本' }, { version: 2, content: '已更新 版本' },
      ] })
      const conflict = await dispatch('save_knowledge', { title: '外部核对', content: '来源不同的同主题事实', topic: '上线发布', source_type: 'web', source_ref: 'https://example.test/release' })
      expect(conflict).toMatchObject({ kind: 'completed', successful: true, value: { source_type: 'web', confidence: 'conflict' } })
      expect(entries).toHaveLength(2)
      expect(entries[1]).toMatchObject({ parent_id: first.id, confidence: 'conflict', source: { type: 'web' } })
      expect(commits).toHaveLength(4)
      expect(commits.every(commit => commit.entry.scope.owner_user_id === owner)).toBe(true)
    } finally { writer.configure({}) }
  })

  it('matches Python validation and partial update semantics without committing rejected input', async () => {
    let committed = 0
    const current: AgentKnowledgeEntry = {
      id: 'k-1', title: '原标题', content: '原正文', topic: '主题', keywords: ['原词'], description: '描述',
      scope: { type: 'owner', owner_user_id: owner, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
      source: { type: 'user', ref: '', label: '', checked_at: null }, confidence: 'confirmed', version: 2,
      parent_id: null, created_at: 1, updated_at: 2, active: true, history: [],
    }
    const port: KnowledgeWritePort = { async list(identity) { return identity.ownerId === owner ? [structuredClone(current)] : [] }, async commit() { committed++ } }
    const writer = createToolRegistry({ groups: [{ id: 'knowledge', name: '知识', tools: createKnowledgeWriteTools(port, () => 3) }], authorize: async () => true })
    const dispatch = (input: unknown) => writer.tools.dispatch({ id: 'update-call', name: 'update_knowledge', input }, scope())
    try {
      expect(await dispatch({ knowledge_id: 'k-1', content: '   ' })).toMatchObject({ kind: 'completed', successful: true, mutated: true,
        value: { unchanged: true, version: 2, title: '原标题' } })
      expect(await dispatch({ knowledge_id: 'missing', content: '新正文' })).toMatchObject({ kind: 'completed', successful: false,
        value: { error: expect.stringContaining('不存在或已删除') } })
      expect(await dispatch({ knowledge_id: 'k-1', content: 'x'.repeat(3001) })).toMatchObject({ kind: 'completed', successful: false,
        value: { error: expect.stringContaining('content 不能超过 3000') } })
      expect(committed).toBe(1)
    } finally { writer.configure({}) }
  })
})

it('知识删除将准确 owner 与版本绑定到确认，失效确认不提交，恢复复用可信收据', async () => {
  let currentVersion = 'v1', frozenVersion: string | undefined
  let receipt = false, effects = 0
  const gate = {
    async prepare(toolCall: { name: string }, _scope: unknown, _digest: string, snapshot: ConfirmationTargetSnapshot) {
      frozenVersion = snapshot.versionsDigest
      return { ok: true, value: { id: 'confirmation', kind: 'confirmation', toolCall } }
    },
    async verify(_call: unknown, _scope: unknown, _digest: string, snapshot: ConfirmationTargetSnapshot) {
      return snapshot.versionsDigest === frozenVersion ? { ok: true, value: { intentId: 'confirmed' } } : { ok: false }
    },
  } as unknown as KnowledgeDeletePort['gate']
  const tool = createKnowledgeDeleteTool({
    gate,
    async readTarget(actor, id) {
      if (actor.ownerId !== owner || id !== 'k-1' || receipt) return null
      return { knowledgeId: id, snapshot: { targetsDigest: 'stable', versionsDigest: currentVersion } }
    },
    async commit(actor, target, claim) {
      expect(actor).toEqual({ ...identity(), roundId: 'round-1', toolCallId: 'delete' })
      expect(target.knowledgeId).toBe('k-1')
      expect(claim.intentId).toBe('confirmed')
      receipt = true
      effects++
      return { kind: 'completed', successful: true, mutated: true, value: { success: true, knowledge_id: 'k-1' } }
    },
    async reconcile(actor) {
      return actor.ownerId === owner && receipt
        ? { kind: 'completed', successful: true, mutated: false, value: { success: true, knowledge_id: 'k-1' } }
        : { kind: 'unknown' }
    },
  })
  const registry = createToolRegistry({ tools: [tool], authorize: async () => true })
  const call = { id: 'delete', name: 'delete_knowledge', input: { knowledge_id: ' k-1 ' } }
  const response = { interactionId: 'confirmation', receiptId: 'receipt', status: 'confirmed' as const, value: null }
  expect(await registry.tools.dispatch(call, scope(other))).toMatchObject({ successful: false })
  expect(await registry.tools.dispatch(call, scope())).toMatchObject({ kind: 'waiting' })
  currentVersion = 'v2'
  expect(await registry.tools.dispatch(call, { ...scope(), resolution: response })).toMatchObject({ successful: false })
  expect(effects).toBe(0)
  expect(await registry.tools.dispatch(call, scope())).toMatchObject({ kind: 'waiting' })
  expect(await registry.tools.dispatch(call, { ...scope(), resolution: response })).toMatchObject({
    successful: true, mutated: true, value: { success: true, knowledge_id: 'k-1' },
  })
  expect(await registry.tools.dispatch(call, { ...scope(), resolution: response })).toMatchObject({ successful: true, mutated: false })
  expect(effects).toBe(1)
})
