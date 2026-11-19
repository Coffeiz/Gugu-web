import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { attentionMessageFromPayload } from '@gugu/core/im/attention/message'
import { createPostgresRedisImAttentionSnapshot } from '../../../src/modules/im/gateway/attention/snapshot.js'
import { createPostgresImAttentionRuntime } from '../../../src/modules/im/gateway/attention/runtime.js'
import { createRedisImPendingAskStore } from '../../../src/modules/im/gateway/interactions/ask.js'
import { createRedisStreamCommands } from '../../../src/adapters/cache/redis-stream-commands.js'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound/envelope.js'
import { nodeImAttentionKeys } from '../../../src/modules/im/gateway/inbound/inbox.js'
import { createPostgresImAcceptedFactsReader } from '../../../src/modules/im/gateway/attention/ledger.js'
import { withPostgresImDeliveryStore } from '../../../src/modules/im/gateway/delivery/store.js'
import { imAcceptedEvidence } from '../../../src/modules/im/gateway/agent/evidence.js'
import { createImRunDelivery } from '@gugu/core/im/run-delivery'
import type { ImAttentionVoiceReadInput, ImAttentionVoiceResult } from '../../../src/modules/im/gateway/attention/voice.js'

/** 本组仅替换PG策略/snapshot/prepareVoice端口；实际Host编排与Core算法运行，不冒充持久ASR收据验收。 */
function voiceHarness(prepare: (input: ImAttentionVoiceReadInput) => Promise<readonly ImAttentionVoiceResult[]>) {
  type Options = Parameters<typeof createPostgresImAttentionRuntime>[0]
  const policy = { group_requires_at: false, group_read_enabled: false, group_attention_mode: 'natural', group_attention_config_version: 1, name: '合成咕咕' }
  const voiceScope = { ownerId: '00000000-0000-4000-8000-000000000042', platform: 'qq' as const, botId: '42', groupId: 'synthetic-group' }
  const counters = { prepare: 0, snapshot: 0 }, observed: ReturnType<typeof attentionMessageFromPayload>[] = []
  const runtime = createPostgresImAttentionRuntime({
    pool: { query: async () => ({ rows: [structuredClone(policy)] }) } as unknown as Options['pool'],
    snapshot: { async load(input: Parameters<Options['snapshot']['load']>[0]) { counters.snapshot++; observed.push(...input.messages); return { messages: [...input.messages], complete: true,
      botReplies: { bot_previous: { accepted: true, recipientSenderId: 'speaker-a' } } } } } as unknown as Options['snapshot'],
    pending: { observe: async () => {}, cancel: async () => {}, register: async () => true,
      isIssued: async () => true, isCurrent: async () => true, isCancelled: async () => false } as unknown as Options['pending'],
    async prepareVoice(input) { counters.prepare++; return prepare(input) }, now: () => 1_700_000_000_010,
  })
  const message = (text = '') => ({ platform: 'qq', owner_user_id: voiceScope.ownerId, bot_id: voiceScope.botId,
    chat_type: 'group', chat_id: voiceScope.groupId, platform_user_id: 'speaker-a', message_id: 'native-a', platform_message_id: 'native-a',
    text, attention_raw_text: text, attachments: ['audio-a'], media_kinds: ['audio'], media_only: true, native_bot_mentioned: false, sender_is_bot: false })
  return { runtime, scope: voiceScope, policy, counters, observed, message }
}

test('注意力转写只增强内存candidate：去除attention_raw_text旧优先值，原payload/subject不改且文本实际参与评分', async () => {
  const f = voiceHarness(async () => [{ eventId: '1700000000000-1', attachId: 'audio-a', text: '咕咕看吧' }])
  const payload = f.message(), original = structuredClone(payload)
  const result = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [{ eventId: '1700000000000-1', payload }] }, new AbortController().signal)
  assert.equal(result.disposition, 'run'); assert.equal(result.subject?.eventId, '1700000000000-1')
  assert.equal(f.observed[0]?.rawText, '咕咕看吧'); assert.equal(f.observed[0]?.candidateText, '咕咕看吧'); assert.equal(f.observed[0]?.mediaOnly, false)
  assert.deepEqual(payload, original); assert.deepEqual(result.subject?.payload, original)
})

