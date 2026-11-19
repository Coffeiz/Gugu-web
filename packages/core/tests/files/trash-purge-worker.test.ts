import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runTrashPurgeJob, type TrashPurgeEntry, type TrashPurgeJobLease } from '../../src/files/trash-purge-worker.js'

const lease: TrashPurgeJobLease = {
  id: 7, userId: '00000000-0000-4000-8000-000000000007', snapshotAt: new Date('2026-11-18T00:00:00Z'),
  progressCurrent: 0, progressTotal: 2, failedCount: 0,
}

function ports(entries: TrashPurgeEntry[][]) {
  const calls: string[] = []
  let batch = 0
  return {
    calls,
    value: {
      async renew() { calls.push('renew'); return true },
      async nextBatch() { calls.push('next'); return entries[batch++] ?? [] },
      async deleteEntry(_job: TrashPurgeJobLease, entry: TrashPurgeEntry) { calls.push(`delete:${entry.kind}:${entry.id}`) },
      async advance() { calls.push('advance'); return true },
      async finish(_id: number, _owner: string, status: 'completed' | 'failed', _errorCode: string | null, progress: number) {
        calls.push(`finish:${status}:${progress}`); return true
      },
      async publishProgress(job: TrashPurgeJobLease) { calls.push(`progress:${job.status}:${job.progressCurrent}`) },
      async publishFilesChanged() { calls.push('files-changed') },
    },
  }
}

test('trash purge processes the snapshot in batches and publishes final completion', async () => {
  const fake = ports([[{ kind: 'file', id: 1 }], [{ kind: 'folder', id: 2 }], []])
  await runTrashPurgeJob(lease, 'worker-a', fake.value, { leaseRenewMs: 60_000 })
  assert.deepEqual(fake.calls, [
    'next', 'delete:file:1', 'advance', 'progress:running:1', 'next', 'delete:folder:2', 'advance',
    'progress:running:2', 'next', 'finish:completed:2', 'progress:completed:2', 'files-changed',
  ])
})

test('trash purge failure marks only the claimed job failed and preserves committed progress', async () => {
  const fake = ports([[{ kind: 'file', id: 1 }, { kind: 'file', id: 2 }]])
  fake.value.deleteEntry = async (_job, entry) => {
    fake.calls.push(`delete:${entry.kind}:${entry.id}`)
    if (entry.id === 2) throw new Error('synthetic delete failure')
  }
  const errors: string[] = []
  await runTrashPurgeJob(lease, 'worker-a', fake.value, {
    leaseRenewMs: 60_000,
    onError: error => errors.push(error instanceof Error ? error.message : String(error)),
  })
  assert.deepEqual(errors, ['synthetic delete failure'])
  assert.ok(fake.calls.includes('finish:failed:1'))
  assert.ok(fake.calls.includes('progress:failed:1'))
  assert.equal(fake.calls.includes('files-changed'), false)
})

test('trash purge stops deleting as soon as its lease is lost', async () => {
  const fake = ports([[{ kind: 'file', id: 1 }, { kind: 'file', id: 2 }]])
  fake.value.advance = async () => { fake.calls.push('advance'); return false }
  await runTrashPurgeJob(lease, 'worker-a', fake.value, { leaseRenewMs: 60_000 })
  assert.ok(fake.calls.includes('delete:file:1'))
  assert.equal(fake.calls.includes('delete:file:2'), false)
  assert.equal(fake.calls.some(call => call.startsWith('finish:')), false)
})
