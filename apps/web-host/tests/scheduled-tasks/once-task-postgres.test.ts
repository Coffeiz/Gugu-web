import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresOnceTaskRepository } from '../../src/modules/scheduled-tasks/persistence/once-task-postgres.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('一次性任务并发开始仅一次成功，失败后可重试且完成删除限制 owner', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `task_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE scheduled_tasks (id integer primary key, user_id uuid, enabled boolean, schedule_kind text, start_at timestamptz, last_run_at timestamptz, last_run_failed boolean)`)
    await pool.query(`INSERT INTO scheduled_tasks VALUES (1,'11111111-1111-4111-8111-111111111111',true,'once',now(),NULL,NULL)`)
    const repo = createPostgresOnceTaskRepository(pool)
    const results = await Promise.all([repo.markStarted('1', 1000), repo.markStarted('1', 1000)])
    assert.equal(results.filter(Boolean).length, 1)
    await repo.markFailed('1')
    assert.equal(await repo.markStarted('1', 2000), true)
    await repo.deleteCompleted('1', '22222222-2222-4222-8222-222222222222')
    assert.ok(await repo.getOnce('1'))
    await repo.deleteCompleted('1', '11111111-1111-4111-8111-111111111111')
    assert.equal(await repo.getOnce('1'), null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
