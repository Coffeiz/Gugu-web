import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { applyAgentBaseMigration } from '../../src/migrations/agent-base-migrate.js'
import { applyTrashPurgeMigration, checkTrashPurgeMigration } from '../../src/migrations/trash-purge-migrate.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Node 回收站清空迁移建立 owner job、并发门与可验证索引', {
  skip: !url && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `trash_purge_migration_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await assert.rejects(applyTrashPurgeMigration(pool), { code: 'incompatible' })
    await applyAgentBaseMigration(pool)
    assert.equal(await checkTrashPurgeMigration(pool), 'pending')
    assert.deepEqual((await Promise.all([applyTrashPurgeMigration(pool), applyTrashPurgeMigration(pool)])).sort(),
      ['applied', 'unchanged'])
    assert.equal(await checkTrashPurgeMigration(pool), 'applied')

    const owner = randomUUID(), other = randomUUID(), third = randomUUID()
    await pool.query(`INSERT INTO users(id,username,email,hashed_password)
      VALUES($1,'小北','north@example.test','synthetic'),($2,'小南','south@example.test','synthetic'),
        ($3,'小西','west@example.test','synthetic')`, [owner, other, third])
    const created = await pool.query<{ id: number }>(`INSERT INTO trash_purge_jobs(user_id,status,snapshot_at,progress_total)
      VALUES($1,'queued',now(),2) RETURNING id`, [owner])
    const operationId = randomUUID()
    await pool.query(`INSERT INTO trash_purge_agent_operations
      (operation_id,user_id,job_id,snapshot_digest,file_count,folder_count) VALUES($1,$2,$3,$4,2,0)`,
    [operationId, owner, created.rows[0]!.id, 'a'.repeat(64)])
    await assert.rejects(pool.query(`INSERT INTO trash_purge_agent_operations
      (operation_id,user_id,job_id,snapshot_digest,file_count,folder_count) VALUES($1,$2,$3,$4,2,0)`,
    [operationId, owner, created.rows[0]!.id, 'a'.repeat(64)]), { code: '23505' },
    '一个 Agent 操作 ID 只能关联一个持久 purge job')
    await assert.rejects(pool.query(`INSERT INTO trash_purge_jobs(user_id,status,snapshot_at)
      VALUES($1,'queued',now())`, [owner]), { code: '23505' }, '同一 owner 不能并行排入第二个清空任务')
    await pool.query(`INSERT INTO trash_purge_jobs(user_id,status,snapshot_at)
      VALUES($1,'running',now())`, [other])
    await assert.rejects(pool.query(`INSERT INTO trash_purge_jobs(user_id,status,snapshot_at)
      VALUES($1,'running',now())`, [third]), { code: '23505' }, '同一时间只能有一个全局运行中的清空任务')
    await assert.rejects(pool.query(`INSERT INTO trash_purge_jobs(user_id,status,snapshot_at)
      VALUES($1,'unknown',now())`, [other]), { code: '23514' })
    await pool.query('DELETE FROM users WHERE id=$1', [owner])
    assert.equal((await pool.query('SELECT 1 FROM trash_purge_jobs WHERE user_id=$1', [owner])).rowCount, 0,
      '删除 owner 后必须级联删除其回收站任务')
    assert.equal((await pool.query('SELECT 1 FROM trash_purge_agent_operations WHERE user_id=$1', [owner])).rowCount, 0,
      '删除 owner 后必须级联删除 Agent job 关联')

    await pool.query('DROP INDEX ix_trash_purge_jobs_claim')
    await assert.rejects(checkTrashPurgeMigration(pool), { code: 'incompatible' },
      '迁移验收必须检测领取索引缺失')
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
