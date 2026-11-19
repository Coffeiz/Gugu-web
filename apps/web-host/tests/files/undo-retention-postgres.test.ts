import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import test from 'node:test'
import { cleanupExpiredUndoArtifacts } from '../../src/maintenance/undo-retention.js'
import { createLocalUndoRetentionStorage } from '../../src/modules/files/undo-retention-storage.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'

test('Undo 保留清理删除到期正文与旧错位目录，并保留未到期记录', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL Undo 保留清理回归',
}, async () => {
  const schema = `gugu_undo_retention_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-undo-retention-'))
  const oldOperationId = `op-${'a'.repeat(32)}`
  const legacyArtifactId = `op-${'b'.repeat(32)}`
  const prefix = `${ownerId}/.undo/${legacyArtifactId}/file-7`
  try {
    await pool.query(`
      CREATE TABLE undo_operations (
        id text PRIMARY KEY, user_id uuid NOT NULL, artifact_refs jsonb NOT NULL,
        status text NOT NULL, expires_at timestamptz, failure_code text
      );
    `)
    await pool.query(`
      INSERT INTO undo_operations (id,user_id,artifact_refs,status,expires_at,failure_code) VALUES
        ($1,$2,$3::jsonb,'active',CURRENT_TIMESTAMP - INTERVAL '1 minute',NULL),
        ('redo-expired',$2,$4::jsonb,'expired',NULL,'redo_cleared_by_new_operation'),
        ('undo-expired',$2,$5::jsonb,'expired',NULL,'retention_expired'),
        ('still-live',$2,'{}'::jsonb,'active',CURRENT_TIMESTAMP + INTERVAL '1 day',NULL)
    `, [oldOperationId, ownerId,
      JSON.stringify({ 'file:7': { before_key: `${prefix}/before`, after_key: `${prefix}/after` } }),
      JSON.stringify({ 'file:8': { before_key: `${ownerId}/.undo/${oldOperationId}/file-8/before` } }),
      JSON.stringify({ 'file:10': { before_key: `${ownerId}/.undo/${legacyArtifactId}/file-10/before` } }),
    ])
    for (const key of [`${prefix}/before`, `${prefix}/after`, `${ownerId}/.undo/${oldOperationId}/file-8/before`, `${ownerId}/.undo/${legacyArtifactId}/file-10/before`]) {
      const target = path.join(root, key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, key)
    }

    const result = await cleanupExpiredUndoArtifacts(pool, createLocalUndoRetentionStorage(root), new Date(), 10)

    assert.deepEqual(result, { expired: 3, artifacts: 4, failed: 0 })
    await assert.rejects(readFile(path.join(root, `${prefix}/before`)))
    await assert.rejects(readFile(path.join(root, `${prefix}/after`)))
    await assert.rejects(readFile(path.join(root, `${ownerId}/.undo/${oldOperationId}/file-8/before`)))
    await assert.rejects(readFile(path.join(root, `${ownerId}/.undo/${legacyArtifactId}/file-10/before`)))
    const rows = await pool.query<{ id: string; status: string; failure_code: string | null; artifact_refs: Record<string, unknown> }>(
      'SELECT id,status,failure_code,artifact_refs FROM undo_operations ORDER BY id',
    )
    assert.deepEqual(rows.rows, [
      { id: oldOperationId, status: 'expired', failure_code: 'retention_expired', artifact_refs: {} },
      { id: 'redo-expired', status: 'expired', failure_code: 'redo_artifacts_cleaned', artifact_refs: {} },
      { id: 'undo-expired', status: 'expired', failure_code: 'retention_expired', artifact_refs: {} },
      { id: 'still-live', status: 'active', failure_code: null, artifact_refs: {} },
    ])

    const retryId = `op-${'c'.repeat(32)}`
    const retryKey = `${ownerId}/.undo/${retryId}/file-9/before`
    await pool.query(`INSERT INTO undo_operations (id,user_id,artifact_refs,status,expires_at) VALUES ($1,$2,$3::jsonb,'active',CURRENT_TIMESTAMP - INTERVAL '1 minute')`, [
      retryId, ownerId, JSON.stringify({ 'file:9': { before_key: retryKey } }),
    ])
    await mkdir(path.dirname(path.join(root, retryKey)), { recursive: true })
    await writeFile(path.join(root, retryKey), 'retry')
    const localStorage = createLocalUndoRetentionStorage(root)
    let failOnce = true
    const transientStorage = {
      async removePrefix(user: string, prefix: string) {
        if (failOnce) { failOnce = false; throw new Error('模拟存储暂不可用') }
        return localStorage.removePrefix(user, prefix)
      },
    }
    assert.deepEqual(await cleanupExpiredUndoArtifacts(pool, transientStorage, new Date(), 10), { expired: 0, artifacts: 0, failed: 1 })
    assert.equal((await pool.query<{ status: string; artifact_refs: Record<string, unknown> }>(
      'SELECT status,artifact_refs FROM undo_operations WHERE id=$1', [retryId],
    )).rows[0]?.status, 'active')
    assert.equal(await readFile(path.join(root, retryKey), 'utf8'), 'retry')
    assert.deepEqual(await cleanupExpiredUndoArtifacts(pool, localStorage, new Date(), 10), { expired: 1, artifacts: 1, failed: 0 })
    await assert.rejects(readFile(path.join(root, retryKey)))
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})

test('Undo artifact 删除失败时保留记录与引用，后续清理可重试', async () => {
  const operationId = `op-${'e'.repeat(32)}`
  const row = {
    id: operationId, user_id: ownerId, status: 'active', failure_code: null,
    artifact_refs: { 'file:3': { before_key: `${ownerId}/.undo/${operationId}/file-3/before` } },
  }
  let failedOnce = false
  const storage = {
    async removePrefix() {
      if (!failedOnce) { failedOnce = true; throw new Error('模拟文件系统暂不可用') }
      return 1
    },
  }
  const client = {
    async query(text: string, parameters: unknown[] = []) {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (text.startsWith('SELECT id,user_id,artifact_refs,failure_code')) return { rows: [{ ...row }] }
      if (text.startsWith('UPDATE undo_operations SET status=')) {
        row.status = String(parameters[2])
        row.failure_code = String(parameters[3])
        row.artifact_refs = JSON.parse(String(parameters[4]))
        return { rows: [], rowCount: 1 }
      }
      throw new Error('测试数据库收到未知操作')
    },
    release() {},
  } as unknown as PoolClient
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>

  assert.deepEqual(await cleanupExpiredUndoArtifacts(pool, storage, new Date(), 10), { expired: 0, artifacts: 0, failed: 1 })
  assert.equal(row.status, 'active')
  assert.equal(Object.keys(row.artifact_refs).length, 1)
  assert.deepEqual(await cleanupExpiredUndoArtifacts(pool, storage, new Date(), 10), { expired: 1, artifacts: 1, failed: 0 })
  assert.equal(row.status, 'expired')
  assert.equal(row.failure_code, 'retention_expired')
  assert.deepEqual(row.artifact_refs, {})
})
