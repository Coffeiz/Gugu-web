import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { test } from 'vitest'
import { createScheduledTaskDeleter, ScheduledTaskNotFound } from '../../../src/scheduled-tasks/task-delete.js'
import { createKyselyScheduledTaskDeleteRuntime } from '../../../src/scheduled-tasks/task-delete-data.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createPostgresRuntime } from '../../../src/data/postgres.js'
import { tablesSql } from '../../../src/data/schema.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('任务删除双库回归必须显式提供隔离 PostgreSQL')
async function contract<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres', owner: string = randomUUID()) {
  const other = randomUUID(), user = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const now = new Date().toISOString()
  await sql`INSERT INTO scheduled_tasks(user_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at)
    VALUES(${user},'任务','{}','* * * * *','cron','web',${backend === 'sqlite' ? 1 : true},${now},${now})`.execute(db)
  const events: number[] = []
  const runtime = createKyselyScheduledTaskDeleteRuntime(db, backend, async (_owner, id) => {
    const remaining = await sql`SELECT id FROM scheduled_tasks WHERE id=${id}`.execute(db)
    assert.equal(remaining.rows.length, 0)
    assert.equal((await sql`SELECT id FROM rag_index_jobs WHERE user_id=${user} AND source_type='scheduled_task'`.execute(db)).rows.length, 1)
    events.push(id)
  })
  const remove = createScheduledTaskDeleter(runtime)
  await assert.rejects(remove(other, 1, null), ScheduledTaskNotFound)
  const outcomes = await Promise.allSettled([remove(owner, 1, 'tab'), remove(owner, 1, 'tab')])
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(x => x.status === 'rejected' && x.reason instanceof ScheduledTaskNotFound).length, 1)
  assert.deepEqual(events, [1])
  const firstJob = (await sql<{ source_id: string; pending_source_ids: unknown; generation: number }>`SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=${user} AND source_type='scheduled_task'`.execute(db)).rows[0]!
  assert.equal(firstJob.source_id, '1')
  assert.equal(firstJob.generation, 1)
  assert.deepEqual(typeof firstJob.pending_source_ids === 'string' ? JSON.parse(firstJob.pending_source_ids) : firstJob.pending_source_ids, ['1'])
  const inserted = await sql<{ id: number }>`INSERT INTO scheduled_tasks(user_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at)
    VALUES(${user},'另一任务','{}','* * * * *','cron','web',${backend === 'sqlite' ? 1 : true},${now},${now}) RETURNING id`.execute(db)
  const nextId = Number(inserted.rows[0]!.id)
  const failure = createScheduledTaskDeleter({ ...runtime, async publish() { throw new Error('通知失败') } })
  await assert.rejects(failure(owner, nextId, null), /通知失败/)
  assert.equal((await sql`SELECT id FROM scheduled_tasks WHERE id=${nextId}`.execute(db)).rows.length, 0)
  await assert.rejects(createScheduledTaskDeleter({ ...runtime, async deleteOwned() { throw new Error('数据库失败') } })(owner, 3, null), /数据库失败/)
  assert.deepEqual(events, [1])
}
test('显式任务删除在正式 SQLite 与隔离 PostgreSQL 保持 owner、并发和提交后事件', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-task-delete-')), path = join(folder, 'core.db')
  const schema = `task_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`)
  try {
    await initializeSqlite(path)
    const { runtime: sqlite, ownerId } = await openSqliteRuntime(path)
    try { await contract(sqlite.db, 'sqlite', ownerId) } finally { await sqlite.close() }
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(tablesSql('postgres').scheduledTasks)
    await admin.query(tablesSql('postgres').ragJobs)
    const postgres = await createPostgresRuntime({ url: url!, schema })
    try { await contract(postgres.db, 'postgres') } finally { await postgres.close() }
  } finally { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(folder, { recursive: true, force: true }) }
})
