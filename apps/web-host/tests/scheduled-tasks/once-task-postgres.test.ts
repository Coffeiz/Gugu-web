import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresOnceTaskRepository } from '../../src/modules/scheduled-tasks/schedule/once.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('一次性任务并发开始仅一次成功，失败后可重试且完成删除限制 owner', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `task_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE scheduled_tasks (id integer primary key, user_id uuid, enabled boolean, schedule_kind text, start_at timestamptz, last_run_at timestamptz, last_run_failed boolean);
      CREATE TABLE rag_index_jobs(id bigserial PRIMARY KEY,user_id uuid NOT NULL,source_type text NOT NULL,source_id varchar(255) NOT NULL,pending_source_ids json,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation int NOT NULL,completed_generation int NOT NULL,attempts int NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_error_code text,last_started_at timestamptz,last_succeeded_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type))`)
    await pool.query(`INSERT INTO scheduled_tasks VALUES (1,'11111111-1111-4111-8111-111111111111',true,'once',now(),NULL,NULL)`)
    const repo = createPostgresOnceTaskRepository(pool)
    const owner = '11111111-1111-4111-8111-111111111111'
    const other = '22222222-2222-4222-8222-222222222222'
    assert.equal(await repo.markStarted('1', 1000, other), false)
    const results = await Promise.all([repo.markStarted('1', 1000, owner), repo.markStarted('1', 1000, owner)])
    assert.equal(results.filter(Boolean).length, 1)
    await repo.markFailed('1', other)
    assert.equal((await repo.getOnce('1'))?.lastRunFailed, false)
    await repo.markFailed('1', owner)
    assert.equal(await repo.markStarted('1', 2000, owner), true)
    await repo.deleteCompleted('1', '22222222-2222-4222-8222-222222222222')
    assert.ok(await repo.getOnce('1'))
    await repo.deleteCompleted('1', '11111111-1111-4111-8111-111111111111')
    assert.equal(await repo.getOnce('1'), null)
    const job = (await pool.query(`SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='scheduled_task'`, ['11111111-1111-4111-8111-111111111111'])).rows[0]
    assert.deepEqual(job, { source_id: '1', pending_source_ids: ['1'], generation: 1 })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
