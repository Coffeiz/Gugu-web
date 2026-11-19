import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { applyAgentBaseMigration } from '../../src/migrations/agent-base-migrate.js'
import { applyWebDomainMigration } from '../../src/migrations/web-domain-migrate.js'
import { applyTrashPurgeMigration } from '../../src/migrations/trash-purge-migrate.js'
import { createPostgresTrashMutationOperations } from '../../src/modules/files/persistence/trash-mutations-postgres.js'
import { createPostgresTrashPurgeOperations } from '../../src/modules/files/persistence/trash-purge-postgres.js'
import { startTrashPurgeWorker } from '../../src/modules/files/trash-purge-worker.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('正式清空表迁移可由 Node Worker 按快照永久删除 owner 文件并保留异主文件', {
  skip: !url ? '需要隔离 PostgreSQL' : process.platform !== 'linux' && '安全的授权根目录暂存仅在 Linux Host 启用', timeout: 20_000,
}, async () => {
  const schema = `trash_purge_runtime_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-trash-purge-runtime-'))
  let worker: ReturnType<typeof startTrashPurgeWorker> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await applyAgentBaseMigration(pool)
    await applyWebDomainMigration(pool)
    await applyTrashPurgeMigration(pool)
    const owner = randomUUID(), foreign = randomUUID()
    await pool.query(`INSERT INTO users(id,username,email,hashed_password)
      VALUES($1,'小北','north@example.test','synthetic'),($2,'小南','south@example.test','synthetic')`, [owner, foreign])
    const ownerPath = join(storageRoot, owner, 'trash-e2e.txt')
    const foreignPath = join(storageRoot, foreign, 'trash-e2e.txt')
    await mkdir(join(storageRoot, owner), { recursive: true })
    await mkdir(join(storageRoot, foreign), { recursive: true })
    await writeFile(ownerPath, 'owner 回收站合成文件')
    await writeFile(foreignPath, '异主回收站合成文件')
    const files = await pool.query<{ id: number }>(`INSERT INTO files(user_id,display_name,ext,space,storage_key,size_bytes,deleted_at)
      VALUES($1,'owner 回收站文件','txt','personal',$2,0,now()),($3,'异主回收站文件','txt','personal',$4,0,now()) RETURNING id`,
    [owner, `${owner}/trash-e2e.txt`, foreign, `${foreign}/trash-e2e.txt`])
    const ownerFile = files.rows[0]!.id
    const operations = createPostgresTrashPurgeOperations(pool, { async notifyWorker() {} })
    const queued = await operations.startEmpty(owner)
    assert.deepEqual({ status: queued.status, progressTotal: queued.progressTotal }, { status: 'queued', progressTotal: 1 })
    worker = startTrashPurgeWorker({
      pool,
      deletes: createPostgresTrashMutationOperations(pool, { storageRoot, async publishChanged() {} }),
      publisher: {
        async publishTrashPurgeProgress() { return true },
        async publishResourceChanged() { return true },
      } as never,
      onError(error) { throw error instanceof Error ? error : new Error('回收站 Worker 失败') },
    })
    const deadline = Date.now() + 8000
    let completed = false
    while (!completed) {
      const job = await pool.query<{ status: string; progress_current: number; progress_total: number }>(
        'SELECT status,progress_current,progress_total FROM trash_purge_jobs WHERE id=$1', [queued.id],
      )
      const remaining = await pool.query('SELECT id FROM files WHERE id=$1 AND user_id=$2', [ownerFile, owner])
      completed = job.rows[0]?.status === 'completed' && remaining.rowCount === 0
      if (completed) break
      if (Date.now() > deadline) throw new Error(`Node Worker 清空任务未完成：${JSON.stringify(job.rows)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await assert.rejects(stat(ownerPath), { code: 'ENOENT' })
    await stat(foreignPath)
    assert.equal((await pool.query('SELECT id FROM files WHERE user_id=$1', [foreign])).rowCount, 1)
    assert.deepEqual((await pool.query<{ status: string; progress_current: number; progress_total: number }>(
      'SELECT status,progress_current,progress_total FROM trash_purge_jobs WHERE id=$1', [queued.id],
    )).rows, [{ status: 'completed', progress_current: 1, progress_total: 1 }])
  } finally {
    await worker?.stop()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally {
      await admin.end()
      await rm(storageRoot, { recursive: true, force: true })
    }
  }
})
