import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { startTrashPurgeWorker } from '../../../src/modules/files/trash/purge.js'

const ownerId = '00000000-0000-4000-8000-000000000007'

test('Host purge worker claims the persisted job, deletes only its owner snapshot, and publishes progress', async () => {
  const sqlCalls: Array<{ sql: string; values: unknown[] }> = []
  const published: Array<{ kind: string; value: Record<string, unknown> }> = []
  const deleted: Array<[string, number]> = []
  const errors: string[] = []
  let claimed = false
  let fileReturned = false
  const fakePool = {
    async connect() {
      return {
        async query(sql: string, values: unknown[] = []) {
          sqlCalls.push({ sql, values })
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
          if (sql.includes("status='running' AND lease_until>$1")) return { rows: [], rowCount: 0 }
          if (sql.includes("status='running' AND (lease_until<=$1 OR lease_until IS NULL)")) return { rows: [], rowCount: 0 }
          if (sql.includes("status='queued' ORDER BY created_at"))
            return claimed ? { rows: [], rowCount: 0 } : { rows: [{ id: 23 }], rowCount: 1 }
          if (sql.includes("UPDATE trash_purge_jobs SET status='running'")) {
            claimed = true
            return { rows: [{ id: 23, user_id: ownerId, snapshot_at: new Date('2026-11-18T00:00:00Z'), progress_current: 0, progress_total: 1, failed_count: 0 }], rowCount: 1 }
          }
          if (sql.includes('SELECT count(file.id)')) return { rows: [{ count: 1 }], rowCount: 1 }
          if (sql.includes('SELECT count(folder.id)')) return { rows: [{ count: 0 }], rowCount: 1 }
          throw new Error(`unexpected fake transaction query: ${sql}`)
        },
        release() {},
      }
    },
    async query(sql: string, values: unknown[] = []) {
      sqlCalls.push({ sql, values })
      if (sql.includes('SELECT count(file.id)')) return { rows: [{ count: 1 }], rowCount: 1 }
      if (sql.includes('SELECT count(folder.id)')) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('SELECT file.id FROM files')) {
        if (fileReturned) return { rows: [], rowCount: 0 }
        fileReturned = true
        return { rows: [{ id: 55 }], rowCount: 1 }
      }
      if (sql.includes('SELECT folder.id FROM folders')) return { rows: [], rowCount: 0 }
      if (sql.includes('SET lease_until=$3')) return { rows: [], rowCount: 1 }
      if (sql.includes('SET progress_current=progress_current+1')) return { rows: [], rowCount: 1 }
      if (sql.includes("SET status=$3,finished_at=$4,error_code=$5")) return { rows: [], rowCount: 1 }
      if (sql.includes('SET progress_current=$3')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected fake pool query: ${sql}`)
    },
  } as unknown as Pool

  const worker = startTrashPurgeWorker({
    pool: fakePool,
    deletes: {
      async hardDeleteFile(owner, id) { deleted.push([owner, id]) },
      async hardDeleteFolder(owner, id) { deleted.push([owner, id]) },
    },
    publisher: {
      async publishAuthStateChanged() { return true },
      async bumpContextRevision() { return true },
      async publishResourceChanged(value) { published.push({ kind: 'resource', value }); return true },
      async publishTrashPurgeProgress(value) { published.push({ kind: 'progress', value }); return true },
    },
    onError(error) { errors.push(error instanceof Error ? error.message : String(error)) },
  })

  try {
    const deadline = Date.now() + 1_000
    while (!published.some(item => item.kind === 'resource') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(errors, [])
    assert.ok(sqlCalls.length > 0, 'worker should claim a job')
    assert.deepEqual(deleted, [[ownerId, 55]])
    assert.deepEqual(published.map(item => item.kind), ['progress', 'progress', 'resource'])
    assert.equal(published[1]?.value.status, 'completed')
    assert.equal(published[1]?.value.progressCurrent, 1)
    assert.ok(sqlCalls.some(call => call.sql.includes('file.user_id=$1') && call.values[0] === ownerId))
  } finally { await worker.stop() }
})
