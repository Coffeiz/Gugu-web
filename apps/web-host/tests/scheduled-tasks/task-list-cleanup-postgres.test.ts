import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { createScheduledTaskRedisLease } from '../../src/modules/scheduled-tasks/run/lease.js'
import { createPostgresRuntime } from '@gugu/core/data'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const socket = process.env.GUGU_TEST_REDIS_SOCKET
test('真实 PG/Redis：失锁仍执行和持锁未提交启动均不触发列表清理', { skip: !url || !socket }, async () => {
  const admin = new Pool({ connectionString: url }), schema = `gugu_cleanup_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  const queries = createScheduledTaskQueries(createKyselyScheduledTaskReader(runtime.db, 'postgres'), () => ({ workspaceSupported: true, filesystemAuthorizationEnabled: false }))
  const owner = '11111111-1111-4111-8111-111111111111'
  const idBase = Math.floor(Math.random() * 1_000_000_000) + 1
  const [lostId, startingId, repeatingId] = [idBase, idBase + 1, idBase + 2]
  const run = promisify(execFile)
  const command = async (...args: string[]) => (await run('redis-cli', ['-s', socket!, '--raw', ...args])).stdout.trim()
  const lease = createScheduledTaskRedisLease({ set: (key, value, ...opts) => command('SET', key, value, ...opts), eval: (script, count, ...args) => command('EVAL', script, String(count), ...args), exists: key => command('EXISTS', key) })
  const old = new Date(Date.now() - 700_000)
  const activeExecutor = await pool.connect()
  const startingExecutor = await pool.connect()
  try {
    await pool.query(`CREATE TABLE scheduled_tasks (
      id int PRIMARY KEY, user_id uuid NOT NULL, event_id int, schedule_kind text NOT NULL,
      start_at timestamptz, end_at timestamptz, last_run_at timestamptz, last_run_failed boolean,
      enabled boolean NOT NULL, cron text NOT NULL, name text NOT NULL, payload text NOT NULL,
      channels text NOT NULL, interval_minutes int, workspace_id int, filesystem_authorization_grant_id int,
      delivery_targets json, authorized_tools json, email_attachment_file_ids json
    )`)
    await pool.query(`INSERT INTO scheduled_tasks VALUES
      ($1,$4,NULL,'once',$5,NULL,$5,FALSE,TRUE,'@once','失锁执行','', 'web',NULL,NULL,NULL,NULL,'[]','[]'),
      ($2,$4,NULL,'once',$5,NULL,NULL,FALSE,TRUE,'@once','准备启动','', 'web',NULL,NULL,NULL,NULL,'[]','[]'),
      ($3,$4,NULL,'interval',NULL,$5,$5,FALSE,TRUE,'* * * * *','失锁重复','', 'web',1,NULL,NULL,NULL,'[]','[]')`, [lostId, startingId, repeatingId, owner, old])
    // 两个执行者仍在运行，但其 Redis 锁已消失；另一执行者已持锁、尚未提交启动态。
    assert.equal(await lease.acquire(String(lostId), 'active-lost', 60_000), true)
    assert.equal(await lease.acquire(String(repeatingId), 'active-repeating', 60_000), true)
    await lease.release(String(lostId), 'active-lost')
    await lease.release(String(repeatingId), 'active-repeating')
    assert.equal(await lease.acquire(String(startingId), 'starting', 60_000), true)
    await activeExecutor.query('BEGIN')
    await activeExecutor.query('SELECT * FROM scheduled_tasks WHERE id=$1', [lostId])
    await startingExecutor.query('BEGIN')
    await startingExecutor.query('UPDATE scheduled_tasks SET last_run_at=CURRENT_TIMESTAMP WHERE id=$1', [startingId])
    assert.equal(await lease.isHeld(String(lostId)), false)
    assert.equal(await lease.isHeld(String(startingId)), true)
    const list = queries.web
    const before = (await pool.query('SELECT * FROM scheduled_tasks ORDER BY id')).rows
    const first = await list(owner, null)
    const second = await list(owner, null)
    assert.deepEqual(first.tasks.map(row => row.id).sort((a, b) => a - b), [lostId, startingId, repeatingId])
    assert.equal(second.tasks.length, 3)
    assert.deepEqual((await pool.query('SELECT * FROM scheduled_tasks ORDER BY id')).rows, before)
    // 查询不持有 Redis 依赖，即便租约服务不可用也不会改变任务。
    assert.equal((await list(owner, null)).tasks.length, 3)
    assert.deepEqual((await pool.query('SELECT * FROM scheduled_tasks ORDER BY id')).rows, before)
  } finally {
    await activeExecutor.query('ROLLBACK').catch(() => undefined)
    await startingExecutor.query('ROLLBACK').catch(() => undefined)
    activeExecutor.release()
    startingExecutor.release()
    await lease.release(String(startingId), 'starting').catch(() => undefined)
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
