import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { GLOBAL_SEARCH_TYPES, type GlobalSearchOperations } from '@gugu/search'
import { createMindReferenceSuggester } from '../../../../packages/core/src/mind/ref-suggest.js'
import { createPostgresMindReferenceSuggestionPorts } from '../../src/modules/mind/references.js'

const ownerId = 'd1e37042-3229-4cbe-a260-a63dcb95e001'

test('recent suggestions return owner-scoped resource categories in Python order and enforce the aggregate cap', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql.includes('FROM projects')) return { rows: [{ id: 1, name: '项目', client: '小北' }] }
      if (sql.includes('FROM calendar_events')) return { rows: [{ id: 4, title: '评审', date: '2026-11-14' }] }
      if (sql.includes('JOIN mind_canvas_items')) return { rows: [{ id: 5, title: null, canvas_id: '6' }] }
      if (sql.includes('FROM user_mcp_servers')) return { rows: [{ id: 'mcp-id', name: '工具服务', transport: 'http' }] }
      if (sql.includes('FROM scheduled_tasks')) return { rows: [{ id: 8, name: '提醒', cron: '0 9 * * *' }] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  } as unknown as Pool
  const search: GlobalSearchOperations = { availableTypes: GLOBAL_SEARCH_TYPES, missingTypes: [], async search() { throw new Error('search should not be called for an empty query') } }

  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createUserSkillBundle } = await import('@gugu/core/skills')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-recent-'))
  try {
    await createUserSkillBundle(root, ownerId, 'write', '---\nname: 写作\ndescription: 写作描述\n---\n正文')
    const result = await createMindReferenceSuggester({
      ...createPostgresMindReferenceSuggestionPorts(pool, root), globalSearch: search,
    }).suggest(ownerId, '  ', 1)

  assert.deepEqual(result, [
    { type: 'project', id: 1, label: '项目', subtitle: '小北' },
    { type: 'event', id: 4, label: '评审', subtitle: '2026-11-14' },
    { type: 'canvas_note', id: 5, label: '无标题画布便签', subtitle: '画布 6' },
    { type: 'skill', id: 'write', label: '写作', subtitle: '写作描述' },
    { type: 'mcp', id: 'mcp-id', label: '工具服务', subtitle: 'http' },
    { type: 'scheduled_task', id: 8, label: '提醒', subtitle: '0 9 * * *' },
  ])
  assert.equal(calls.length, 5)
  assert.ok(calls.every(({ values }) => values?.[0] === ownerId && values?.[1] === 1))
  assert.ok(calls.some(({ sql }) => sql.includes("n.kind='canvas_note'") && sql.includes('ci.deleted_at IS NULL')))
  assert.ok(calls.some(({ sql }) => sql.includes("scope='platform'")))
  assert.ok(calls.some(({ sql }) => sql.includes('end_at > now()')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('query suggestions reuse typed global search results and return individual owned messages with snippets', async () => {
  let searchInput: unknown
  let messageSql = ''
  let messageArgs: unknown[] | undefined
  const pool = {
    async query(sql: string, values?: unknown[]) {
      messageSql = sql
      messageArgs = values
      return { rows: [{ id: 19, content: '前文包含需要精确定位的检索词以及后续说明', session_title: '讨论记录' }] }
    },
  } as unknown as Pool
  const search: GlobalSearchOperations = {
    availableTypes: GLOBAL_SEARCH_TYPES, missingTypes: [],
    async search(requestOwner, input) {
      searchInput = { requestOwner, input }
      return { groups: [{ type: 'project', items: [{ id: 2, title: '项目命中', subtitle: '客户' }] }] }
    },
  }

  const result = await createMindReferenceSuggester({
    ...createPostgresMindReferenceSuggestionPorts(pool), globalSearch: search,
    async matchingFileReferences(owner, query, limit) {
      assert.deepEqual([owner, query, limit], [ownerId, '检索词', 3])
      return [{ type: 'file', id: 'path-c2FtcGxl', label: '检索词.md', subtitle: '/personal/检索词.md' }]
    },
  }).suggest(ownerId, '  检索词  ', 3)

  assert.deepEqual(result, [
    { type: 'project', id: 2, label: '项目命中', subtitle: '客户' },
    { type: 'file', id: 'path-c2FtcGxl', label: '检索词.md', subtitle: '/personal/检索词.md' },
    { type: 'conversation', id: 19, label: '前文包含需要精确定位的检索词以及后续说明', subtitle: '讨论记录' },
  ])
  const input = searchInput as { requestOwner: string; input: { q: string; queries: string[]; mode: string; perType: number; types: string[] } }
  assert.equal(input.requestOwner, ownerId)
  assert.deepEqual(input.input, {
    q: '检索词', queries: ['检索词'], mode: 'OR', perType: 3,
    types: ['project', 'event', 'canvas_note', 'skill', 'mcp', 'scheduled_task'],
  })
  assert.match(messageSql, /s\.user_id=\$1/)
  assert.match(messageSql, /m\.content_json IS NULL/)
  assert.match(messageSql, /m\.role <> 'summary'/)
  assert.deepEqual(messageArgs, [ownerId, '%检索词%', 3])
})

test('最近引用包含当前用户的文件技能', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createUserSkillBundle } = await import('@gugu/core/skills')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-suggest-'))
  const pool = { async query() { return { rows: [] } } } as unknown as Pool
  try {
    await createUserSkillBundle(root, ownerId, 'demo', '---\nname: 整理技能\ndescription: 自动归档\n---\n正文')
    const result = await createPostgresMindReferenceSuggestionPorts(pool, root).recent(ownerId, 6)
    assert.deepEqual(result, [{ type: 'skill', id: 'demo', label: '整理技能', subtitle: '自动归档' }])
    assert.deepEqual(await createPostgresMindReferenceSuggestionPorts(pool, root).recent('00000000-0000-4000-8000-000000000001', 6), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
