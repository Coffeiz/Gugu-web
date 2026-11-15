import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createProjectListing, createProjectGetter, createProjectFileCountListing } from '@gugu/core'
import { createPostgresRuntime } from '@gugu/core/data'
import { createKyselyProjectFileCountReader } from '@gugu/core/project-read-data'
import { createApp } from '../../src/app.js'
import { createProjectListing as hostListing, createProjectGetter as hostGetter, createProjectFileCountListing as hostCounts } from '../../src/domains/projects/persistence/projects.js'
import { signedUserToken } from '../helpers/auth.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002'
const secret = 'synthetic-project-read-secret'
const options = { skip: !databaseUrl && '需显式提供隔离的 GUGU_WEBUI_TEST_DATABASE_URL', timeout: 15_000 }
type CoreRuntime = Awaited<ReturnType<typeof createPostgresRuntime>>
const validStage = { key: 's0', label: '阶段', todos: [], legacyFlag: { retained: true } }
const base = { client: null, status: 'active', startDate: null, deadline: null, color: 'synthetic-color', progress: 0,
  stages: [], currentStage: null, archived: false, priority: null, version: 1, doneAt: null,
  updatedAt: '2026-02-01T00:00:00+00:00', deletedAt: null, fileCount: 0 }
const first = { ...base, id: 1, name: '活跃项目', client: '小北', startDate: '2026-01-01', deadline: '2026-11-30',
  progress: 42, stages: [validStage], currentStage: 's0', priority: 'high', version: 5, createdAt: '2025-12-31', updatedAt: '2026-01-31T16:30:00.123000+00:00', fileCount: 9 }
const broken = { ...base, id: 2, name: '旧损坏阶段项目', createdAt: '2026-01-02' }
const archived = { ...base, id: 3, name: '归档项目', status: 'done', archived: true, progress: 100,
  doneAt: '2026-05-31T16:30:00.123456+00:00', createdAt: '2026-01-03', fileCount: 7 }
const foreign = { ...base, id: 6, name: '他人项目', createdAt: '2026-01-06', fileCount: 100 }

