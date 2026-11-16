import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KnowledgeReadPort } from '../../../src/agent/tools/knowledge.js'
import { createKnowledgeReadTool } from '../../../src/agent/tools/knowledge.js'
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