test('非autonomous按Python先完整批预转写：前条语音转为可信CONTINUE时优先于后条DIRECT', async () => {
  const f = voiceHarness(async input => { assert.equal(input.candidates.length, 2); return [{ eventId: '1700000000000-1', attachId: 'audio-a', text: '这是详细的补充信息' }] })
  const first = { ...f.message(), reply_target_is_bot: true, reply_to_platform_message_id: 'bot_previous' }
  const second = { ...f.message('咕咕你好'), platform_user_id: 'speaker-b', native_bot_mentioned: true }
  const result = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [
    { eventId: '1700000000000-1', payload: first }, { eventId: '1700000000001-1', payload: second }] }, new AbortController().signal)
  assert.equal(result.decision?.kind, 'CONTINUE'); assert.equal(result.subject?.eventId, '1700000000000-1'); assert.equal(f.counters.prepare, 1)
})

test('autonomous及既有只读/仅@/group_mentioned bypass不调用可选ASR，null/空识别不虚构文本', async () => {
  for (const mode of ['autonomous', 'requires-at', 'read-only', 'group-mentioned']) {
    const f = voiceHarness(async () => { assert.fail('快出口不应预转写') })
    if (mode === 'autonomous') f.policy.group_attention_mode = mode
    if (mode === 'requires-at') f.policy.group_requires_at = true
    if (mode === 'read-only') f.policy.group_read_enabled = true
    await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [{ eventId: '1700000000000-1', payload: { ...f.message('非空合成消息'), group_mentioned: mode === 'group-mentioned' } }] }, new AbortController().signal)
    assert.equal(f.counters.prepare, 0); assert.equal(f.counters.snapshot, 0)
  }
  for (const text of [null, '', '\u0085\u001c']) {
    const f = voiceHarness(async () => [{ eventId: '1700000000000-1', attachId: 'audio-a', text }])
    const result = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [{ eventId: '1700000000000-1', payload: f.message() }] }, new AbortController().signal)
    assert.equal(result.disposition, 'passive'); assert.equal(f.observed[0]?.rawText, ''); assert.equal(f.observed[0]?.mediaOnly, true)
  }
})

