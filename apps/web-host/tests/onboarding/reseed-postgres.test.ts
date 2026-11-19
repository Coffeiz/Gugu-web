import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { createPostgresOnboardingReseedOperations } from '../../src/modules/onboarding/reseed.js'

test('重播种删除项目全部文件字节后，配额账本与永久删除事件同时扣减', async () => {
  const ownerId = randomUUID()
  const storageRoot = path.join(tmpdir(), `gugu-onboarding-reseed-${randomUUID()}`)
  const ownerRoot = path.join(storageRoot, ownerId, 'project')
  await mkdir(ownerRoot, { recursive: true })
  await writeFile(path.join(ownerRoot, 'active.md'), '123456')
  await writeFile(path.join(ownerRoot, 'trashed.md'), '1234')
  const files = [
    { id: 71, storage_key: `${ownerId}/project/active.md`, size_bytes: 6, deleted_at: null },
    { id: 72, storage_key: `${ownerId}/project/trashed.md`, size_bytes: 4, deleted_at: '2026-11-16T00:00:00Z' },
  ]
  const quotaEvents: unknown[][] = []
  let ledgerAfterDelete = 10
  const client = {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
      if (sql.includes('SELECT used_bytes FROM storage_quota_ledgers'))
        return { rows: [{ used_bytes: ledgerAfterDelete }] as unknown as Row[], rowCount: 1 }
      if (sql.includes('SELECT id,storage_key,size_bytes,deleted_at FROM files')) {
        assert.deepEqual(values, [ownerId, 41])
        return { rows: files as unknown as Row[], rowCount: files.length }
      }
      if (sql.includes('INSERT INTO storage_quota_events')) {
        quotaEvents.push(values)
        return { rows: [], rowCount: 1 } as never
      }
      if (sql.includes('UPDATE storage_quota_ledgers')) {
        ledgerAfterDelete = Number(values[1])
        return { rows: [], rowCount: 1 } as never
      }
      return { rows: [], rowCount: 1 } as never
    },
    release() {},
  }
  const pool = {
    async connect() { return client },
    async query() { return { rows: [], rowCount: 0 } },
  } as unknown as Pick<Pool, 'connect' | 'query'>

  try {
    const operations = createPostgresOnboardingReseedOperations(pool, storageRoot)
    const keys = await operations.removeSeedProject(ownerId, 41)
    assert.deepEqual(keys, files.map(file => file.storage_key))
    assert.equal(ledgerAfterDelete, 0)
    assert.deepEqual(quotaEvents.map(values => values[1]), [-6, -4])

    for (const key of keys) await operations.removeStorage(ownerId, key)
    await assert.rejects(readFile(path.join(ownerRoot, 'active.md')))
    await assert.rejects(readFile(path.join(ownerRoot, 'trashed.md')))
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})
