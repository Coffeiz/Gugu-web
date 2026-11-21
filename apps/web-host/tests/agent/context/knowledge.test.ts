import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentKnowledgeReadStore } from '@gugu/core/agent/knowledge/overview'
import { createAgentKnowledgeOverviewLoader } from '../../../src/modules/agent/tools/knowledge/list.js'

const owner = '00000000-0000-4000-8000-000000000011'
const other = '00000000-0000-4000-8000-000000000012'

function record(input: { id: string; owner?: string; scope?: string; title: string; topic: string; description: string; updated: string; active?: boolean }): Uint8Array {
  const fields = [
    `id: ${input.id}`,
    `title: ${input.title}`,
    `topic: ${input.topic}`,
    `description: ${input.description}`,
    'keywords_json: []',
    `scope_json: ${JSON.stringify({ type: input.scope ?? 'owner', owner_user_id: input.owner ?? owner })}`,
    'source_json: {"type":"user"}',
    'history_json: []',
    'version: 1',
    'confidence: confirmed',
    `created_at: ${input.updated}`,
    `updated_at: ${input.updated}`,
    `active: ${input.active === false ? 'false' : 'true'}`,
  ]
  return new TextEncoder().encode(`---\n${fields.join('\n')}\n---\nprivate knowledge body`)
}

function store(records: Record<string, Uint8Array>, overrides: Partial<AgentKnowledgeReadStore> = {}): AgentKnowledgeReadStore {
  return {
    async exists() { return true },
    async list(_prefix, cursor) {
      const keys = Object.keys(records).filter(key => cursor === null || key > cursor).sort()
      const page = keys.slice(0, 1)
      return { keys: page, nextCursor: keys.length > 1 ? page.at(-1)! : null }
    },
    async read(key) {
      const value = records[key]
      if (!value) throw new Error('missing synthetic record')
      return value
    },
    ...overrides,
  }
}

test('知识上下文只返回认证 owner 的活跃 owner scope 标题并按更新时间倒序', async () => {
  const prefix = `${owner}/.agent/knowledge/entries/`
  const loader = createAgentKnowledgeOverviewLoader(store({
    [`${prefix}old.md`]: record({ id: 'old', title: '旧知识', topic: '旧主题', description: '旧描述', updated: '2026-01-01T00:00:00Z' }),
    [`${prefix}new.md`]: record({ id: 'new', title: '新知识', topic: '新主题', description: '新描述', updated: '2026-01-02T00:00:00Z' }),
    [`${prefix}group.md`]: record({ id: 'group', title: '群知识', topic: '群', description: '不进入 owner 清单', updated: '2026-01-03T00:00:00Z', scope: 'group' }),
    [`${prefix}foreign.md`]: record({ id: 'foreign', owner: other, title: '其他用户', topic: '越权', description: '不应进入清单', updated: '2026-01-04T00:00:00Z' }),
    [`${prefix}inactive.md`]: record({ id: 'inactive', title: '已删除', topic: '已删除', description: '不活跃', updated: '2026-01-05T00:00:00Z', active: false }),
  }))

  const result = await loader({ ownerId: owner, sessionId: '9' })
  assert.deepEqual(result, [
    { title: '新知识', topic: '新主题', description: '新描述' },
    { title: '旧知识', topic: '旧主题', description: '旧描述' },
  ])
  assert.equal(JSON.stringify(result).includes('private knowledge body'), false)
  assert.equal(JSON.stringify(result).includes('knowledge_id'), false)
})

test('知识清单存储异常按 Python 上下文 loader 回退为空，取消仍然中断', async () => {
  const broken = createAgentKnowledgeOverviewLoader(store({}, { async list() { throw new Error('synthetic storage failure') } }))
  assert.deepEqual(await broken({ ownerId: owner, sessionId: '9' }), [])

  const controller = new AbortController()
  const cancelled = createAgentKnowledgeOverviewLoader(store({}, { async list() { controller.abort(new Error('synthetic cancellation')); return { keys: [], nextCursor: null } } }))
  await assert.rejects(cancelled({ ownerId: owner, sessionId: '9' }, controller.signal), /synthetic cancellation/)
})
