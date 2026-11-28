import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createSocket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { createApp } from '../../../../src/app.js'

test('createApp mounts the IM model preview POST behind the shared Admin guard', async () => {
  let starts = 0
  const app = createApp({
    appName: '合成应用', isReady: async () => true,
    adminAuth: {
      registerRoutes() {}, async verifyAdmin() { return true },
      async requireAdmin(request, reply) { if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '管理员认证失败' }) },
    },
    imMemoryMaintenancePreview: { async start() { starts++; return { ok: true as const, total: 3 } } },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview' })).statusCode, 401)
    assert.equal(starts, 0)
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview', headers: { authorization: 'synthetic-admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, total: 3 })
    assert.equal(starts, 1)
  } finally { await app.close() }
})

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
const python = process.env.GUGU_CORE_GOLDEN_PYTHON

test('生产 Host 对没有新增消息的 IM scope 仍调用模型并生成计划', {
  skip: !pgUrl || !redisUrl || !python, timeout: 30_000,
}, async () => {
  const { startServer } = await import('../../../../src/main.js')
  const schema = `im_preview_${randomUUID().replaceAll('-', '')}`
  const scopedPg = new URL(pgUrl!)
  scopedPg.searchParams.set('options', `-c search_path=${schema}`)
  const scopedRedis = new URL(redisUrl!)
  scopedRedis.pathname = '/13'
  const admin = new Pool({ connectionString: pgUrl, max: 1 })
  const db = new Pool({ connectionString: scopedPg.toString(), max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-im-preview-'))
  const config = join(root, 'config.json')
  const owner = randomUUID()
  const requests: string[] = []
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(Buffer.concat(chunks).toString())
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: '{"daily":["合成记忆"]}' }, finish_reason: 'stop' }],
    }))
  })
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await writeFile(config, '{}')
    const ddl = execFileSync(python!, ['-c', [
      'from app.models import User, AuditLog, MemoryReflectionCursor',
      'from sqlalchemy.schema import CreateTable',
      'from sqlalchemy.dialects import postgresql',
      'print(";".join(str(CreateTable(m.__table__).compile(dialect=postgresql.dialect())) for m in [User, AuditLog, MemoryReflectionCursor]))',
    ].join('; ')], {
      cwd: '../../backend', encoding: 'utf8',
      env: { ...process.env, GUGU_ENV_FILE: '/dev/null', GUGU_CONFIG_OVERRIDE_FILE: config, PYTHONPATH: '.:../compat/core-python/src' },
    })
    await db.query(ddl)
    await db.query(`INSERT INTO users(id,username,email,hashed_password,is_active,account_status,security_version,is_developer,created_at)
      VALUES($1,'小北','synthetic-preview@example.invalid','synthetic-no-password',true,'active',1,false,now())`, [owner])
    await db.query(`INSERT INTO memory_reflection_cursors(owner_user_id,platform,bot_id,scope_type,scope_id,last_message_id,
      last_reflected_message_id,scope_version,pending_passive_count,pending_agent_count,created_at,updated_at)
      VALUES($1,'qq','synthetic-bot','group','synthetic-group',12,12,0,0,0,now(),now())`, [owner])
    const memory = join(root, 'storage', owner, '.agent', 'memories', 'im', 'qq', 'synthetic-bot', 'groups', 'synthetic-group', 'memory.md')
    await mkdir(dirname(memory), { recursive: true })
    await writeFile(memory, '现有合成记忆')
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    assert.ok(address && typeof address !== 'string')
    const socket = createSocket()
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
    const hostAddress = socket.address()
    assert.ok(hostAddress && typeof hostAddress !== 'string')
    await new Promise<void>(resolve => socket.close(() => resolve()))
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scopedPg.toString(), GUGU_WEBUI_REDIS_URL: scopedRedis.toString(),
      GUGU_WEBUI_SECRET_KEY: 'synthetic-im-preview-secret', GUGU_CONFIG_OVERRIDE_FILE: config,
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(hostAddress.port), STORAGE__LOCAL_PATH: join(root, 'storage'),
      ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-preview-password',
      AI__PROVIDER: 'local', AI__MODEL: 'synthetic-model', AI__API_FORMAT: 'openai',
      AI__BASE_URL: `http://127.0.0.1:${address.port}/v1`, AI__CONTEXT_TOKENS: '8192', AI__MAX_TOKENS: '1024',
    })
    const endpoint = '/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview'
    assert.equal((await host.app.inject({ method: 'POST', url: endpoint })).statusCode, 401)
    const login = await host.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: {
      username: 'synthetic-admin', password: 'synthetic-preview-password',
    } })
    assert.equal(login.statusCode, 200)
    const headers = { authorization: `Bearer ${login.json().access_token}` }
    const start = await host.app.inject({ method: 'POST', url: endpoint, headers })
    assert.equal(start.statusCode, 200)
    assert.deepEqual(start.json(), { ok: true, total: 1 })
    let status: Record<string, unknown> | undefined
    for (let check = 0; check < 100; check++) {
      const result = await host.app.inject({ url: `${endpoint}/status`, headers })
      assert.equal(result.statusCode, 200)
      status = result.json()
      if (status?.status === 'done') break
      await delay(25)
    }
    assert.equal(status?.status, 'done')
    assert.equal(status.failed, 0)
    assert.equal(status.plan_ready, true)
    assert.doesNotMatch(JSON.stringify(status), /synthetic-group|现有合成记忆/u)
    assert.equal(requests.length, 1)
    assert.match(requests[0]!, /现有合成记忆/u)
  } finally {
    await host?.close()
    provider.close()
    await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
