import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { startScheduledTaskWorker, startServer } from '../../../src/startup/server.js'
import { signedUserToken } from '../../helpers/auth.js'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

async function freePort() {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return address.port
}

test('外部调度收到 API 改期通知后，两个由 API 启动的 Worker 只投递一次并且不监听 HTTP', {
  skip: !(pgUrl && redisUrl) && '需要隔离 PostgreSQL 和 Redis',
  timeout: 25_000,
}, async () => {
  const schema = `scheduler_worker_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(join(tmpdir(), 'gugu-scheduler-worker-'))
  const scoped = new URL(pgUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const admin = new Pool({ connectionString: pgUrl })
  const pool = new Pool({ connectionString: scoped.toString() })
  let api: Awaited<ReturnType<typeof startServer>> | undefined
  const workers: Awaited<ReturnType<typeof startScheduledTaskWorker>>[] = []
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await migratePostgres(pool, 'apply')
    const ownerId = randomUUID()
    await pool.query(`INSERT INTO users(id, username, email, hashed_password, timezone)
      VALUES ($1, 'synthetic-owner', 'owner@example.test', 'synthetic-hash', 'Asia/Shanghai')`, [ownerId])
    await pool.query(`INSERT INTO scheduled_tasks(id, user_id, name, payload, cron, schedule_kind, interval_minutes, start_at,
      channels, enabled, execution_mode, created_at, updated_at)
      VALUES (1,$1,'合成一次提醒','一次内容','','once',NULL,now()+interval '1 day','web',TRUE,'reminder',now(),now()),
        (2,$1,'合成周期提醒','周期内容','','interval',1,now()+interval '1 day','web',TRUE,'reminder',now(),now()),
        (3,$1,'合成手动提醒','手动内容','','once',NULL,now()+interval '1 day','web',TRUE,'reminder',now(),now())`, [ownerId])
    const secret = 'synthetic-scheduler-worker-secret'
    const env = {
      GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret, GUGU_WEBUI_REDIS_URL: redisUrl,
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(await freePort()),
      GUGU_CONFIG_OVERRIDE_FILE: join(root, 'override.json'), GUGU_LOG_FILE: join(root, 'runtime.log'),
      STORAGE__LOCAL_PATH: join(root, 'storage'), MCP__ENABLED: 'false', IM__QQ: 'false',
    }
    api = await startServer({ ...env, GUGU_WEBUI_SCHEDULER_MODE: 'external' })
    assert.equal(api.app.server.listening, true)
    // 共用 API 已占用的端口，证明启动 Worker API 不绑定 HTTP。
    workers.push(await startScheduledTaskWorker(env))
    workers.push(await startScheduledTaskWorker(env))

    const headers = { authorization: `Bearer ${signedUserToken(secret, ownerId)}` }
    const startAt = new Date(Date.now() + 3000).toISOString()
    for (const id of [1, 2]) {
      const response = await api.app.inject({ method: 'PATCH', url: `/api/v1/scheduled-tasks/${id}`, headers, payload: { start_at: startAt } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const deadline = Date.now() + 10_000
    let titles: string[] = []
    while (Date.now() < deadline) {
      const result = await pool.query<{ title: string }>(`SELECT title FROM site_notifications WHERE target=$1 ORDER BY title`, [ownerId])
      titles = result.rows.map(row => row.title)
      if (titles.length >= 2) break
      await delay(100)
    }
    await Promise.all(workers.map(worker => worker.close()))
    assert.deepEqual(titles, ['合成一次提醒', '合成周期提醒'])
    const result = await pool.query<{ title: string }>(`SELECT title FROM site_notifications WHERE target=$1 ORDER BY title`, [ownerId])
    assert.deepEqual(result.rows.map(row => row.title), titles)
    assert.equal((await pool.query('SELECT id FROM scheduled_tasks WHERE id=1')).rowCount, 0)
    assert.deepEqual((await pool.query('SELECT task_id,status FROM scheduled_task_fires')).rows, [{ task_id: 2, status: 'completed' }])
    const manual = await api.app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/3/run', headers })
    assert.equal(manual.statusCode, 200, manual.body)
    assert.deepEqual(manual.json().result, { 'web 通知': '已发送' })
    assert.equal((await pool.query('SELECT id FROM scheduled_tasks WHERE id=3')).rowCount, 1)
  } finally {
    try { await Promise.allSettled([...workers.map(worker => worker.close()), api?.close()]) }
    finally {
      await pool.end()
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
      finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
    }
  }
})
