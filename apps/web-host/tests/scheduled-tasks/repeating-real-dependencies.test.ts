import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createScheduledTaskRedisLease } from '../../src/modules/scheduled-tasks/persistence/redis-lease.js'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createKyselyRepeatingTaskRepository, createKyselyScheduledFireReceipts, dispatchRepeatingFire } from '@gugu/core/scheduled-task-run-now'
import { createRedisScheduledTaskCommands } from '../../src/adapters/cache/redis-events.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
test('真实 PG 和 Redis 下停用后的任务不执行、同一触发只领取一次', { skip: !url || !redisUrl }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_repeat_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  const lease = createScheduledTaskRedisLease(createRedisScheduledTaskCommands(redisUrl!))
  try {
    await pool.query(tablesSql('postgres').scheduledTasks)
    await pool.query(tablesSql('postgres').scheduledFires)
    const fireAt = Date.now()
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,name,payload,enabled,schedule_kind,cron,interval_minutes,start_at,created_at,updated_at,channels)
      VALUES(91,$1,'周期任务','合成指令',true,'interval','',5,$2,$2,CURRENT_TIMESTAMP,'web')`, [randomUUID(), new Date(fireAt)])
    const tasks = createKyselyRepeatingTaskRepository(runtime.db, 'postgres')
    const [initial] = await tasks.list(fireAt)
    assert.ok(initial)
    const fire = { taskId: '91', fireAt }
    const receipts = createKyselyScheduledFireReceipts(runtime.db, 'postgres')
    let executions = 0
    const dispatch = (owner: string, task = initial) => dispatchRepeatingFire({ fire, owner, lease, receipts, leaseMs: 5000,
      isCurrent: () => tasks.isCurrent(task, Date.now()), async execute() { executions++ } })
    await pool.query('UPDATE scheduled_tasks SET enabled=false WHERE id=91')
    assert.equal(await dispatch('disabled'), 'stale')
    await pool.query("UPDATE scheduled_tasks SET enabled=true, updated_at=updated_at+interval '1 second' WHERE id=91")
    assert.equal(await dispatch('old-version'), 'stale')
    const [current] = await tasks.list(fireAt)
    assert.ok(current)
    const outcomes = await Promise.all([dispatch('one', current), dispatch('two', current)])
    assert.equal(outcomes.filter(value => value === 'completed').length, 1)
    assert.equal(executions, 1)
    assert.equal(await dispatch('later', current), 'duplicate')
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
