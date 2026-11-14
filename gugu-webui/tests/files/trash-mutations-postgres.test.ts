import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import type { Pool as PoolType, PoolClient } from 'pg'
import { createPostgresTrashMutationOperations } from '../../src/domains/files/persistence/trash-mutations-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'

function fakeMutationPool(file: { id: number; user_id: string; storage_key: string; size_bytes: number }, usedBytes: number) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql.includes('SELECT id,storage_key,size_bytes FROM files'))
        return { rows: [file], rowCount: 1 }
      if (sql.includes('SELECT used_bytes FROM storage_quota_ledgers'))
        return { rows: [{ used_bytes: usedBytes }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client } as unknown as PoolType, client: client as unknown as PoolClient, calls }
}

test('Local 永久删除在提交后发布事件；旧配额低于待删文件时先按物理用量校准', async () => {
  const storageRoot = path.join(tmpdir(), `gugu-trash-reconcile-${randomUUID()}`)
  const trashDir = path.join(storageRoot, ownerId, 'trash')
  await mkdir(trashDir, { recursive: true })
  await writeFile(path.join(trashDir, 'large.txt'), '12345')
  await writeFile(path.join(trashDir, 'other.txt'), 'abc')
  const file = { id: 41, user_id: ownerId, storage_key: `${ownerId}/trash/large.txt`, size_bytes: 5 }
  const { pool, calls } = fakeMutationPool(file, 2)
  let publishedAfterCommit = false
  try {
    const operations = createPostgresTrashMutationOperations(pool, {
      storageRoot,
      async publishChanged() {
        publishedAfterCommit = calls.at(-1)?.sql === 'COMMIT'
      },
    })
    await operations.hardDeleteFile(ownerId, file.id, 'synthetic-client')
    assert.equal(publishedAfterCommit, true)
    assert.equal(await readFile(path.join(trashDir, 'large.txt'), 'utf8').then(() => true, () => false), false)
    assert.ok(calls.some((call) => call.sql.includes("'reconcile'")))
    assert.ok(calls.some((call) => call.sql.includes("'trash_permanent_delete'")))
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('Local 永久删除拒绝跨用户存储键且不触碰外部文件', async () => {
  const storageRoot = path.join(tmpdir(), `gugu-trash-owner-${randomUUID()}`)
  const foreignDir = path.join(storageRoot, '22222222-2222-4222-8222-222222222222')
  await mkdir(foreignDir, { recursive: true })
  await writeFile(path.join(foreignDir, 'secret.txt'), 'keep')
  const file = {
    id: 42, user_id: ownerId,
    storage_key: '22222222-2222-4222-8222-222222222222/secret.txt', size_bytes: 4,
  }
  const { pool } = fakeMutationPool(file, 4)
  try {
    await createPostgresTrashMutationOperations(pool, {
      storageRoot, async publishChanged() {},
    }).hardDeleteFile(ownerId, file.id, 'synthetic-client')
    assert.equal(await readFile(path.join(foreignDir, 'secret.txt'), 'utf8'), 'keep')
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('Local 永久删除文件夹子树只扣除成功删除的实体文件并在提交后逐项通知', async () => {
  const storageRoot = path.join(tmpdir(), `gugu-trash-tree-${randomUUID()}`)
  const trashDir = path.join(storageRoot, ownerId, 'trash')
  await mkdir(trashDir, { recursive: true })
  await writeFile(path.join(trashDir, 'root.txt'), '12345')
  const calls: string[] = []
  const files = [
    { id: 51, storage_key: `${ownerId}/trash/root.txt`, size_bytes: 5 },
    { id: 52, storage_key: `${ownerId}/trash/missing.txt`, size_bytes: 4 },
  ]
  const client = {
    async query(sql: string) {
      calls.push(sql)
      if (sql.includes('SELECT folder.id FROM folders')) return { rows: [{ id: 20 }], rowCount: 1 }
      if (sql.includes('WITH RECURSIVE descendants')) return { rows: [{ id: 20 }, { id: 21 }], rowCount: 2 }
      if (sql.includes('SELECT id,storage_key,size_bytes FROM files'))
        return { rows: files.map((file) => ({ ...file, user_id: ownerId })), rowCount: files.length }
      if (sql.includes('SELECT used_bytes FROM storage_quota_ledgers'))
        return { rows: [{ used_bytes: 9 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const events: Array<{ id: number; type: string; afterCommit: boolean }> = []
  try {
    await createPostgresTrashMutationOperations({ connect: async () => client } as unknown as PoolType, {
      storageRoot,
      async publishChanged(event) {
        events.push({ id: event.entityId, type: event.entityType, afterCommit: calls.at(-1) === 'COMMIT' })
      },
    }).hardDeleteFolder(ownerId, 20, 'synthetic-client')
    assert.ok(calls.includes('COMMIT'))
    assert.deepEqual(events, [
      { id: 51, type: 'file', afterCommit: true },
      { id: 52, type: 'file', afterCommit: true },
      { id: 20, type: 'folder', afterCommit: true },
    ])
    assert.ok(calls.some((sql) => sql.includes("'trash_permanent_delete'")))
    assert.equal(await readFile(path.join(trashDir, 'root.txt'), 'utf8').then(() => true, () => false), false)
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('PostgreSQL Local 永久删除回收站目录子树并仅释放成功删除的文件配额', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 回收站删除回归',
}, async () => {
  const schema = `gugu_trash_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const storageRoot = path.join(tmpdir(), `gugu-trash-delete-${randomUUID()}`)
  const events: Array<{ id: number; type: string }> = []
  try {
    await pool.query(`
      CREATE TABLE files (
        id integer PRIMARY KEY, user_id uuid NOT NULL, storage_key text NOT NULL,
        size_bytes bigint NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE folders (
        id integer PRIMARY KEY, user_id uuid NOT NULL, parent_id integer, deleted_at timestamptz
      );
      CREATE TABLE storage_quota_ledgers (
        user_id uuid NOT NULL, category text NOT NULL, used_bytes bigint NOT NULL,
        status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id,category)
      );
      CREATE TABLE storage_quota_events (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, category text NOT NULL, operation text NOT NULL,
        delta_bytes bigint NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE, metadata_json jsonb, created_at timestamptz NOT NULL
      );
      INSERT INTO folders (id,user_id,parent_id,deleted_at) VALUES
        (20,'${ownerId}',NULL,CURRENT_TIMESTAMP),(21,'${ownerId}',20,CURRENT_TIMESTAMP);
      INSERT INTO files (id,user_id,storage_key,size_bytes,deleted_at) VALUES
        (1,'${ownerId}','${ownerId}/trash/root.txt',5,CURRENT_TIMESTAMP),
        (2,'${ownerId}','${ownerId}/trash/child.txt',4,CURRENT_TIMESTAMP);
      INSERT INTO storage_quota_ledgers (user_id,category,used_bytes,status)
        VALUES ('${ownerId}','file_library',9,'active');
    `)
    await mkdir(path.join(storageRoot, ownerId, 'trash'), { recursive: true })
    await writeFile(path.join(storageRoot, ownerId, 'trash', 'root.txt'), '12345')
    const operations = createPostgresTrashMutationOperations(pool, {
      storageRoot,
      async publishChanged(event) {
        if (event.entityType === 'file') {
          const file = await pool.query('SELECT id FROM files WHERE id=$1', [event.entityId])
          assert.equal(file.rowCount, 0)
        }
        events.push({ id: event.entityId, type: event.entityType })
      },
    })

    await operations.hardDeleteFolder(ownerId, 20, 'synthetic-client')

    assert.equal((await pool.query('SELECT id FROM folders')).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM files')).rowCount, 0)
    assert.equal(Number((await pool.query<{ used_bytes: number | string }>(
      'SELECT used_bytes FROM storage_quota_ledgers WHERE user_id=$1 AND category=$2', [ownerId, 'file_library'],
    )).rows[0]?.used_bytes), 4)
    assert.deepEqual((await pool.query<{ resource_id: string; delta_bytes: number | string }>(
      'SELECT resource_id,delta_bytes FROM storage_quota_events ORDER BY resource_id',
    )).rows.map((row) => [row.resource_id, Number(row.delta_bytes)]), [['1', -5]])
    assert.deepEqual(events, [{ id: 1, type: 'file' }, { id: 2, type: 'file' }, { id: 20, type: 'folder' }])
    assert.equal(await readFile(path.join(storageRoot, ownerId, 'trash', 'root.txt'), 'utf8').then(() => true, () => false), false)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
