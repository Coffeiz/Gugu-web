import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { createAgentSecretInteractionService, registerAgentSecretInteractionRoutes } from '../../src/modules/agent-sessions/agent-secret-interaction-route.js'
import { createPostgresSecretInteraction, SecretInteractionError } from '../../src/modules/agent-sessions/persistence/agent-secret-interaction-postgres.js'
import { encryptByokEnvelope } from '../../src/modules/agent/model-config/byok.js'

test('凭据路由认证、拒绝泄露与受控状态码', async () => {
  const app = Fastify(); let count = 0
  registerAgentSecretInteractionRoutes(app, { async requireUser(request, reply) { if (!request.headers.authorization) return reply.code(401).send() }, userIdFromRequest: () => 'trusted-owner', service: { async consume(owner, id, values) {
    count++; assert.equal(owner, 'trusted-owner'); assert.equal(id, 2); assert.deepEqual(values, { key: 'synthetic-secret' })
    if (count === 1) throw new SecretInteractionError(404, '敏感信息输入不存在')
    throw new Error('synthetic-secret')
  } } })
  try {
    const request = { method: 'POST' as const, url: '/api/v1/agent/interactions/2/secrets?owner=attacker', payload: { values: { key: 'synthetic-secret' } } }
    assert.equal((await app.inject(request)).statusCode, 401); assert.equal(count, 0)
    const notFound = await app.inject({ ...request, headers: { authorization: 'yes' } })
    assert.equal(notFound.statusCode, 404); assert.deepEqual(notFound.json(), { detail: '敏感信息输入不存在' })
    const failure = await app.inject({ ...request, headers: { authorization: 'yes' } })
    assert.equal(failure.statusCode, 500); assert.doesNotMatch(failure.body, /synthetic-secret/)
  } finally { await app.close() }
})

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('失效记录和密文同事务提交，校验失败及失效失败可重试', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `secret_route_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const owner = randomUUID(), foreignOwner = randomUUID()
  try {
    await pool.query('CREATE TABLE interaction_prompts(id integer PRIMARY KEY,user_id text,session_id integer,kind text,status text,expires_at timestamptz,resolved_at timestamptz,schema_json jsonb); CREATE TABLE user_mcp_servers(id uuid,user_id text,scope text,credential_slots jsonb,encrypted_credentials text,credentials_nonce text,encrypted_credentials_key text,credentials_key_version integer); CREATE TABLE mcp_secret_inputs(prompt_id integer,user_id text,status text,encrypted_payload text,payload_nonce text,encrypted_data_key text); CREATE TABLE invalidations(owner_id text,server_id text)')
    const server = randomUUID(), prompt = { secret_fields: [{ name: 'key' }], context: { secret_target: { kind: 'mcp_credentials', server_id: server } } }
    await pool.query("INSERT INTO interaction_prompts VALUES (1,$1,2,'form','active',now()+interval '1 hour',NULL,$2)", [owner, JSON.stringify(prompt)])
    await pool.query("INSERT INTO user_mcp_servers VALUES ($1,$2,'user',$3,'','','',1)", [server, owner, JSON.stringify([{ id: 'key', target: 'header', prefix: 'Bearer ' }])])
    const base = { encrypt: (value: Record<string, string>) => encryptByokEnvelope(JSON.stringify(value), 'synthetic-master', 1), async enqueue() { throw new Error('无绑定不得入队') } }
    assert.throws(() => createPostgresSecretInteraction(pool, base as never), /未完整配置/)
    const failing = createPostgresSecretInteraction(pool, { ...base, async invalidate(client) { await client.query("INSERT INTO invalidations VALUES ($1,'test')", [owner]); throw new Error('synthetic failure') } })
    await assert.rejects(failing(owner, 1, { key: 'secret' }), /synthetic failure/)
    assert.equal((await pool.query('SELECT status FROM interaction_prompts')).rows[0].status, 'active')
    assert.equal((await pool.query('SELECT encrypted_credentials FROM user_mcp_servers')).rows[0].encrypted_credentials, '')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM invalidations')).rows[0].n), 0)
    const consume = createPostgresSecretInteraction(pool, { ...base, async invalidate(client, owner, id) { await client.query('INSERT INTO invalidations VALUES ($1,$2)', [owner, id]) } })
    await assert.rejects(consume(foreignOwner, 1, { key: 'secret' }), (error: unknown) => error instanceof SecretInteractionError && error.status === 404)
    await assert.rejects(consume(owner, 1, { key: '中文' }), (error: unknown) => error instanceof SecretInteractionError && error.status === 400 && error.message.includes('ASCII'))
    await assert.rejects(consume(owner, 1, { key: 'a\nb' }), (error: unknown) => error instanceof SecretInteractionError && error.status === 400 && error.message.includes('控制字符'))
    let wakes = 0, diagnosed = 0
    const service = createAgentSecretInteractionService({ consume, async wake() { wakes++; throw new Error('notification') }, diagnose() { diagnosed++ } })
    assert.deepEqual(await service.consume(owner, 1, { key: 'synthetic-secret' }), { ok: true, prompt_id: 1 })
    assert.equal(wakes, 1); assert.equal(diagnosed, 1)
    const data = await pool.query('SELECT p.schema_json,s.encrypted_credentials FROM interaction_prompts p CROSS JOIN user_mcp_servers s')
    assert.doesNotMatch(JSON.stringify(data.rows), /synthetic-secret/)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM invalidations')).rows[0].n), 1)
    await assert.rejects(service.consume(owner, 1, { key: 'synthetic-secret' }), (error: unknown) => error instanceof SecretInteractionError && error.status === 409)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
