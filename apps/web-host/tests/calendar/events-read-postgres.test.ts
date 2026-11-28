import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createCalendarEventReader, createKyselyCalendarReadPort } from '@gugu/core/calendar'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002'
const secret = 'synthetic-calendar-read-secret'
const options = { skip: !databaseUrl && '需显式提供隔离的 GUGU_WEBUI_TEST_DATABASE_URL', timeout: 15_000 }
type CoreRuntime = Awaited<ReturnType<typeof createPostgresRuntime>>
type Mode = 'core'

const early = { id: 2, title: '早期事项', date: '2026-01-02', time: null, type: 'event', client: null, description: null, endTime: null, projectId: null, version: 1 }
const later = { id: 1, title: '项目评审', date: '2026-11-15', time: '09:00', type: 'event', client: '小北', description: '合成评审说明', endTime: '10:00', projectId: 7, version: 4 }
const future = { id: 3, title: '未来事项', date: '2027-01-03', time: '18:00', type: 'deadline', client: null, description: '', endTime: null, projectId: null, version: 1 }

async function withCalendar(mode: Mode, work: (context: {
  app: ReturnType<typeof createApp>
  pool: Pool
  core?: CoreRuntime
  reader: ReturnType<typeof createCalendarEventReader>
}) => Promise<void>) {
  const schema = `gugu_calendar_read_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  let core: CoreRuntime | undefined, app: ReturnType<typeof createApp> | undefined
  try {
    await pool.query(`CREATE TABLE calendar_events (
      id integer PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL,
      date text NOT NULL, time text, end_time text, type text NOT NULL,
      contact_name text, project_id integer, description text, version integer, deleted_at timestamptz
    )`)
    await pool.query(`INSERT INTO calendar_events
      (id,user_id,title,date,time,end_time,type,contact_name,project_id,description,version,deleted_at)
      VALUES (1,$1,'项目评审','2026-11-15','09:00','10:00','event','小北',7,'合成评审说明',4,NULL),
             (2,$1,'早期事项','2026-01-02',NULL,NULL,'event',NULL,NULL,NULL,0,NULL),
             (3,$1,'未来事项','2027-01-03','18:00',NULL,'deadline',NULL,NULL,'',NULL,NULL),
             (4,$2,'他人事项','2025-01-01',NULL,NULL,'event',NULL,NULL,NULL,2,NULL),
             (5,$1,'已删除事项','2026-01-01',NULL,NULL,'event',NULL,NULL,NULL,1,'2026-11-01T00:00:00Z')`, [owner, other])
    let reader: ReturnType<typeof createCalendarEventReader>
    if (mode === 'core') {
      core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 1 })
      reader = createCalendarEventReader(createKyselyCalendarReadPort(core.db, 'postgres'))
    } else throw new Error('日历读取测试模式无效')
    app = createApp({ appName: 'Gugu', isReady: async () => true, events: reader,
      userAuth: { secret, lookupUser: async id => [owner, other].includes(id) ? {
        id, username: 'synthetic-user', displayName: null, email: 'synthetic@example.test',
        isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null,
        createdAt: null, timezone: null, emailSubscribed: false, imChannels: [],
      } : null },
    })
    await work({ app, pool, core, reader })
  } finally {
    try { await app?.close() } finally {
      try { await core?.close() } finally {
        try { await pool.end() } finally {
          try {
            if (!/^gugu_calendar_read_[a-f0-9]{32}$/.test(schema)) throw new Error('测试schema范围无效')
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
          } finally { await admin.end() }
        }
      }
    }
  }
}

for (const mode of ['core'] as const) {
  test(`日历读取经真实Fastify和PostgreSQL保持认证、DTO及year/month兼容（${mode}）`, options, async () => {
    await withCalendar(mode, async ({ app, pool }) => {
      const get = (url: string, user = owner) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${signedUserToken(secret, user)}` } })
      for (const query of ['', '?year=2026', '?month=11', '?year=0&month=11', '?year=2026&month=0']) {
        const response = await get(`/api/v1/events${query}`)
        assert.equal(response.statusCode, 200)
        assert.deepEqual(response.json(), [early, later, future])
      }
      const november = await get('/api/v1/events?year=2026&month=11')
      assert.equal(november.statusCode, 200)
      assert.deepEqual(november.json(), [later])
      for (const query of ['?year=2026&month=13', '?year=-1&month=11', '?year=2026&month=-1']) {
        const response = await get(`/api/v1/events${query}`)
        assert.equal(response.statusCode, 200)
        assert.deepEqual(response.json(), [])
      }
      for (const expected of [early, later, future]) {
        const response = await get(`/api/v1/events/${expected.id}`)
        assert.equal(response.statusCode, 200)
        assert.deepEqual(response.json(), expected)
      }
      const foreignList = await get('/api/v1/events', other)
      assert.equal(foreignList.statusCode, 200)
      assert.deepEqual(foreignList.json(), [{ id: 4, title: '他人事项', date: '2025-01-01', time: null, type: 'event', client: null, description: null, endTime: null, projectId: null, version: 2 }])
      for (const id of [4, 5, 999]) assert.equal((await get(`/api/v1/events/${id}`)).statusCode, 404)
      for (const url of ['/api/v1/events', '/api/v1/events/1']) assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401)
      for (const url of ['/api/v1/events/not-an-id', '/api/v1/events/1.5', '/api/v1/events?year=bad', '/api/v1/events?month=1.5']) assert.equal((await get(url)).statusCode, 422)
      // 真实SQL失败必须返回固定安全错误，不能伪造空列表或不存在。
      await pool.query('ALTER TABLE calendar_events RENAME TO unavailable_calendar_events')
      for (const url of ['/api/v1/events', '/api/v1/events/1']) {
        const response = await get(url)
        assert.equal(response.statusCode, 500)
        assert.deepEqual(response.json(), { detail: '服务器内部错误，请稍后重试' })
        assert.doesNotMatch(response.body, /calendar_events|SELECT|user_id|synthetic-calendar-read-secret/)
      }
    })
  })
}

