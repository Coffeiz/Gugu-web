import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { createPostgresOnboardingReseedOperations } from '../../src/modules/onboarding/reseed.js'

test('重播种删除项目文件并清理物理存储', async () => {
  const ownerId = randomUUID()
  const storageRoot = path.join(tmpdir(), `gugu-onboarding-reseed-${randomUUID()}`)
  const ownerRoot = path.join(storageRoot, ownerId, 'project')
  await mkdir(ownerRoot, { recursive: true })
  await writeFile(path.join(ownerRoot, 'active.md'), '123456')
  await writeFile(path.join(ownerRoot, 'trashed.md'), '1234')
  const files = [
    { path: `${ownerId}/project/active.md`, size_bytes: 6, deleted_at: null },
    { path: `${ownerId}/project/trashed.md`, size_bytes: 4, deleted_at: '2026-11-16T00:00:00Z' },
  ]
  const client = {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
      if (sql.includes('SELECT path,size_bytes,deleted_at FROM files')) {
        assert.deepEqual(values, [ownerId, 41])
        return { rows: files as unknown as Row[], rowCount: files.length }
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
    assert.deepEqual(keys, files.map(file => file.path))

    for (const key of keys) await operations.removeStorage(ownerId, key)
    await assert.rejects(readFile(path.join(ownerRoot, 'active.md')))
    await assert.rejects(readFile(path.join(ownerRoot, 'trashed.md')))
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})
