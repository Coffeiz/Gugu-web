import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { CoreError } from '@gugu/core'
import { createPostgresWorkspaceDeleter } from '../../src/domains/workspaces/persistence/workspace-delete.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

function scriptedPool(options: { owned?: boolean; failOnTaskUpdate?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let released = false
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (/^SELECT id FROM workspaces/i.test(sql))
        return { rows: options.owned === false ? [] : [{ id: 41 }], rowCount: options.owned === false ? 0 : 1 }
      if (/^UPDATE scheduled_tasks/i.test(sql) && options.failOnTaskUpdate)
        throw new Error('synthetic task update failure')
      return { rows: [], rowCount: 1 }
    },
    release() { released = true },
  }
  const pool = { connect: async () => client } as unknown as Pool
  return { pool, calls, released: () => released }
}

test('删除工作区在一个事务内解除 owner 会话与普通任务绑定并返回原有响应', async () => {
  const fake = scriptedPool()
  const remove = createPostgresWorkspaceDeleter(fake.pool)

  assert.deepEqual(await remove(ownerId, 41), { ok: true, workspaceId: 41 })
  assert.equal(fake.calls[0]?.sql, 'BEGIN')
  assert.match(fake.calls[1]?.sql ?? '', /WHERE id = \$1 AND user_id = \$2 FOR UPDATE/i)
  assert.deepEqual(fake.calls[1]?.values, [41, ownerId])
  assert.match(fake.calls[2]?.sql ?? '', /UPDATE conversation_sessions SET workspace_id = NULL/i)
  assert.deepEqual(fake.calls[2]?.values, [ownerId, 41])
  assert.match(fake.calls[3]?.sql ?? '', /UPDATE scheduled_tasks SET enabled = FALSE, workspace_id = NULL/i)
  assert.match(fake.calls[3]?.sql ?? '', /event_id IS NULL/i)
  assert.deepEqual(fake.calls[3]?.values, [ownerId, 41])
  assert.match(fake.calls[4]?.sql ?? '', /DELETE FROM workspaces WHERE id = \$1 AND user_id = \$2/i)
  assert.deepEqual(fake.calls[4]?.values, [41, ownerId])
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(fake.released(), true)
  assert.equal(fake.calls.some((call) => call.values?.includes(otherOwnerId)), false)
})

test('他人工作区 owner-scoped 查询返回 404 且不执行任何删除副作用', async () => {
  const fake = scriptedPool({ owned: false })
  const remove = createPostgresWorkspaceDeleter(fake.pool)

  await assert.rejects(remove(ownerId, 41), (error: unknown) =>
    error instanceof CoreError && error.code === 'not_found',
  )
  assert.equal(fake.calls.filter((call) => /^UPDATE|^DELETE/i.test(call.sql)).length, 0)
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('绑定清理中途失败会回滚，避免部分解除后留下工作区', async () => {
  const fake = scriptedPool({ failOnTaskUpdate: true })
  const remove = createPostgresWorkspaceDeleter(fake.pool)

  await assert.rejects(remove(ownerId, 41), /synthetic task update failure/)
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(fake.calls.some((call) => call.sql === 'COMMIT'), false)
  assert.equal(fake.calls.some((call) => /^DELETE FROM workspaces/i.test(call.sql)), false)
})