async function withProjects(mode: 'host' | 'core', work: (context: {
  app: ReturnType<typeof createApp>; pool: Pool; core: CoreRuntime
  getter: ReturnType<typeof createProjectGetter>
  recent: ReturnType<typeof recentProject>
}) => Promise<void>) {
  const schema = `gugu_project_read_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c timezone=Asia/Shanghai`, max: 3 })
  let core: CoreRuntime | undefined, app: ReturnType<typeof createApp> | undefined
  try {
    await pool.query(`CREATE TABLE projects (
      id integer PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL, summary varchar(200),
      contact_name varchar(200), status varchar(20) NOT NULL, start_date varchar(10), deadline varchar(10),
      color varchar(300) NOT NULL, progress integer NOT NULL, stages_json text NOT NULL, current_stage varchar(100),
      priority varchar(20), version integer NOT NULL, archived boolean NOT NULL, done_at timestamptz,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
      idempotency_key varchar(64), idempotency_fingerprint varchar(64),
      CONSTRAINT uq_projects_user_idempotency_key UNIQUE(user_id,idempotency_key)
    )`)
    await pool.query('CREATE TABLE project_file_counts (project_id integer PRIMARY KEY, file_count bigint NOT NULL)')
    const now = Math.floor(Date.now() / 1000) * 1000
    const recentDate = new Date(now - 29 * 86_400_000).toISOString(), oldDate = new Date(now - 31 * 86_400_000).toISOString()
    const recent = recentProject(recentDate)
    await pool.query(`INSERT INTO projects
      (id,user_id,name,summary,contact_name,status,start_date,deadline,color,progress,stages_json,current_stage,priority,version,archived,done_at,created_at,updated_at,deleted_at)
      VALUES (1,$1,'活跃项目','合成摘要','小北','active','2026-01-01','2026-11-30','synthetic-color',42,$3,'s0','high',5,false,NULL,'2026-01-01T00:30:00+08:00','2026-02-01T00:30:00.123000+08:00',NULL),
             (2,$1,'旧损坏阶段项目',NULL,NULL,'active',NULL,NULL,'synthetic-color',0,'{broken',NULL,NULL,0,false,NULL,'2026-01-02T00:00:00Z','2026-02-01T00:00:00Z',NULL),
             (3,$1,'归档项目',NULL,NULL,'done',NULL,NULL,'synthetic-color',100,'[]',NULL,NULL,1,true,'2026-06-01T00:30:00.123456+08:00','2026-01-03T00:00:00Z','2026-02-01T00:00:00Z',NULL),
             (4,$1,'29天回收项目',NULL,NULL,'active',NULL,NULL,'synthetic-color',0,'[]',NULL,NULL,1,false,NULL,'2026-01-04T00:00:00Z','2026-02-01T00:00:00Z',$4),
             (5,$1,'31天回收项目',NULL,NULL,'active',NULL,NULL,'synthetic-color',0,'[]',NULL,NULL,1,false,NULL,'2026-01-05T00:00:00Z','2026-02-01T00:00:00Z',$5),
             (6,$2,'他人项目',NULL,NULL,'active',NULL,NULL,'synthetic-color',0,'[]',NULL,NULL,1,false,NULL,'2026-01-06T00:00:00Z','2026-02-01T00:00:00Z',NULL)`,
      [owner, other, JSON.stringify([validStage]), recentDate, oldDate])
    await pool.query('INSERT INTO project_file_counts VALUES (1,9),(3,7),(4,2),(5,4),(6,100),(999,999)')
    assert.equal((await pool.query("SELECT to_regclass('files') AS table_name")).rows[0].table_name, null)
    core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 1 })
    const countPort = createKyselyProjectFileCountReader(core.db as unknown as Parameters<typeof createKyselyProjectFileCountReader>[0], 'postgres')
    const getter = mode === 'core' ? createProjectGetter(core, countPort) : hostGetter(core, pool)
    app = createApp({ appName: 'Gugu', isReady: async () => true,
      listProjects: mode === 'core' ? createProjectListing(core, countPort) : hostListing(core, pool),
      getProject: getter, listProjectFileCounts: mode === 'core' ? createProjectFileCountListing(countPort) : hostCounts(pool),
      userAuth: { secret, lookupUser: async id => [owner, other].includes(id) ? {
        id, username: 'synthetic-user', displayName: null, email: 'synthetic@example.test', isActive: true,
        accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [],
      } : null },
    })
    await work({ app, pool, core, getter, recent })
  } finally {
    try { await app?.close() } finally {
      try { await core?.close() } finally {
        try { await pool.end() } finally {
          try {
            if (!/^gugu_project_read_[a-f0-9]{32}$/.test(schema)) throw new Error('测试schema范围无效')
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
          } finally { await admin.end() }
        }
      }
    }
  }
}
function recentProject(date: string) {
  return { ...base, id: 4, name: '29天回收项目', createdAt: '2026-01-04', fileCount: 2, deletedAt: `${date.slice(0, 19)}+00:00` }
}