test('跨事件/跨附件或重复转写结果拒绝；可信source拒绝原样抛出，不能以空候选继续评分', async () => {
  for (const results of [[{ eventId: '1700000000002-1', attachId: 'audio-a', text: '越界' }],
    [{ eventId: '1700000000000-1', attachId: 'other-attachment', text: '越界' }],
    [{ eventId: '1700000000000-1', attachId: 'audio-a', text: '重复' }, { eventId: '1700000000000-1', attachId: 'audio-a', text: '重复' }]]) {
    const f = voiceHarness(async () => results)
    await assert.rejects(f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [{ eventId: '1700000000000-1', payload: f.message() }] }, new AbortController().signal), /群自动回复决策不可用/u)
    assert.equal(f.counters.snapshot, 0)
  }
  const denied = new Error('合成附件证明拒绝'), f = voiceHarness(async () => { throw denied })
  await assert.rejects(f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [{ eventId: '1700000000000-1', payload: f.message() }] }, new AbortController().signal), error => error === denied)
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL, redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
const skip = (!pgUrl || !redisUrl) && '需要显式隔离 PostgreSQL 与 Redis'
const signal = new AbortController().signal
async function fixture() {
  const { Pool } = await import('pg')
  const schema = `im_attention_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: pgUrl })
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  const commands = createRedisStreamCommands(redisUrl!), touched = new Set<string>(), index = 'im:node:{pending-ask}:due:v1'
  const redis = { async sendCommand(parts: string[]) {
    if (parts[0] === 'EVAL') for (const key of parts.slice(3, 3 + Number(parts[2]))) if (key !== index) touched.add(key)
    return commands.sendCommand(parts)
  } }
  const scope = { ownerId: randomUUID(), platform: 'qq' as const, botId: '42', groupId: 'synthetic-group' }
  const binding = { ownerId: scope.ownerId, platform: scope.platform, botId: scope.botId }
  const secretKey = randomUUID(), envelope = createImInboundEnvelope(secretKey)
  let now = Date.now()
  const payload = (text: string, sender = 'synthetic-member', id = randomUUID()) => ({ owner_user_id: scope.ownerId,
    platform: scope.platform, bot_id: scope.botId, channel_id: scope.botId, chat_type: 'group', chat_id: scope.groupId,
    platform_user_id: sender, message_id: id, platform_message_id: id, text, attachments: [], native_bot_mentioned: false })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,
        group_requires_at boolean,group_read_enabled boolean,group_attention_mode text,group_attention_config_version integer,name text);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,im_event_received_ms bigint,conversation_seq bigint);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,platform text,bot_id varchar(128),chat_type text,session_id integer,message_id integer,sealed_payload jsonb);`)
    await pool.query(`INSERT INTO users VALUES($1,true,'active');`, [scope.ownerId])
    await pool.query(`INSERT INTO user_bots VALUES(42,$1,'qq',true,true,NULL,false,false,'natural',0,'合成咕咕')`, [scope.ownerId])
    await pool.query(`INSERT INTO conversation_sessions VALUES(1,$1,'qq','42','group',$2),(2,$1,'qq','42','group','other-group')`, [scope.ownerId, scope.groupId])
    const keys = nodeImAttentionKeys(binding, scope.groupId)
    // 模拟由真实Node inbox在更早时刻建立的覆盖marker；正文仍经过正式密封/解析。
    await redis.sendCommand(['EVAL', "redis.call('SET',KEYS[1],ARGV[1],'EX',1800); return 1", '1', keys.start, String(now - 700_000)])
    const pending = createRedisImPendingAskStore({ redis, secretKey, now: () => now })
    const snapshot = createPostgresRedisImAttentionSnapshot({ pool, redis, secretKey, acceptedFacts: { async read() { return [] } } })
    const runtime = createPostgresImAttentionRuntime({ pool, snapshot, pending, now: () => now })
    return { scope, binding, secretKey, envelope, pool, redis, payload, pending, snapshot, runtime, now: () => now, advance: (ms: number) => { now += ms },
      async add(p: Record<string, unknown>, at: number, id = 1, sessionId = 1) {
        await pool.query('INSERT INTO conversation_messages VALUES($1,$2,\'user\',$3,$4)', [id, sessionId, at, id])
        await pool.query('INSERT INTO gugu_im_inbound_receipts VALUES($1,$2,$3,\'group\',$4,$5,$6::jsonb)', [scope.ownerId, scope.platform, scope.botId, sessionId, id, JSON.stringify(envelope.seal(binding, p))])
      },
      async stream(p: Record<string, unknown>, eventId: string) {
        await redis.sendCommand(['EVAL', "return redis.call('XADD',KEYS[1],ARGV[1],'data',ARGV[2])", '1', keys.stream, eventId, JSON.stringify(envelope.seal(binding, p))])
      },
      async cleanup() {
        await commands.sendCommand(['EVAL', "for i=1,#KEYS-1 do redis.call('DEL',KEYS[i]); local id=string.match(KEYS[i],':v1:([a-f0-9]+)$'); if id then redis.call('ZREM',KEYS[#KEYS],id) end end; return 1", String(touched.size + 1), ...touched, index])
        await commands.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
      },
    }
  } catch (error) { await commands.close(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); throw error }
}

