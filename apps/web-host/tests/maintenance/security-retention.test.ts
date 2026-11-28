import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { cleanupExpiredSecurityEvents, startSecurityRetentionWorker } from '../../src/modules/security-events/cleanup.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('安全事件清理只删除到期记录并可幂等重试', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `security_retention_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE security_events(id serial PRIMARY KEY,user_id uuid NOT NULL,expires_at timestamptz NOT NULL); CREATE INDEX ix_security_events_expires_at ON security_events(expires_at)')
    await pool.query('CREATE TABLE user_data(id integer PRIMARY KEY)')
    await pool.query('INSERT INTO user_data VALUES (1)')
    await pool.query("INSERT INTO security_events(user_id,expires_at) VALUES($1,'2026-01-01 00:00:00Z'),($2,'2026-01-02 00:00:00Z'),($1,'2026-01-02 00:00:00.000001Z')", [randomUUID(), randomUUID()])
    const cutoff = new Date('2026-01-02T00:00:00Z')
    assert.equal(await cleanupExpiredSecurityEvents(pool, cutoff), 2)
    assert.equal(await cleanupExpiredSecurityEvents(pool, cutoff), 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM security_events')).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_data')).rows[0].n, 1)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('清理循环首轮等待，SQL 出错后继续并在关闭时排空', async () => {
  let calls = 0, errors = 0
  let entered!: () => void, release!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const pool = { query: async () => {
    calls++
    if (calls === 1) throw new Error('合成故障')
    entered()
    await pending
    return { rowCount: 0 }
  } } as unknown as Pick<Pool, 'query'>
  const worker = startSecurityRetentionWorker({ pool, intervalMs: 10, now: () => new Date(0), onError() { errors++ } })
  assert.equal(calls, 0)
  await enteredPromise
  assert.equal(errors, 1)
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)
  release()
  await stop
  assert.equal(stopped, true)
  assert.equal(calls, 2)
})