test('Core日历读取真实表锁等待中取消不提前settle，释放后连接可继续使用', options, async () => {
  await withCalendar('core', async ({ pool, core, reader }) => {
    assert.ok(core)
    // 在加锁前按本隔离schema的search_path取OID，观察时不再解析被锁关系。
    const relation = await pool.query<{ oid: number }>("SELECT 'calendar_events'::regclass::oid AS oid")
    const blocker = await pool.connect()
    let locked = false
    try {
      await blocker.query('BEGIN'); locked = true
      await blocker.query('LOCK TABLE calendar_events IN ACCESS EXCLUSIVE MODE')
      const controller = new AbortController(), reason = new Error('合成日历读取取消')
      let settled = false
      const pending = reader.get(owner, 1, { signal: controller.signal }).finally(() => { settled = true })
      const rejected = assert.rejects(pending, error => error === reason)
      try {
        let observedWait = false
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const locks = await pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks
             WHERE relation = $1::oid
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND mode = 'AccessShareLock' AND granted = false) AS waiting`,
            [relation.rows[0]!.oid],
          )
          if (locks.rows[0]!.waiting) { observedWait = true; break }
          await new Promise<void>(resolve => setTimeout(resolve, 10))
        }
        assert.equal(observedWait, true, '必须观察到本隔离日历表的真实服务端锁等待')
        controller.abort(reason)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(settled, false)
      } finally {
        // 观察失败时也终止挂起请求，再释放锁并等待查询清理，避免泄漏连接。
        controller.abort(reason)
        await blocker.query('ROLLBACK'); locked = false
        await rejected
      }
      assert.equal(settled, true)
      // 单连接池查询成功，证明取消没有遗留连接占用或事务污染。
      assert.deepEqual(await reader.get(owner, 1), later)
      assert.deepEqual(await reader.list(owner, 2026, 1), [early])
    } finally {
      try { if (locked) await blocker.query('ROLLBACK') } finally { blocker.release() }
    }
  })
})