test('真实PG/Redis snapshot：密封历史与真实stream合并、跨群拒绝、旧db身份不冒充可运行事件，缺coverage/facts不伪完整', { skip }, async () => {
  const f = await fixture()
  try {
    const old = f.payload('合成历史'), current = f.payload('如何开始部署？'), cross = { ...f.payload('其他群正文'), chat_id: 'other-group' }
    await f.add(old, f.now() - 10_000); await f.add(cross, f.now() - 9000, 2, 2)
    await f.stream(old, `${f.now() - 10_000}-1`)
    const messages = [attentionMessageFromPayload(`${f.now()}-1`, current)]
    let result = await f.snapshot.load({ scope: f.scope, sessionId: 1, messages, watermarkMs: f.now() }, signal)
    assert.equal(result.complete, true)
    assert.equal(result.messages.length, 2); assert.equal(result.messages[0]?.eventId, `${f.now() - 10_000}-1`)
    assert.ok(!JSON.stringify(result).includes('其他群正文'))
    await assert.rejects(f.snapshot.load({ scope: { ...f.scope, groupId: 'other-group' }, sessionId: 1, messages, watermarkMs: f.now() }, signal), /群注意力上下文不可用/u)
    const noLedger = createPostgresRedisImAttentionSnapshot({ pool: f.pool, redis: f.redis, secretKey: f.secretKey })
    assert.equal((await noLedger.load({ scope: f.scope, sessionId: 1, messages, watermarkMs: f.now() }, signal)).complete, false)
    const keys = nodeImAttentionKeys(f.binding, f.scope.groupId)
    await f.redis.sendCommand(['EVAL', "redis.call('DEL',KEYS[1]);redis.call('DEL',KEYS[2]);return 1", '2', keys.stream, keys.start])
    result = await f.snapshot.load({ scope: f.scope, sessionId: 1, messages, watermarkMs: f.now() }, signal)
    assert.equal(result.complete, false); assert.equal(result.windowTruncated, true); assert.equal(result.messages[0]?.eventId, 'db:1')
    const originalStreamId = `${f.now() - 4000}-7`
    await f.add({ ...f.payload('新版Host固化原事件'), _node_stream_event_id: originalStreamId }, f.now() - 4000, 3)
    result = await f.snapshot.load({ scope: f.scope, sessionId: 1, messages, watermarkMs: f.now() }, signal)
    assert.ok(result.messages.some(m => m.eventId === originalStreamId))
    await f.pool.query('UPDATE user_bots SET enabled=false')
    await assert.rejects(f.snapshot.load({ scope: f.scope, sessionId: 1, messages, watermarkMs: f.now() }, signal), /群注意力上下文不可用/u)
  } finally { await f.cleanup() }
})

test('真实attention编排：合批选中正确speaker、ASK延迟只存原事件、唤醒不被后续群消息提高分数或更换主体', { skip }, async () => {
  const f = await fixture()
  try {
    const first = { eventId: `${f.now()}-1`, payload: f.payload('谢谢', 'synthetic-owner') }
    const ask = { eventId: `${f.now()}-2`, payload: f.payload('请问为什么一直无法启动？', 'synthetic-member') }
    const result = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [first, ask] }, signal)
    assert.equal(result.disposition, 'pending'); assert.equal(result.subject?.payload.platform_user_id, 'synthetic-member')
    assert.equal(result.decision?.sceneType, 'ASK')
    f.advance(60_000)
    const [resume] = await f.pending.claimDue(); assert.ok(resume)
    assert.equal(resume.trigger.eventId, ask.eventId); assert.equal(resume.trigger.payload.text, ask.payload.text)
    assert.equal(resume.trigger.eventMs, Number(ask.eventId.split('-')[0]))
    const resumed = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [{ eventId: ask.eventId, payload: resume.trigger.payload }], resume }, signal)
    assert.equal(resumed.disposition, 'run'); assert.equal(resumed.replyChoice, 'pending'); assert.equal(resumed.subject?.eventId, ask.eventId)
    const otherSpeaker = { ...resume.trigger.payload, platform_user_id: 'synthetic-owner' }
    const invalid = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [{ eventId: ask.eventId, payload: otherSpeaker }], resume }, signal)
    assert.equal(invalid.disposition, 'passive')
    await f.pool.query("UPDATE user_bots SET group_requires_at=true,group_attention_config_version=1")
    assert.equal((await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [first] }, signal)).disposition, 'bypass')
  } finally { await f.cleanup() }
})

test('真实当前策略：混批能力请求选实际成员，配置变更/等待期间撤权拒绝；自主模式仅首事件保持Python语义', { skip }, async () => {
  const f = await fixture()
  try {
    const first = { eventId: `${f.now()}-1`, payload: f.payload('谢谢', 'synthetic-owner') }
    const second = { eventId: `${f.now()}-2`, payload: f.payload('帮我创建一个项目', 'synthetic-member') }
    const result = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [first, second] }, signal)
    assert.equal(result.disposition, 'run'); assert.equal(result.decision?.kind, 'CAPABILITY_ACTION')
    assert.equal(result.subject?.eventId, second.eventId); assert.equal(result.subject?.payload.platform_user_id, 'synthetic-member')
    await f.pool.query("UPDATE user_bots SET group_attention_mode='autonomous',group_attention_config_version=1")
    const autonomous = await f.runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [first, second] }, signal)
    assert.equal(autonomous.disposition, 'passive'); assert.equal(autonomous.configVersion, 1)
    await f.pool.query("UPDATE user_bots SET group_attention_mode='natural',group_attention_config_version=2")
    // 真实PG在快照读取期间撤权；不能把入站开始时的旧Bot许可沿用到决策返回。
    const snapshot = createPostgresRedisImAttentionSnapshot({ pool: f.pool, redis: f.redis, secretKey: f.secretKey,
      acceptedFacts: { async read() { await f.pool.query('UPDATE user_bots SET enabled=false'); return [] } } })
    const runtime = createPostgresImAttentionRuntime({ pool: f.pool, snapshot, pending: f.pending, now: f.now })
    await assert.rejects(runtime.evaluate({ scope: f.scope, sessionId: 1, candidates: [second] }, signal), /群注意力上下文不可用/u)
  } finally { await f.cleanup() }
})

