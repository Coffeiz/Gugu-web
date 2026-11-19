import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer as reservePort } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { planAccountMemoryCleanup } from '@gugu/core/memory/account-cleanup-preview'
import { createAccountMemoryCleanupStorage } from '../../src/modules/admin/memory-store.js'
import { startServer } from '../../src/main.js'
import { applyRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'
import { createConfiguredByokEnvelope } from '../../src/modules/byok/crypto.js'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('维护写入中断后从真实 Local 文件恢复，RAG 和回执只提交一次', {
  skip: !(pgUrl && process.platform === 'linux') && '需要隔离 PostgreSQL 和 Linux 文件适配器',
}, async () => {
  const owner = randomUUID(), other = randomUUID(), operationId = randomUUID()
  const root = await mkdtemp(join(tmpdir(), 'gugu-account-cleanup-'))
  const schema = `memory_cleanup_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  let core: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)')
    await pool.query('INSERT INTO users VALUES ($1),($2)', [owner, other])
    const sql = tablesSql('postgres')
    for (const ddl of [sql.receipts, sql.ragJobs, sql.ragIndexEntries]) await pool.query(ddl)
    await pool.query("ALTER TABLE rag_index_jobs ADD CONSTRAINT synthetic_enqueue_failure CHECK (status<>'queued')")
    core = await createPostgresRuntime({ url: pgUrl!, schema })
    const base = join(root, owner, '.agent')
    const untouched = join(root, other, '.agent')
    for (const folder of [base, untouched]) await mkdir(folder, { recursive: true })
    await writeFile(join(base, 'pattern.json'), '[{"id":"move","text":"已确认的稳定喜好"}]')
    await writeFile(join(base, 'profile.json'), '[]')
    await writeFile(join(untouched, 'profile.json'), '[{"text":"其他用户"}]')
    const storage = createAccountMemoryCleanupStorage({ core, root, now: () => 123 })
    const source = await storage.read(owner)
    const { plan } = await planAccountMemoryCleanup({
      ...source, modelBudget: { context_tokens: 4096, max_tokens: 512 },
      async complete({ system }) { return system.includes('"move"') ? { move: [0] } : { remove: [] } },
    })
    assert.ok(plan)
    await assert.rejects(storage.apply(owner, operationId, plan), /synthetic_enqueue_failure/u)
    assert.equal(await readFile(join(base, 'pattern.json'), 'utf8'), '[]')
    assert.match(await readFile(join(base, 'profile.json'), 'utf8'), /已确认的稳定喜好/u)
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM core_operation_receipts WHERE owner_id=$1', [owner])).rows[0]?.total, 1)

    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT synthetic_enqueue_failure')
    // 重建 adapter，避免新进程依赖已丢失的内存状态。
    const reopened = createAccountMemoryCleanupStorage({ core, root, now: () => 456 })
    const result = await reopened.apply(owner, operationId, plan)
    assert.deepEqual(result, { touched: true, removed: 0, moved: 1, profileEvents: 0, daily: 0 })
    assert.deepEqual(await reopened.apply(owner, operationId, plan), result)
    assert.equal(JSON.parse(await readFile(join(base, 'profile.json'), 'utf8'))[0].ts, 123)
    assert.deepEqual((await pool.query('SELECT user_id,status,generation FROM rag_index_jobs')).rows,
      [{ user_id: owner, status: 'queued', generation: 2 }])
    assert.equal(await readFile(join(untouched, 'profile.json'), 'utf8'), '[{"text":"其他用户"}]')
    assert.deepEqual(await readdir(join(root, '.account-memory-cleanup', owner)), [])
  } finally {
    await core?.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await admin.end() }
    await rm(root, { recursive: true, force: true })
  }
})

test('管理端生产入口只读预览，确认后发布并消费计划', {
  skip: !(pgUrl && redisUrl && process.platform === 'linux') && '需要隔离 PostgreSQL、Redis 和 Linux 文件适配器',
}, async () => {
  const owner = randomUUID()
  const root = await mkdtemp(join(tmpdir(), 'gugu-account-cleanup-main-'))
  const schema = `memory_cleanup_main_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const scoped = new URL(pgUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString() })
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  let requests = 0
  let failEmbedding = false
  const embeddingRequests: Array<{ input: string; model: string; authorization?: string }> = []
  const existingMemory = '长期保留的原始条目'
  const memoryKey = createHash('md5').update(existingMemory).digest('hex').slice(0, 12)
  const modelTag = 'local:synthetic-embedding:2'
  const master = 'synthetic-account-maintenance-embedding-master'
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    if (request.url === '/v1/embeddings') {
      const { input, model } = JSON.parse(raw)
      embeddingRequests.push({ input, model, authorization: request.headers.authorization })
      response.writeHead(failEmbedding ? 503 : 200, { 'content-type': 'application/json' }).end(
        JSON.stringify(failEmbedding ? { error: '合成向量服务故障' } : { data: [{ embedding: [0.5, 0.25] }] }),
      )
      return
    }
    requests++
    const output = raw.includes('放入用户画像') || raw.includes('属于「用户画像」') ? { move: [0] } : { remove: [], merge: [] }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: requests === 1 ? '无效模型输出' : JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }))
  })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)')
    await pool.query('INSERT INTO users VALUES ($1)', [owner])
    const sql = tablesSql('postgres')
    for (const ddl of [sql.receipts, sql.ragJobs, sql.ragIndexEntries]) await pool.query(ddl)
    const base = join(root, owner, '.agent')
    await mkdir(base, { recursive: true })
    const original = JSON.stringify([
      { id: 'move', text: '已确认的稳定喜好' }, { id: 'cached', text: '已缓存的模式' }, { id: 'missing', text: '需要补算的模式' },
    ])
    await writeFile(join(base, 'pattern.json'), original)
    await writeFile(join(base, 'profile.json'), '[{"text":"最近完成了合成项目"}]')
    await writeFile(join(base, 'memory.md'), existingMemory)
    await writeFile(join(base, 'memory_vec.json'), JSON.stringify({ [memoryKey]: { v: [1, 2], t: modelTag } }))
    await writeFile(join(base, 'pattern_vec.json'), JSON.stringify({
      cached: { v: [3, 4], t: modelTag }, move: { v: [7, 8], t: modelTag },
    }))
    const configPath = join(root, 'override.json')
    await writeFile(configPath, '{}')
    const reservation = reservePort()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const http = reservation.address()
    assert.ok(http && typeof http !== 'string')
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const endpoint = provider.address()
    assert.ok(endpoint && typeof endpoint !== 'string')
    await pool.query(`CREATE TABLE user_provider_credentials(
      id serial PRIMARY KEY,user_id uuid,capability text,enabled boolean,provider text,base_url text,
      model text,dimensions int,encrypted_value text,nonce text,encrypted_data_key text,key_version int
    )`)
    const envelope = await createConfiguredByokEnvelope({ CREDENTIALS_MASTER_KEY: master }).encrypt('synthetic-embedding-key')
    await pool.query(`INSERT INTO user_provider_credentials
      (user_id,capability,enabled,provider,base_url,model,dimensions,encrypted_value,nonce,encrypted_data_key,key_version)
      VALUES ($1,'embedding',TRUE,'local',$2,'synthetic-embedding',2,$3,$4,$5,$6)`,
    [owner, `http://127.0.0.1:${endpoint.port}/v1`, envelope.ciphertext, envelope.nonce, envelope.encryptedDataKey, envelope.keyVersion])
    await applyRagIndexMigration(pool)
    await pool.query(`CREATE TABLE memory_reflection_cursors (
      id bigserial PRIMARY KEY, owner_user_id uuid NOT NULL, platform text NOT NULL, bot_id text NOT NULL,
      scope_type text NOT NULL, scope_id text NOT NULL, scope_version integer NOT NULL, updated_at timestamptz NOT NULL
    ); CREATE TABLE memory_scope_tombstones (
      owner_user_id uuid NOT NULL, platform text NOT NULL, bot_id text NOT NULL, scope_type text NOT NULL, scope_id text NOT NULL
    )`)
    await pool.query(`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,created_at,updated_at)
      SELECT $1,source.name,'','','refresh','ready',1,1,0,NOW(),NOW()
      FROM unnest(ARRAY['project','calendar','note','scheduled_task','conversation','canvas','knowledge','memory']) source(name)`, [owner])
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_REDIS_URL: redisUrl,
      GUGU_WEBUI_SECRET_KEY: 'synthetic-account-maintenance-auth', GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(http.port),
      GUGU_CONFIG_OVERRIDE_FILE: configPath, STORAGE__LOCAL_PATH: root,
      ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password',
      AI__PROVIDER: 'local', AI__API_FORMAT: 'openai', AI__BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`,
      AI__MODEL: 'synthetic-model', AI__MAX_TOKENS: '512', AI__CONTEXT_TOKENS: '4096',
      BYOK__ENABLED: 'true', CREDENTIALS_MASTER_KEY: master,
    })
    const path = '/api/v1/admin/config/memory-cleanup'
    assert.equal((await host.app.inject({ method: 'POST', url: `${path}/preview` })).statusCode, 401)
    const login = await host.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'synthetic-admin', password: 'synthetic-password' } })
    assert.equal(login.statusCode, 200, login.body)
    const headers = { authorization: `Bearer ${login.json().access_token}` }
    const pollReady = async () => {
      const deadline = Date.now() + 10_000
      let state
      while (Date.now() < deadline) {
        state = (await host!.app.inject({ url: `${path}/status`, headers })).json()
        if (state.status === 'done') break
        await delay(40)
      }
      assert.equal(state?.plan_ready, true, `计划状态=${JSON.stringify(state)} 模型请求数=${requests}`)
      return state
    }
    const preview = await host.app.inject({ method: 'POST', url: `${path}/preview`, headers })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.equal(preview.json().total, 1)
    const state = await pollReady()
    assert.equal(await readFile(join(base, 'pattern.json'), 'utf8'), original)
    assert.deepEqual(state.plan[owner].moved_ids, ['move'])
    assert.equal(requests, 6)
    assert.equal(embeddingRequests.length, 0)
    const apply = await host.app.inject({ method: 'POST', url: `${path}/apply`, headers })
    assert.equal(apply.statusCode, 200, apply.body)
    assert.deepEqual(apply.json(), { ok: true, users_applied: 1, total_removed: 0, total_moved: 1,
      total_profile_events_migrated: 1, total_daily_migrated: 0 })
    assert.deepEqual(JSON.parse(await readFile(join(base, 'pattern.json'), 'utf8')).map((row: { id: string }) => row.id), ['cached', 'missing'])
    assert.match(await readFile(join(base, 'profile.json'), 'utf8'), /已确认的稳定喜好/u)
    assert.equal(requests, 6)
    assert.deepEqual(embeddingRequests.map(request => request.input).sort(), ['## 画像迁移补记\n- 最近完成了合成项目', '需要补算的模式'].sort())
    assert.ok(embeddingRequests.every(request => request.model === 'synthetic-embedding' && request.authorization === 'Bearer synthetic-embedding-key'))
    assert.deepEqual(JSON.parse(await readFile(join(base, 'pattern_vec.json'), 'utf8')), {
      cached: { v: [3, 4], t: modelTag }, missing: { v: [0.5, 0.25], t: modelTag },
    })
    const vectors = JSON.parse(await readFile(join(base, 'memory_vec.json'), 'utf8'))
    assert.deepEqual(vectors[memoryKey], { v: [1, 2], t: modelTag })
    assert.equal(Object.keys(vectors).length, 2)
    assert.equal((await host.app.inject({ method: 'POST', url: `${path}/apply`, headers })).statusCode, 400)
    const indexDeadline = Date.now() + 8_000
    let status
    while (Date.now() < indexDeadline) {
      status = (await pool.query("SELECT status FROM rag_index_jobs WHERE user_id=$1 AND source_type='memory'", [owner])).rows[0]?.status
      if (status === 'ready') break
      await delay(50)
    }
    assert.equal(status, 'ready')
    const indexed = await pool.query("SELECT content FROM knowledge_index_entries WHERE owner_user_id=$1 AND source_type='memory' AND deleted_at IS NULL", [owner])
    assert.ok(indexed.rows.some(row => String(row.content).includes('已确认的稳定喜好')), '后台 Worker 应重新索引已搬迁的画像')

    await writeFile(join(base, 'pattern.json'), original)
    assert.equal((await host.app.inject({ method: 'POST', url: `${path}/preview`, headers })).statusCode, 200)
    await pollReady()
    const concurrent = '[{"id":"new","text":"预览后并行编辑"}]'
    await writeFile(join(base, 'pattern.json'), concurrent)
    const stale = await host.app.inject({ method: 'POST', url: `${path}/apply`, headers })
    assert.equal(stale.statusCode, 409, stale.body)
    assert.match(stale.json().detail, /源数据发生变化/u)
    assert.equal(await readFile(join(base, 'pattern.json'), 'utf8'), concurrent)
    assert.equal(requests, 12)

    await writeFile(join(base, 'pattern.json'), original)
    await writeFile(join(base, 'profile.json'), '[{"text":"本周完成了第二个合成项目"}]')
    const embeddingCallsBeforeFailure = embeddingRequests.length
    failEmbedding = true
    assert.equal((await host.app.inject({ method: 'POST', url: `${path}/preview`, headers })).statusCode, 200)
    await pollReady()
    const acceptedDespiteEmbeddingFailure = await host.app.inject({ method: 'POST', url: `${path}/apply`, headers })
    assert.equal(acceptedDespiteEmbeddingFailure.statusCode, 200, acceptedDespiteEmbeddingFailure.body)
    assert.equal(acceptedDespiteEmbeddingFailure.json().total_profile_events_migrated, 1)
    assert.match(await readFile(join(base, 'memory.md'), 'utf8'), /本周完成了第二个合成项目/u)
    assert.deepEqual(embeddingRequests.slice(embeddingCallsBeforeFailure).map(request => request.input),
      ['## 画像迁移补记\n- 本周完成了第二个合成项目'])
    assert.deepEqual(JSON.parse(await readFile(join(base, 'memory_vec.json'), 'utf8')), vectors)
  } finally {
    await host?.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await admin.end() }
    await rm(root, { recursive: true, force: true })
  }
})
