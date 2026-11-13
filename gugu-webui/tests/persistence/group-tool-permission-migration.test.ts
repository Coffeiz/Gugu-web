import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateGroupToolPermissions } from '../../src/migrations/group-tool-permissions.js'
import type { MigrationPool, MigrationRow } from '../../src/migrations/group-tool-permissions.js'

function fixture(rows: MigrationRow[]) {
  const events: string[] = []
  let current = structuredClone(rows)
  const pool: MigrationPool = {
    async connect() {
      return {
        async query(sql, values = []) {
          events.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
          if (sql.includes('SELECT id, group_allowed_tools'))
            return { rows: structuredClone(current), rowCount: current.length }
          if (sql.includes('UPDATE user_bots')) {
            const [serializedTools, id] = values as [string, number]
            const tools = JSON.parse(serializedTools) as string[]
            current = current.map(row => row.id === id ? { ...row, group_allowed_tools: tools } : row)
            return { rows: [], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        },
        release() { events.push('RELEASE') },
      }
    },
  }
  return { pool, events, rows: () => current }
}

test('规范化旧群工具名并保留 Provider 搜索能力，重复执行不再写入', async () => {
  const state = fixture([
    { id: 1, group_allowed_tools: ['web_search', 'http_get', 'xng_search'] },
    { id: 2, group_allowed_tools: ['image_search', 'inspect_images', 'retired_tool'] },
    { id: 3, group_allowed_tools: ['web_search', 'retired_tool'] },
    { id: 4, group_allowed_tools: null },
  ])

  assert.equal(await migrateGroupToolPermissions(state.pool), 2)
  assert.deepEqual(state.rows().map(row => row.group_allowed_tools), [
    ['web_search', 'http_get', 'xng_search'],
    ['xng_search', 'http_get', 'similar_image_search', 'read_file'],
    ['web_search', 'http_get'],
    null,
  ])
  assert.equal(await migrateGroupToolPermissions(state.pool), 0)
})

test('迁移失败回滚事务并释放数据库连接', async () => {
  const state = fixture([{ id: 1, group_allowed_tools: ['web_search'] }])
  const original = state.pool.connect
  state.pool.connect = async () => {
    const client = await original()
    return {
      ...client,
      async query(sql, values) {
        if (sql.includes('UPDATE user_bots')) throw new Error('合成更新故障')
        return client.query(sql, values)
      },
    }
  }

  await assert.rejects(migrateGroupToolPermissions(state.pool), /合成更新故障/)
  assert.ok(state.events.includes('ROLLBACK'))
  assert.ok(state.events.includes('RELEASE'))
})