test('实际共享delivery→PG原子accepted ledger→真实snapshot/attention，只有已确认final激活原成员，迟到成员事实按各候选水位判断', {skip}, async()=>{
  const f=await fixture()
  try{
    await f.pool.query(imGatewaySql.delivery)
    await f.pool.query(imGatewaySql.attentionLedger)
    const identity={ownerId:f.scope.ownerId,sessionId:'1',runId:'synthetic-accepted-run'}
    const evidenceScope={ownerId:f.scope.ownerId,botId:f.scope.botId,platform:f.scope.platform,chatType:'group' as const,chatId:f.scope.groupId,platformUserId:'synthetic-member'}
    const finalEvent={id:'synthetic-final',identity,sequence:1,round:1,type:'final' as const,payload:{text:'合成已确认部署结果',status:'completed'}}
    let sends=0
    await withPostgresImDeliveryStore(f.pool,identity,async receipts=>{
      const delivery=createImRunDelivery({runner:{start(){assert.fail('恢复只读已持久outbox，不运行Provider')}},events:{async readAfter(_id,seq){return seq<1?[finalEvent]:[]}},receipts,
        digest:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),authorize:async()=>true,
        sender:{async text(input){sends++;return imAcceptedEvidence({scope:evidenceScope,recipient:f.scope.groupId,kind:'text',text:input.text,
          source:{sourceEventIds:[`${f.now()-5000}-1`],sourceMessageIds:['synthetic-source'],sourceEventIdsComplete:true},receipt:{outcome:'accepted',platformMessageIds:['native-accepted']}})},
          async artifact(){assert.fail('无附件')},async interaction(){assert.fail('无交互')}}})
      await delivery.recover(identity);await delivery.recover(identity)
    },{secretKey:f.secretKey,ledger:{scope:evidenceScope,recipientSenderId:'synthetic-member',sourceAttentionKind:'DIRECT',proactive:false}})
    assert.equal(sends,1)
    const accepted=Number((await f.pool.query('SELECT ceil(extract(epoch FROM accepted_at)*1000)::bigint::text AS ms FROM gugu_im_accepted_delivery_facts')).rows[0]!.ms)
    f.advance(accepted-f.now()+1000)
    const snapshot=createPostgresRedisImAttentionSnapshot({pool:f.pool,redis:f.redis,secretKey:f.secretKey,acceptedFacts:createPostgresImAcceptedFactsReader({pool:f.pool,secretKey:f.secretKey})})
    const first={eventId:`${accepted-1}-1`,payload:f.payload('谢谢','synthetic-owner')},second={eventId:`${f.now()}-1`,payload:f.payload('这个方案再讨论一下','synthetic-member')}
    const messages=[attentionMessageFromPayload(first.eventId,first.payload),attentionMessageFromPayload(second.eventId,second.payload)]
    const loaded=await snapshot.load({scope:f.scope,sessionId:1,messages,watermarkMs:f.now()},signal)
    assert.equal(loaded.complete,true);assert.equal(loaded.latestAcceptedFinal,null,'全群topic不得越过最早候选时间')
    assert.ok(loaded.acceptedOutboundFacts?.some(fact=>fact.recipientSenderId==='synthetic-member'))
    const runtime=createPostgresImAttentionRuntime({pool:f.pool,snapshot,pending:f.pending,now:f.now})
    const result=await runtime.evaluate({scope:f.scope,sessionId:1,candidates:[first,second]},signal)
    assert.equal(result.disposition,'run');assert.equal(result.decision?.kind,'MEMBER_ACTIVE');assert.equal(result.subject?.eventId,second.eventId)
  }finally{await f.cleanup()}
})
