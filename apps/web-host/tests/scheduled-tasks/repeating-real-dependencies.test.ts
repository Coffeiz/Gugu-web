import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createScheduledTaskRedisLease } from '../../src/modules/scheduled-tasks/persistence/redis-lease.js'
import { createPostgresScheduledFireReceipts } from '../../src/modules/scheduled-tasks/persistence/fire-receipts-postgres.js'
import { createPostgresRepeatingScheduleRecheck, createPostgresRepeatingSchedules } from '../../src/modules/scheduled-tasks/persistence/repeating-schedules-postgres.js'
import { dispatchRepeatingFire } from '../../src/modules/scheduled-tasks/repeating-dispatch.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const socket = process.env.GUGU_TEST_REDIS_SOCKET
const run = promisify(execFile)
test('真实 PG 和 Redis 下停用后的任务不执行、同一触发只领取一次', { skip: !url || !socket }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_repeat_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const cmd = async (...args: string[]) => (await run('redis-cli', ['-s', socket!, '--raw', ...args])).stdout.trim()
  const lease = createScheduledTaskRedisLease({ set: (key, value, ...options) => cmd('SET', key, value, ...options),
    eval: (script, count, ...args) => cmd('EVAL', script, String(count), ...args), exists: key => cmd('EXISTS', key) })
  try {
    await pool.query(`CREATE TABLE scheduled_tasks(id integer PRIMARY KEY,user_id uuid,enabled boolean,schedule_kind text,cron text,interval_minutes integer,start_at timestamptz,created_at timestamptz,end_at timestamptz)`)
    await pool.query(`CREATE TABLE scheduled_task_fires(task_id integer,fire_at timestamptz,lease_owner varchar(128),status varchar(16),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(task_id,fire_at))`)
    const fireAt = Date.parse('2026-11-14T00:00:00Z')
    await pool.query(`INSERT INTO scheduled_tasks VALUES(91,$1,true,'interval','',5,$2,$2,NULL)`, [randomUUID(), new Date(fireAt)])
    const list = createPostgresRepeatingSchedules(pool)
    const recheck = createPostgresRepeatingScheduleRecheck(pool)
    assert.equal((await list()).length, 1)
    const fire = { taskId: '91', fireAt }
    const receipts = createPostgresScheduledFireReceipts(pool)
    let executions = 0
    const dispatch = (owner: string) => dispatchRepeatingFire({ fire, owner, lease, receipts, leaseMs: 5000,
      isCurrent: recheck, async execute() { executions++ } })
    await pool.query('UPDATE scheduled_tasks SET enabled=false WHERE id=91')
    assert.equal(await dispatch('disabled'), 'stale')
    await pool.query('UPDATE scheduled_tasks SET enabled=true WHERE id=91')
    const outcomes = await Promise.all([dispatch('one'), dispatch('two')])
    assert.equal(outcomes.filter(value => value === 'completed').length, 1)
    assert.equal(executions, 1)
    assert.equal(await dispatch('later'), 'duplicate')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
