import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool } from 'pg'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../../src/modules/agent/tools/registry.js'
import { enqueueAgentRunLocked, type AgentDispatchLease } from '../../../src/modules/agent/run/dispatch.js'
import { withPostgresTransaction } from '../../../src/adapters/database/postgres-transaction.js'
import { createPostgresImAccess } from '../../../src/modules/im/gateway/inbound/access.js'
import { createPostgresImConversationStore } from '../../../src/modules/im/gateway/agent/conversations.js'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound/envelope.js'
import { createPostgresImReaction } from '../../../src/modules/im/gateway/attention/reactions.js'
import { createFeishuClient } from '@gugu/gateway/feishu'
import { createFeishuSender } from '@gugu/gateway/feishu'
import { imActorInputFromPayload } from '@gugu/core/im/access'

const url = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
const signal = () => new AbortController().signal
const response = (body: unknown) => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} })
async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup()
  try { await work(f) } finally { await f.close() }
}
async function setup() {
  const { Pool } = await import('pg'), schema = `im_react_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url }), pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 })
  const closeDb = async () => { await pool.end(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() } }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,owner_platform_user_id text,
        group_allowed_tools json,group_owner_memory_enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text,
        active_run_id text,execution_state text DEFAULT 'idle',pending_message_count integer DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,run_id text,chat_type text,platform_user_id text,im_platform_message_id varchar(512));
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,
        request_expires_at timestamptz,token text,fence bigint,lease_expires_at timestamptz,cancel_requested boolean DEFAULT false,
        PRIMARY KEY(user_id,session_id,run_id));`)
    await pool.query(imGatewaySql.conversation)
    await pool.query(imGatewaySql.reaction)
    const identity = { ownerId: randomUUID(), sessionId: '1', runId: 'synthetic-react-run' }, secretKey = 'synthetic-reaction-secret'
    const binding = { ownerId: identity.ownerId, platform: 'feishu' as const, botId: '7' }
    const payload = { owner_user_id: identity.ownerId, platform: 'feishu', bot_id: '7', channel_id: '7', chat_type: 'group',
      chat_id: 'oc_synthetic', platform_user_id: 'ou_owner', message_id: 'om_synthetic', platform_message_id: 'om_synthetic', text: '合成问题', bot_mentioned: true }
    await pool.query(`INSERT INTO users VALUES($1,true,'active')`, [identity.ownerId])
    await pool.query(`INSERT INTO user_bots VALUES(7,$1,'feishu',true,'ou_owner','[]',false,true,true)`, [identity.ownerId])
    await pool.query(`INSERT INTO conversation_sessions(id,user_id,source,bot_id,chat_type,chat_id,active_run_id) VALUES(1,$1,'feishu',7,'group','oc_synthetic',$2)`, [identity.ownerId, identity.runId])
    await pool.query(`INSERT INTO conversation_messages VALUES(1,1,'user',$1,'group','ou_owner','om_synthetic')`, [identity.runId])
    await pool.query(`INSERT INTO gugu_im_inbound_receipts VALUES($1,'feishu','7','group',$2,$2,$2,1,1,'dispatched',$3,$4)`,
      [identity.ownerId, 'a'.repeat(64), identity.runId, createImInboundEnvelope(secretKey).seal(binding, payload)])
    const lease: AgentDispatchLease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start', cancelRequested: false,
      input: { v: 3, source: 'im', userMessageId: 1, accessVersion: 'b'.repeat(64), locale: null, origin: null,
        im: { platform: 'feishu', botId: '7', chatType: 'group', chatId: 'oc_synthetic', platformUserId: 'ou_owner' } } }
    await withPostgresTransaction(pool, async client => {
      await client.query('SELECT 1 FROM conversation_sessions WHERE id=1 FOR UPDATE')
      await enqueueAgentRunLocked(client, secretKey, identity, lease.input, 3600)
      await client.query(`UPDATE agent_run_dispatch SET token='synthetic-lease',fence=1,lease_expires_at=clock_timestamp()+interval '1 hour'`)
    })
    const access = createPostgresImAccess({ query: (q, p) => pool.query(q, p), supportedPlatforms: () => ['feishu'] })
    const actorInput = { ownerId: identity.ownerId, platform: 'feishu' as const, botId: '7', chatType: 'group' as const,
      chatId: 'oc_synthetic', platformUserId: 'ou_owner', botMentioned: true, mentionsOtherBot: false }
    const snapshot = await access.snapshot(actorInput), actor = snapshot.actor(actorInput)
    const conversation = createPostgresImConversationStore({ pool, secretKey, attachments: { mode: 'text-only' },
      async classify() { throw new Error('此fixture只读取真实路由，不执行入站分类') },
      authorize: async (_client, b, p) => await access.readBot({ ...b, chatType: p.chat_type as 'group', platformUserId: String(p.platform_user_id) }) !== null })
    const state = { sends: 0, mode: 'accepted' as 'accepted' | 'rejected' | 'unknown', revokeOnAuth: false, configured: true }
    const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport: {
      async request(request) {
        if (new URL(request.url).pathname.includes('/auth/')) {
          if (state.revokeOnAuth) await pool.query('UPDATE users SET is_active=false')
          return response({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 })
        }
        assert.match(new URL(request.url).pathname, /\/om_synthetic\/reactions$/)
        state.sends++
        if (state.mode === 'unknown') throw new Error('合成不可公开上游凭据')
        return response(state.mode === 'rejected' ? { code: 999, message: '合成不可公开凭据' } : { code: 0, data: { reaction_id: 'synthetic-reaction' } })
      },
    } })
    const sender = createFeishuSender({ client })
    const options = { pool, secretKey, lease, actor, bot: snapshot.bot, access, readRoute: conversation.readRoute,
      async configuration() { return { source: 'feishu', identity: { ownerId: identity.ownerId, workspaceId: null,
        subject: { kind: 'session' as const, id: identity.sessionId } }, toolNames: state.configured ? ['react'] : [] } },
      sender: () => ({ platform: 'feishu' as const, sender, streaming: {} as never }) }
    const port = createPostgresImReaction(options)
    const call = (toolCallId = 'synthetic-call', emoji = 'HEART') => ({ identity, roundId: '1', toolCallId, emoji, signal: signal() })
    return { pool, identity, actor, port, options, call, state, payload, binding, async close() { await client.close(); await closeDb() } }
  } catch (error) { await closeDb(); throw error }
}

