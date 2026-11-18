import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { Kysely, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { tablesSql } from '../../src/data/schema.js'
import { createScheduledTaskDeleter, ScheduledTaskNotFound } from '../../src/scheduled-tasks/task-delete.js'
import { createKyselyScheduledTaskDeleteRuntime } from '../../src/scheduled-tasks/task-delete-data.js'
import { createKyselyScheduledTaskRagReader } from '../../src/scheduled-tasks/task-list.js'
import { createScheduledTaskRagSource } from '../../src/agent/rag/scheduled-task-source.js'
import { createSqlRagRebuildWorker } from '../../src/agent/rag/rebuild-worker.js'

test('定时任务删除与 RAG 墓碑队列原子提交并保持 owner 隔离', async () => {
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
  const ownerId = randomUUID(), otherOwner = randomUUID(), user = ownerId.replaceAll('-', '')
  try {
    await sql.raw(tablesSql('sqlite').scheduledTasks).execute(db)
    await sql.raw(tablesSql('sqlite').ragJobs).execute(db)
    await sql.raw(tablesSql('sqlite').ragIndexEntries).execute(db)
    await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at)
      VALUES(1,${user},'task','','* * * * *','cron','web',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`.execute(db)
    // 队列用数据库墙钟写入 next_attempt_at，测试 Worker 的时钟在该写入之后。
    const now = new Date(Date.now() + 60_000)
    const worker = createSqlRagRebuildWorker(db, 'sqlite', {
      scheduled_task: createScheduledTaskRagSource(createKyselyScheduledTaskRagReader(db, 'sqlite')),
    }, () => now)
    await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
      VALUES(${user},'scheduled_task','1','[]','','upsert','queued',1,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`.execute(db)
    assert.equal(await worker(), 'ready')
    assert.equal((await sql`SELECT id FROM knowledge_index_entries WHERE owner_user_id=${user} AND source_type='scheduled_task' AND source_id='1' AND deleted_at IS NULL`.execute(db)).rows.length, 1)
    const publish = async () => {}
    const remove = createScheduledTaskDeleter(createKyselyScheduledTaskDeleteRuntime(db, 'sqlite', publish))

    await assert.rejects(remove(otherOwner, 1, null), ScheduledTaskNotFound)
    assert.equal((await sql`SELECT id FROM scheduled_tasks WHERE id=1`.execute(db)).rows.length, 1)
    assert.equal((await sql`SELECT id FROM rag_index_jobs WHERE user_id=${user} AND source_type='scheduled_task' AND generation=1`.execute(db)).rows.length, 1)

    await remove(ownerId, 1, null)
    assert.equal((await sql`SELECT id FROM scheduled_tasks WHERE id=1`.execute(db)).rows.length, 0)
    const queued = (await sql<{ source_id: string; pending_source_ids: string; generation: number }>`
      SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=${user} AND source_type='scheduled_task'`.execute(db)).rows[0]
    assert.equal(queued?.source_id, '1')
    assert.deepEqual(JSON.parse(queued?.pending_source_ids ?? '[]'), ['1'])
    assert.equal(Number(queued?.generation), 2)

    assert.equal(await worker(), 'ready')
    assert.equal((await sql`SELECT id FROM knowledge_index_entries WHERE owner_user_id=${user} AND source_type='scheduled_task' AND source_id='1' AND deleted_at IS NULL`.execute(db)).rows.length, 0)
    assert.equal((await sql`SELECT id FROM knowledge_index_entries WHERE owner_user_id=${user} AND source_type='scheduled_task' AND source_id='1' AND deleted_at IS NOT NULL`.execute(db)).rows.length, 1)

    await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at)
      VALUES(2,${user},'task','','* * * * *','cron','web',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`.execute(db)
    await sql`CREATE TRIGGER fail_rag_enqueue BEFORE INSERT ON rag_index_jobs
      WHEN NEW.source_type='scheduled_task' BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END`.execute(db)
    await assert.rejects(remove(ownerId, 2, null), /synthetic queue failure/)
    assert.equal((await sql`SELECT id FROM scheduled_tasks WHERE id=2 AND user_id=${user}`.execute(db)).rows.length, 1)
    assert.equal((await sql`SELECT generation FROM rag_index_jobs WHERE user_id=${user} AND source_type='scheduled_task'`.execute(db)).rows[0]?.generation, 2)
  } finally {
    await db.destroy()
  }
})
