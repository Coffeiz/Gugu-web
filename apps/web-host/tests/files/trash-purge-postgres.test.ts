import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createPostgresTrashPurgeOperations } from '../../src/modules/files/trash/purge.js'
import { TrashCooldownError } from '../../src/modules/files/trash/service.js'

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

test('Agent purge 操作 ID 与 job 原子关联，重试在 job 完成后仍返回同一行', async () => {
  const stableJob = { ...job, id: 44 }
  const { pool, calls } = fakePool([
    { rows: [] }, { rows: [{ id: ownerId }] }, { rows: [] },
    { rows: [{ count: 2, digest: 'files-digest' }] }, { rows: [{ count: 1, digest: 'folders-digest' }] },
    { rows: [] }, { rows: [] }, { rows: [stableJob] }, { rows: [] },
    { rows: [] }, { rows: [{ id: ownerId }] }, { rows: [stableJob] }, { rows: [stableJob] },
  ])
  let notifications = 0
  const operations = createPostgresTrashPurgeOperations(pool, { async notifyWorker() { notifications++ } })
  const operationId = randomUUID()
  const snapshot = { file_count: 2, folder_count: 1,
    digest: createHash('sha256').update('files-digest:folders-digest').digest('hex') }
  assert.deepEqual(await operations.startEmptyForAgent(ownerId, operationId, snapshot), {
    id: 44, status: 'queued', progressCurrent: 0, progressTotal: 3, failedCount: 0, errorCode: null,
  })
  assert.deepEqual(await operations.startEmptyForAgent(ownerId, operationId, snapshot), {
    id: 44, status: 'queued', progressCurrent: 0, progressTotal: 3, failedCount: 0, errorCode: null,
  })
  assert.equal(calls[0]?.sql, 'BEGIN ISOLATION LEVEL SERIALIZABLE')
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO trash_purge_jobs')).length, 1)
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO trash_purge_agent_operations')).length, 1)
  assert.equal(notifications, 1)
})

test('Agent purge job 创建时快照变化会拒绝新增物理删除任务', async () => {
  const { pool, calls } = fakePool([
    { rows: [] }, { rows: [{ id: ownerId }] }, { rows: [] },
    { rows: [{ count: 3, digest: 'changed-files' }] }, { rows: [{ count: 1, digest: 'folders-digest' }] },
  ])
  const operations = createPostgresTrashPurgeOperations(pool, { async notifyWorker() {} })
  const snapshot = { file_count: 2, folder_count: 1,
    digest: createHash('sha256').update('files-digest:folders-digest').digest('hex') }
  await assert.rejects(() => operations.startEmptyForAgent(ownerId, randomUUID(), snapshot), { code: 'conflict' })
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO trash_purge_jobs')), false)
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