test('飞书reaction缺少可信平台运行绑定时拒绝构造', () => {
  assert.throws(() => createPostgresImReaction({ lease: { input: { v: 2, source: 'web' } }, actor: {}, bot: {} } as never))
})

test('真实PG/平台client：reaction正式注册/执行/恢复、防重放与授权边界', {
  skip: !url && '显式设置 GUGU_IM_GATEWAY_TEST_DATABASE_URL；查询替身不能证明CAS与真实路由', timeout: 30000,
}, async t => {
  await t.test('实际ToolRegistry仅飞书发现react，实际分派后重启reconcile不再次请求平台', () => fixture(async f => {
    const registry = (platform: 'feishu' | 'qq' | 'wechat' | 'telegram') => createAgentToolRegistry({ core: {} as SqlDataRuntime,
      imReaction: { platform, port: f.port }, authorize: async (id, name) => id.ownerId === f.identity.ownerId && name === 'react' })
    for (const platform of ['qq', 'wechat', 'telegram'] as const) assert.equal((await registry(platform).capabilities(f.identity)).some(row => row.name === 'react'), false)
    const actual = registry('feishu'), call = { id: 'tool-call-sensitive', name: 'react', input: { mood: 'love', message_id: 'om_forged' } }
    assert.equal((await actual.capabilities(f.identity)).some(row => row.name === 'react'), true)
    const result = await actual.tools.dispatch(call, { identity: f.identity, roundId: '1', signal: signal(), resolution: null,
      async execute() { throw new Error('表情工具不得执行进程') } })
    assert.equal(result.kind === 'completed' && result.successful, true)
    const recovered = await actual.tools.reconcile(call, { ...f.identity, roundId: '1' })
    assert.equal(recovered.kind === 'completed' && recovered.successful, true)
    assert.equal(f.state.sends, 1)
    assert.equal(await createPostgresImReaction(f.options).react(f.call('tool-call-sensitive')), 'accepted')
    assert.equal(f.state.sends, 1)
    const persisted = JSON.stringify((await f.pool.query('SELECT * FROM gugu_im_reaction_receipts')).rows)
    assert.doesNotMatch(persisted, /tool-call-sensitive|om_synthetic|om_forged/u)
  }))
  await t.test('同call并发/更换emoji不重复reaction，pending和未知跨重启不能重发', () => fixture(async f => {
    await Promise.all([f.port.react(f.call()), f.port.react(f.call())])
    assert.equal(f.state.sends, 1)
    assert.equal(await f.port.react(f.call('synthetic-call', 'WOW')), 'unknown')
    f.state.mode = 'unknown'
    assert.equal(await f.port.react(f.call('unknown-call')), 'unknown')
    assert.equal(await createPostgresImReaction(f.options).react(f.call('unknown-call')), 'unknown')
    assert.equal(await f.port.recover(f.call('unknown-call')), 'unknown')
    assert.equal(f.state.sends, 2)
  }))
  await t.test('明确拒绝可新attempt安全重试，平台接受后提交中断保留pending', () => fixture(async f => {
    f.state.mode = 'rejected'
    assert.equal(await f.port.react(f.call()), 'rejected')
    assert.equal(await f.port.recover(f.call()), 'rejected')
    f.state.mode = 'accepted'
    assert.equal(await f.port.react(f.call()), 'accepted')
    const broken = { query: (q: string, p?: unknown[]) => q.startsWith('UPDATE gugu_im_reaction_receipts') ? Promise.reject(new Error('合成提交中断')) : f.pool.query(q, p) } as Pick<Pool, 'query'>
    assert.equal(await createPostgresImReaction({ ...f.options, pool: broken }).react(f.call('lost-commit')), 'unknown')
    assert.equal(await f.port.react(f.call('lost-commit')), 'unknown')
    assert.equal(f.state.sends, 3)
  }))
  await t.test('跨owner/Run、租约fence、群/Bot会话变更及锚点收据缺失均不能请求平台', () => fixture(async f => {
    assert.equal(await f.port.react({ ...f.call(), identity: { ...f.identity, ownerId: randomUUID() } }), 'unknown')
    assert.equal(await f.port.react({ ...f.call(), identity: { ...f.identity, runId: 'foreign-run' } }), 'unknown')
    for (const [bad, restore] of [
      ['UPDATE agent_run_dispatch SET fence=2', 'UPDATE agent_run_dispatch SET fence=1'],
      ["UPDATE conversation_sessions SET chat_id='oc_other'", "UPDATE conversation_sessions SET chat_id='oc_synthetic'"],
      ['UPDATE conversation_sessions SET bot_id=8', 'UPDATE conversation_sessions SET bot_id=7'],
      ["UPDATE gugu_im_inbound_receipts SET state='passive',run_id=NULL", "UPDATE gugu_im_inbound_receipts SET state='dispatched',run_id='synthetic-react-run'"],
      ['UPDATE agent_run_dispatch SET cancel_requested=true', 'UPDATE agent_run_dispatch SET cancel_requested=false'],
      ["UPDATE conversation_messages SET platform_user_id='ou_other'", "UPDATE conversation_messages SET platform_user_id='ou_owner'"],
    ]) {
      await f.pool.query(bad!); assert.equal(await f.port.react(f.call()), 'rejected'); await f.pool.query(restore!)
    }
    assert.equal(f.state.sends, 0)
    await f.pool.query(`UPDATE gugu_im_inbound_receipts SET sealed_payload=$1`, [createImInboundEnvelope(f.options.secretKey).seal(f.binding,
      { ...f.payload, message_id: 'om_other_run', platform_message_id: 'om_other_run' })])
    assert.equal(await f.port.react(f.call()), 'rejected')
    assert.equal(f.state.sends, 0)
    f.state.configured = false
    assert.equal(await f.port.react(f.call()), 'rejected')
    assert.equal(f.state.sends, 0)
  }))
  await t.test('token刷新期间撤权在真实client业务HTTP之前拒绝，工具不给模型原始错误', () => fixture(async f => {
    f.state.revokeOnAuth = true
    assert.equal(await f.port.react(f.call()), 'rejected')
    assert.equal(f.state.sends, 0)
    const controller = new AbortController(), reason = new Error('合成取消'); controller.abort(reason)
    await assert.rejects(f.port.react({ ...f.call(), signal: controller.signal }), error => error === reason)
  }))
  await t.test('owner私聊允许显式Web会话绑定，但物理发言人变化不能回应另一用户', () => fixture(async f => {
    const payload = { ...f.payload, chat_type: 'c2c', chat_id: 'oc_private' }
    const lease = structuredClone(f.options.lease)
    assert.equal(lease.input.v, 3)
    if (lease.input.v !== 3) throw new Error('fixture必须是真实IM v3')
    lease.input.im.chatType = 'c2c'; lease.input.im.chatId = null
    await f.pool.query(`UPDATE conversation_sessions SET source='web',bot_id=NULL,chat_type=NULL,chat_id=NULL;
      UPDATE conversation_messages SET chat_type='c2c'; DELETE FROM agent_run_dispatch`)
    await f.pool.query(`UPDATE gugu_im_inbound_receipts SET chat_type='c2c',sealed_payload=$1`, [createImInboundEnvelope(f.options.secretKey).seal(f.binding, payload)])
    await withPostgresTransaction(f.pool, async client => {
      await client.query('SELECT 1 FROM conversation_sessions WHERE id=1 FOR UPDATE')
      await enqueueAgentRunLocked(client, f.options.secretKey, f.identity, lease.input, 3600)
      await client.query(`UPDATE agent_run_dispatch SET token='synthetic-lease',fence=1,lease_expires_at=clock_timestamp()+interval '1 hour'`)
    })
    const snapshot = await f.options.access.snapshot(imActorInputFromPayload(f.binding, payload))
    const actor = snapshot.actor(imActorInputFromPayload(f.binding, payload))
    const port = createPostgresImReaction({ ...f.options, lease, actor, bot: snapshot.bot })
    assert.equal(await port.react(f.call()), 'accepted')
    await f.pool.query(`UPDATE conversation_messages SET platform_user_id='ou_other'`)
    assert.equal(await port.react(f.call('other-speaker')), 'rejected')
    assert.equal(f.state.sends, 1)
  }))
  await t.test('真实persistBatch全量收据证明：同发言人批次只回应最后锚点，缺任一成员不继续回应', () => fixture(async f => {
    await f.pool.query(`ALTER TABLE conversation_sessions ADD platform_user_id text,ADD updated_at timestamptz DEFAULT clock_timestamp(),ADD last_message_seq bigint DEFAULT 1;
      CREATE SEQUENCE synthetic_message_ids START 2;
      ALTER TABLE conversation_messages ALTER id SET DEFAULT nextval('synthetic_message_ids'),ADD conversation_seq bigint DEFAULT 1,
        ADD content text DEFAULT '',ADD client_message_id text,ADD files jsonb,ADD quoted_text text,ADD platform_user_name text,ADD platform_bot_user_id text,
        ADD im_reply_to_message_id text,ADD im_reply_target_sender_id text,ADD im_reply_target_is_bot boolean,ADD im_sender_is_bot boolean,
        ADD im_event_received_ms bigint,ADD im_platform_sent_ms bigint,ADD created_at timestamptz DEFAULT clock_timestamp(),ADD sent_at timestamptz;
      UPDATE agent_run_dispatch SET state='done'`)
    // 只替代群回应策略选择；持久批次、加密、权限、锚点和读取链实际执行。
    const store = createPostgresImConversationStore({ pool: f.pool, secretKey: f.options.secretKey, attachments: { mode: 'text-only' },
      classify: async () => 'reply', authorize: async (_client, binding, payload) => await f.options.access.readBot({ ...binding,
        chatType: payload.chat_type as 'group', platformUserId: String(payload.platform_user_id) }) !== null })
    const secondIdentity = { ...f.identity, runId: 'synthetic-batch-react' }
    let lease: AgentDispatchLease | undefined
    const result = await store.persistBatch(f.binding, [2, 3].map(index => ({ eventId: `170000000000${index}-0`,
      payload: { ...f.payload, bot_mentioned: false, platform_sent_ms: 1700000000000 + index,
        message_id: `om_batch_${index}`, platform_message_id: `om_batch_${index}` } })), {
      mode: 'dispatch', sessionId: 1, async onDispatch(client, segment) {
        const messageIds = segment.anchors.map(item => item.messageId)
        lease = { ...f.options.lease, identity: secondIdentity, input: { v: 3, source: 'im', userMessageId: messageIds.at(-1)!, accessVersion: 'b'.repeat(64), locale: null, origin: null,
          im: { platform: 'feishu', botId: '7', chatType: 'group', chatId: 'oc_synthetic', platformUserId: 'ou_owner',
            batch: { batchKey: segment.batchKey, segmentKey: segment.segmentKey, messageIds } } } }
        await enqueueAgentRunLocked(client, f.options.secretKey, secondIdentity, lease.input, 3600)
        return secondIdentity.runId
      },
    })
    assert.equal(result.segments.length, 1); assert.equal(result.segments[0]!.anchors.length, 2); assert.ok(lease)
    await f.pool.query('UPDATE conversation_sessions SET active_run_id=$1', [secondIdentity.runId])
    await f.pool.query(`UPDATE agent_run_dispatch SET token='synthetic-lease',fence=1,lease_expires_at=clock_timestamp()+interval '1 hour'`)
    const route = await store.readRoute(secondIdentity), input = imActorInputFromPayload(route.binding, route.payload)
    const snapshot = await f.options.access.snapshot(input), actor = snapshot.actor(input)
    const port = createPostgresImReaction({ ...f.options, lease, actor, bot: snapshot.bot, readRoute: store.readRoute,
      configuration: async () => ({ source: 'feishu', identity: { ownerId: f.identity.ownerId, workspaceId: null, subject: { kind: 'session' as const, id: '1' } }, toolNames: ['react'] }),
      sender: () => ({ platform: 'feishu', sender: createFeishuSender({ client: { async call(_method, path, args) {
        assert.equal(path, '/open-apis/im/v1/messages/om_batch_3/reactions')
        assert.equal(await args?.authorize?.(), true)
        f.state.sends++; return { code: 0, data: { reaction_id: 'synthetic-batch-reaction' } }
      } } }), streaming: {} as never }) })
    assert.equal(await port.react({ ...f.call(), identity: secondIdentity }), 'accepted')
    await f.pool.query('DELETE FROM gugu_im_inbound_receipts WHERE message_id=$1', [result.segments[0]!.anchors[0]!.messageId])
    assert.equal(await port.react({ ...f.call('missing-member'), identity: secondIdentity }), 'unknown')
    assert.equal(f.state.sends, 1)
  }))
})
