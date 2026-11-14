import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import type { GlobalSearchOperations } from '../../src/domains/search/search.js'
import { createPostgresMindRefSuggestOperations } from '../../src/domains/mind/persistence/mind-ref-suggest-postgres.js'

const ownerId = 'synthetic-suggest-owner'

test('recent suggestions return owner-scoped resource categories in Python order and enforce the aggregate cap', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql.includes('FROM projects')) return { rows: [{ id: 1, name: '项目', client: '小北' }] }
      if (sql.includes('FROM files')) return { rows: [{ id: 2, display_name: '计划', ext: 'md', space: 'mind' }] }
      if (sql.includes('FROM folders')) return { rows: [{ id: 3, name: '资料夹' }] }
      if (sql.includes('FROM calendar_events')) return { rows: [{ id: 4, title: '评审', date: '2026-11-14' }] }
      if (sql.includes('JOIN mind_canvas_items')) return { rows: [{ id: 5, title: null, canvas_id: '6' }] }
      if (sql.includes('FROM user_skills')) return { rows: [{ id: 7, name: '写作', skill_id: 'write' }] }
      if (sql.includes('FROM user_mcp_servers')) return { rows: [{ id: 'mcp-id', name: '工具服务', transport: 'http' }] }
      if (sql.includes('FROM scheduled_tasks')) return { rows: [{ id: 8, name: '提醒', cron: '0 9 * * *' }] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  } as unknown as Pool
  const search: GlobalSearchOperations = { async search() { throw new Error('search should not be called for an empty query') } }

  const result = await createPostgresMindRefSuggestOperations(pool, search).suggest(ownerId, '  ', 1)

  assert.deepEqual(result, [
    { type: 'project', id: 1, label: '项目', subtitle: '小北' },
    { type: 'file', id: 2, label: '计划.md', subtitle: 'mind' },
    { type: 'folder', id: 3, label: '资料夹' },
    { type: 'event', id: 4, label: '评审', subtitle: '2026-11-14' },
    { type: 'canvas_note', id: 5, label: '无标题画布便签', subtitle: '画布 6' },
    { type: 'skill', id: 7, label: '写作', subtitle: 'write' },
    { type: 'mcp', id: 'mcp-id', label: '工具服务', subtitle: 'http' },
    { type: 'scheduled_task', id: 8, label: '提醒', subtitle: '0 9 * * *' },
  ])
  assert.equal(calls.length, 8)
  assert.ok(calls.every(({ values }) => values?.[0] === ownerId && values?.[1] === 1))
  assert.ok(calls.some(({ sql }) => sql.includes("n.kind='canvas_note'") && sql.includes('ci.deleted_at IS NULL')))
  assert.ok(calls.some(({ sql }) => sql.includes("scope='platform'")))
  assert.ok(calls.some(({ sql }) => sql.includes('end_at > now()')))
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
    async search(requestOwner, input) {
      searchInput = { requestOwner, input }
      return { groups: [{ type: 'project', items: [{ id: 2, title: '项目命中', subtitle: '客户' }] }] }
    },
  }

  const result = await createPostgresMindRefSuggestOperations(pool, search).suggest(ownerId, '  检索词  ', 3)

  assert.deepEqual(result, [
    { type: 'project', id: 2, label: '项目命中', subtitle: '客户' },
    { type: 'conversation', id: 19, label: '前文包含需要精确定位的检索词以及后续说明', subtitle: '讨论记录' },
  ])
  const input = searchInput as { requestOwner: string; input: { q: string; queries: string[]; mode: string; perType: number; types: string[] } }
  assert.equal(input.requestOwner, ownerId)
  assert.deepEqual(input.input, {
    q: '检索词', queries: ['检索词'], mode: 'OR', perType: 3,
    types: ['project', 'file', 'folder', 'event', 'canvas_note', 'skill', 'mcp', 'scheduled_task'],
  })
  assert.match(messageSql, /s\.user_id=\$1/)
  assert.match(messageSql, /m\.content_json IS NULL/)
  assert.match(messageSql, /m\.role <> 'summary'/)
  assert.deepEqual(messageArgs, [ownerId, '%检索词%', 3])
})