for (const mode of ['host', 'core'] as const) {
  test(`项目查询经真实Fastify和PG保留投影计数、回收期限与阶段解析契约（${mode}）`, options, async () => {
    await withProjects(mode, async ({ app, pool, recent }) => {
      const get = (url: string, user = owner) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${signedUserToken(secret, user)}` } })
      for (const [url, expected] of [
        ['/api/v1/projects', [broken, first]], ['/api/v1/projects?archived=true', [archived]],
        ['/api/v1/projects?deleted=true', [recent]], ['/api/v1/projects/1', first],
        ['/api/v1/projects/2', broken], ['/api/v1/projects/3', archived],
        ['/api/v1/projects/file-counts', [1, 2, 3, 4, 5].map((projectId, index) => ({ projectId, fileCount: [9, 0, 7, 2, 4][index] }))],
      ] as const) {
        const response = await get(url)
        assert.equal(response.statusCode, 200)
        assert.deepEqual(response.json(), expected)
      }
      assert.deepEqual((await get('/api/v1/projects', other)).json(), [foreign])
      assert.deepEqual((await get('/api/v1/projects/file-counts', other)).json(), [{ projectId: 6, fileCount: 100 }])
      for (const id of [4, 5, 6, 999]) assert.equal((await get(`/api/v1/projects/${id}`)).statusCode, 404)
      for (const url of ['/api/v1/projects', '/api/v1/projects/1', '/api/v1/projects/file-counts']) assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401)
      for (const url of ['/api/v1/projects/not-id', '/api/v1/projects/1.5', '/api/v1/projects?archived=maybe', '/api/v1/projects?deleted=maybe']) assert.equal((await get(url)).statusCode, 422)
      assert.equal((await get('/api/v1/projects?archived=true&deleted=true')).statusCode, 400)
      // 不可解析JSON兼容为[]，但合法JSON不是list[dict]时必须失败，不静默吞掉存储错误。
      for (const raw of ['{"field":"object"}', '["not-dict"]', '[null]', 'null']) {
        await pool.query('UPDATE projects SET stages_json=$1 WHERE id=2', [raw])
        for (const url of ['/api/v1/projects/2', '/api/v1/projects']) {
          const response = await get(url)
          assert.equal(response.statusCode, 500)
          assert.deepEqual(response.json(), { detail: '服务器内部错误，请稍后重试' })
        }
        assert.equal((await pool.query('SELECT stages_json FROM projects WHERE id=2')).rows[0].stages_json, raw)
      }
      await pool.query("UPDATE projects SET stages_json='{broken' WHERE id=2")
      assert.equal((await pool.query('SELECT stages_json FROM projects WHERE id=1')).rows[0].stages_json, JSON.stringify([validStage]))
      // 故障来自真实投影SQL；不能把缺表当作缺少某个项目的计数并回退为0。
      await pool.query('ALTER TABLE project_file_counts RENAME TO unavailable_project_file_counts')
      for (const url of ['/api/v1/projects', '/api/v1/projects/1', '/api/v1/projects/file-counts']) {
        const response = await get(url)
        assert.equal(response.statusCode, 500)
        assert.deepEqual(response.json(), { detail: '服务器内部错误，请稍后重试' })
        assert.doesNotMatch(response.body, /SELECT|project_file_counts|stages_json|synthetic-project-read-secret/)
      }
    })
  })
}

test('Core项目计数真实PG投影表锁等待中取消，释放锁后原原因拒绝且单连接可复用', options, async () => {
  await withProjects('core', async ({ core, pool, getter }) => {
    const relation = await pool.query<{ oid: number }>("SELECT 'project_file_counts'::regclass::oid AS oid")
    const blocker = await pool.connect()
    let locked = false
    try {
      await blocker.query('BEGIN'); locked = true
      await blocker.query('LOCK TABLE project_file_counts IN ACCESS EXCLUSIVE MODE')
      const controller = new AbortController(), reason = new Error('合成项目计数查询取消')
      let settled = false
      const pending = getter(owner, 1, { signal: controller.signal }).finally(() => { settled = true })
      const rejected = assert.rejects(pending, error => error === reason)
      try {
        let observedWait = false
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const locks = await pool.query<{ waiting: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks
            WHERE relation=$1::oid AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND mode='AccessShareLock' AND granted=false) AS waiting`, [relation.rows[0]!.oid])
          if (locks.rows[0]!.waiting) { observedWait = true; break }
          await new Promise<void>(resolve => setTimeout(resolve, 10))
        }
        assert.equal(observedWait, true, '必须观察到投影计数查询在服务器等待目标表锁')
        controller.abort(reason)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(settled, false)
      } finally {
        controller.abort(reason)
        await blocker.query('ROLLBACK'); locked = false
        await rejected
      }
      assert.equal(settled, true)
      assert.deepEqual(await getter(owner, 1), first)
      // core池maxConnections=1，额外查询验证连接没有被取消路径遗留占用。
      assert.equal((await core.db.selectFrom('projects').select('id').where('id', '=', 1).execute()).length, 1)
    } finally { try { if (locked) await blocker.query('ROLLBACK') } finally { blocker.release() } }
  })
})
