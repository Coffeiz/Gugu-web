import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createPostgresTrashPurgeOperations } from '../../src/domains/files/persistence/trash-purge-postgres.js'
import { TrashCooldownError } from '../../src/domains/files/trash.js'

const ownerId = '11111111-1111-4111-8111-111111111111'

function fakePool(responses: Array<{ rows?: unknown[]; rowCount?: number }> = []) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      const response = responses.shift() ?? { rows: [], rowCount: 0 }
      return { rows: response.rows ?? [], rowCount: response.rowCount ?? response.rows?.length ?? 0 }
    },
    release() {},
  }
  const pool = {
    async connect() { return client },
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      const response = responses.shift() ?? { rows: [], rowCount: 0 }
      return { rows: response.rows ?? [], rowCount: response.rowCount ?? response.rows?.length ?? 0 }
    },
  }
  return { pool: pool as unknown as Pool, client: client as unknown as PoolClient, calls }
}

const job = {
  id: 5, user_id: ownerId, status: 'queued', progress_current: 0, progress_total: 3,
  failed_count: 0, error_code: null, finished_at: null,
}

test('清空任务先持久化 owner 快照，提交后再唤醒 Worker', async () => {
  const { pool, calls } = fakePool([
    { rows: [] },
    { rows: [{ id: ownerId }] },
    { rows: [] },
    { rows: [] },
    { rows: [{ count: 2 }] },
    { rows: [{ count: 1 }] },
    { rows: [job] },
  ])
  let notified = false
  const operations = createPostgresTrashPurgeOperations(pool, {
    async notifyWorker() {
      assert.equal(calls.at(-1)?.sql, 'COMMIT')
      notified = true
    },
  })
  const result = await operations.startEmpty(ownerId)
  assert.deepEqual(result, { id: 5, status: 'queued', progressCurrent: 0, progressTotal: 3, failedCount: 0, errorCode: null })
  assert.equal(notified, true)
  assert.deepEqual(calls[1]?.values, [ownerId])
  assert.match(calls[1]?.sql ?? '', /FOR UPDATE/)
  assert.equal(calls.at(-1)?.sql, 'COMMIT')
})

test('重复清空复用 owner 的活动任务，不重复创建或唤醒', async () => {
  const active = { ...job, id: 8, status: 'running' }
  const { pool, calls } = fakePool([{ rows: [] }, { rows: [{ id: ownerId }] }, { rows: [active] }])
  let notifications = 0
  const operations = createPostgresTrashPurgeOperations(pool, { async notifyWorker() { notifications++ } })
  assert.deepEqual(await operations.startEmpty(ownerId), {
    id: 8, status: 'running', progressCurrent: 0, progressTotal: 3, failedCount: 0, errorCode: null,
  })
  assert.equal(notifications, 0)
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO trash_purge_jobs')), false)
  assert.equal(calls.at(-1)?.sql, 'COMMIT')
})

test('刚完成的非空清理在冷却期内拒绝新任务', async () => {
  const latest = { ...job, status: 'completed', finished_at: new Date(), progress_total: 4 }
  const { pool, calls } = fakePool([{ rows: [] }, { rows: [{ id: ownerId }] }, { rows: [] }, { rows: [latest] }])
  const operations = createPostgresTrashPurgeOperations(pool, { async notifyWorker() {} })
  await assert.rejects(() => operations.startEmpty(ownerId), TrashCooldownError)
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO trash_purge_jobs')), false)
})

test('任务状态读取按认证 owner 隔离', async () => {
  const { pool, calls } = fakePool([
    { rows: [job] },
    { rows: [] },
  ])
  const operations = createPostgresTrashPurgeOperations(pool, { async notifyWorker() {} })
  assert.equal((await operations.activeEmpty(ownerId))?.id, 5)
  assert.equal(await operations.getEmpty(ownerId, 99), null)
  assert.deepEqual(calls.map((call) => call.values), [[ownerId], [99, ownerId]])
})
