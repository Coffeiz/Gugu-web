import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'kysely'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createToolRegistry } from '@gugu/core/tools'
import { createRedisScheduledTaskCommands, createRedisValueReader } from '../../src/adapters/cache/redis-events.js'
import type { ProviderHttpRequest } from '@gugu/core/providers'
import { createWebAgentFeishuReaction, createWebAgentImOwnerSessions } from '../../src/modules/agent-sessions/tools/agent-im.js'
import { createScheduledImPushHistory } from '../../src/modules/scheduled-tasks/im-push-history.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('实时 IM Host 绑定端口只写可信私聊的 Bot 键，路由读取复核 Web 会话归属', {
  skip: !databaseUrl || !redisUrl,
}, async () => {
  const ownerId = randomUUID(), otherOwner = randomUUID()
  const schema = `gugu_im_owner_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const core = await createPostgresRuntime({ url: databaseUrl!, schema })
  const person = { role: 'owner' as const, chatType: 'c2c' as const, platform: 'qq', platformUserId: 'synthetic-owner', botId: '17' }
  const identity = { ownerId, sessionId: '5', runId: 'private-im' }
  const key = `im:owner-session:${ownerId}:qq:synthetic-owner:17`
  const otherBotKey = `im:owner-session:${ownerId}:qq:synthetic-owner:other-bot`
  const genericKey = `im:owner-session:${ownerId}:qq:synthetic-owner`
  const redis = createRedisScheduledTaskCommands(redisUrl!)
  const get = createRedisValueReader(redisUrl!)
  try {
    await sql`CREATE TABLE conversation_sessions(id integer PRIMARY KEY, user_id uuid NOT NULL, source text,
      bot_id text, chat_id text, chat_type text, platform_user_id text, last_message_seq integer DEFAULT 0, updated_at timestamptz)`.execute(core.db)
    await sql`CREATE TABLE conversation_messages(session_id integer, conversation_seq integer, role text, content text,
      created_at timestamptz, sent_at timestamptz)`.execute(core.db)
    await sql`INSERT INTO conversation_sessions(id,user_id,source) VALUES (1,${ownerId},'web'), (2,${otherOwner},'web'),
      (3,${ownerId},'feishu'), (4,${ownerId},NULL), (5,${ownerId},'qq')`.execute(core.db)
    await sql`CREATE TABLE synthetic_private_authority(owner_id uuid, session_id text, run_id text, enabled boolean)`.execute(core.db)
    await sql`INSERT INTO synthetic_private_authority VALUES (${ownerId},'5','private-im',TRUE)`.execute(core.db)
    let revokedAtWrite = false
    const host = createWebAgentImOwnerSessions({ core, redisUrl: redisUrl!, async privateOwner(candidate, signal, db) {
      signal.throwIfAborted()
      const row = await sql`SELECT 1 FROM synthetic_private_authority WHERE owner_id=${candidate.ownerId}
        AND session_id=${candidate.sessionId} AND run_id=${candidate.runId} AND enabled`.execute(db)
      return row.rows.length && !(revokedAtWrite && db.isTransaction) ? person : null
    } })
    const signal = new AbortController().signal
    const ports = await host.forRun(identity, signal)
    assert.ok(ports)
    assert.equal(await host.forRun({ ...identity, runId: 'untrusted-web' }, signal), null)
    const registry = createToolRegistry({ tools: ports.tools, authorize: candidate => ports.authorize(candidate, signal) })
    assert.deepEqual((await registry.capabilities(identity)).map(tool => tool.name), ['bind_web_session'])
    assert.deepEqual(await registry.capabilities({ ...identity, ownerId: otherOwner }), [])
    const scope = { identity, roundId: 'round', resolution: null, signal,
      async execute(): Promise<never> { throw new Error('不执行进程') } }
    const bind = (sessionId: number, extra = {}) => registry.tools.dispatch({
      id: `bind-${sessionId}`, name: 'bind_web_session', input: { session_id: sessionId, ...extra },
    }, scope)
    for (const rejected of [await bind(2), await bind(3), await bind(2_147_483_648), await bind(1, { bot_id: 'forged' })]) {
      assert.ok(rejected.kind === 'completed' && !rejected.successful)
    }
    assert.equal(await get(key), null)
    assert.ok((await bind(1)).kind === 'completed')
    assert.equal(await get(key), '1')
    assert.equal(await get(genericKey), null)
    assert.equal(await get(otherBotKey), null)
    assert.ok(Number(await redis.eval("return redis.call('TTL', KEYS[1])", 1, key)) >= 43_190)
    assert.equal(await host.readWebSession(ownerId, person, signal), 1)
    assert.equal(await host.readWebSession(ownerId, { ...person, botId: 'other-bot' }, signal), null)

    const rebound = await bind(4)
    assert.ok(rebound.kind === 'completed' && rebound.successful)
    assert.equal(await host.readWebSession(ownerId, person, signal), 4)
    const recordPush = createScheduledImPushHistory(core, { get, eval: redis.eval })
    await recordPush({ ownerId, channels: ['qq'], title: '合成任务', text: '合成结果' }, 'qq',
      { channel_id: 17, chat_type: 'c2c', puid: 'synthetic-owner' })
    assert.deepEqual((await sql`SELECT session_id,role,content FROM conversation_messages`.execute(core.db)).rows,
      [{ session_id: 4, role: 'assistant', content: '⏰ 合成任务\n\n合成结果' }])
    const replay = await registry.tools.reconcile({ id: 'bind-1', name: 'bind_web_session', input: { session_id: 1 } }, { ...identity, roundId: 'round' })
    assert.equal(replay.kind, 'unknown')
    assert.equal(await get(key), '4')
    revokedAtWrite = true
    const denied = await bind(1)
    assert.ok(denied.kind === 'completed' && !denied.successful)
    assert.equal(await get(key), '4')
    await sql`UPDATE synthetic_private_authority SET enabled=FALSE`.execute(core.db)
    assert.deepEqual(await registry.capabilities(identity), [])

    await redis.eval("return redis.call('SET', KEYS[1], '2', 'EX', 30)", 1, key)
    assert.equal(await host.readWebSession(ownerId, person, signal), null)
  } finally {
    await redis.eval("return redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])", 3, key, genericKey, otherBotKey)
    await core.close()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})

test('飞书回应绑定可信消息与当前 Bot，取令牌后撤权不发送，断线不重放', {
  skip: !databaseUrl,
}, async () => {
  const ownerId = randomUUID(), foreign = randomUUID()
  const schema = `gugu_im_reaction_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const identity = { ownerId, sessionId: '3', runId: 'feishu-reaction' }
  const message = { platform: 'feishu' as const, channelId: '17', messageId: 'om_synthetic' }
  const requests: ProviderHttpRequest[] = []
  let marker: typeof message[] = []
  let mode: 'normal' | 'revoked' | 'unknown' | 'denied' | 'cancelled' = 'normal'
  let cancellation = new AbortController()
  try {
    await pool.query('CREATE TABLE user_bots(id int PRIMARY KEY,user_id uuid,platform text,enabled boolean,app_id text,app_secret text,owner_platform_user_id text)')
    await pool.query("INSERT INTO user_bots VALUES (17,$1,'feishu',TRUE,'synthetic-app','sealed',NULL),(18,$2,'feishu',TRUE,'other-app','other-sealed',NULL)", [ownerId, foreign])
    const prepare = createWebAgentFeishuReaction({
      pool,
      decrypt(secret) { assert.equal(secret, 'sealed'); return 'synthetic-secret' },
      async currentTarget(candidate) { return candidate.runId === identity.runId && candidate.sessionId === identity.sessionId ? message : null },
      async markReacted(candidate, target) { assert.deepEqual(candidate, identity); marker.push(target) },
      transport: { async request(request) {
        requests.push(request)
        const oauth = request.url.endsWith('/tenant_access_token/internal')
        if (oauth && mode === 'revoked') await pool.query('UPDATE user_bots SET enabled=FALSE WHERE id=17')
        if (oauth && mode === 'cancelled') cancellation.abort()
        if (!oauth && mode === 'unknown') throw new Error('合成出站断线')
        return {
          status: 200, headers: {},
          body: (async function* () {
            yield new TextEncoder().encode(JSON.stringify(oauth
              ? { code: 0, tenant_access_token: 'synthetic-token' }
              : { code: mode === 'denied' ? 999 : 0 }))
          })(),
          cancel() {},
        }
      } },
    })
    assert.equal(await prepare({ ...identity, ownerId: foreign }, cancellation.signal), null)
    assert.equal(await prepare({ ...identity, runId: 'web' }, cancellation.signal), null)
    const ports = await prepare(identity, cancellation.signal)
    assert.ok(ports)
    const registry = createToolRegistry({ tools: ports.tools, authorize: candidate => ports.authorize(candidate, cancellation.signal) })
    const scope = () => ({ identity, roundId: 'r1', resolution: null, signal: cancellation.signal,
      async execute(): Promise<never> { throw new Error('不执行进程') } })
    const call = { id: 'c1', name: 'react', input: { mood: 'love' } }
    assert.deepEqual((await registry.capabilities(identity)).map(tool => tool.name), ['react'])
    const forged = await registry.tools.dispatch({ ...call, input: { ...call.input, messageId: 'om_other' } }, scope())
    assert.ok(forged.kind === 'completed' && !forged.successful)
    assert.equal(requests.length, 0)
    const result = await registry.tools.dispatch(call, scope())
    assert.ok(result.kind === 'completed' && result.successful && result.mutated)
    assert.deepEqual(requests.map(item => item.url), [
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      'https://open.feishu.cn/open-apis/im/v1/messages/om_synthetic/reactions',
    ])
    assert.deepEqual(requests[0]?.body, { app_id: 'synthetic-app', app_secret: 'synthetic-secret' })
    assert.deepEqual(requests[1]?.body, { reaction_type: { emoji_type: 'HEART' } })
    assert.equal(requests[1]?.headers.Authorization, 'Bearer synthetic-token')
    assert.equal(requests[1]?.allowLocal, false)
    assert.deepEqual(marker, [message])

    mode = 'revoked'
    const revoked = await registry.tools.dispatch({ ...call, id: 'revoked' }, scope())
    assert.ok(revoked.kind === 'completed' && !revoked.successful)
    assert.equal(requests.length, 3)
    assert.deepEqual(await registry.capabilities(identity), [])
    await pool.query('UPDATE user_bots SET enabled=TRUE WHERE id=17')
    mode = 'denied'
    const denied = await registry.tools.dispatch({ ...call, id: 'denied' }, scope())
    assert.ok(denied.kind === 'completed' && !denied.successful)
    assert.equal(requests.length, 5)
    mode = 'unknown'
    const lost = { ...call, id: 'lost' }
    assert.equal((await registry.tools.dispatch(lost, scope())).kind, 'unknown')
    assert.equal((await registry.tools.reconcile(lost, { ...identity, roundId: 'r1' })).kind, 'unknown')
    assert.equal(requests.length, 7)
    mode = 'cancelled'
    await registry.tools.dispatch({ ...call, id: 'cancelled' }, scope()).catch(() => undefined)
    assert.equal(requests.length, 8)
    assert.deepEqual(marker, [message])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
