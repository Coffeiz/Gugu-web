import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { attentionSourceKind, parseImAttentionRecord } from '@gugu/core/im/attention/directive'
import { createRedisStreamCommands } from '../../../src/adapters/cache/redis-stream-commands.js'
import { createPostgresImAttentionRuntime } from '../../../src/modules/im/gateway/attention-runtime.js'
import { createPostgresRedisImAttentionSnapshot } from '../../../src/modules/im/gateway/attention-snapshot.js'
import { createRedisImPendingAskStore } from '../../../src/modules/im/gateway/pending-ask.js'
import { createPostgresImPendingAskDispatcher } from '../../../src/modules/im/gateway/pending-ask-dispatch.js'
import { createPostgresImConversationStore } from '../../../src/modules/im/gateway/conversation-postgres.js'
import { createPostgresImAccess } from '../../../src/modules/im/gateway/access-postgres.js'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound-envelope.js'
import { registerAgentRunStartupLocked } from '../../../src/modules/agent-sessions/persistence/agent-run-startup-postgres.js'
import { enqueueAgentRunLocked, decryptAgentDispatchInput } from '../../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL, redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
test('真实PG/Redis：正式attention被动ASK→内部唤醒→同事务startup/v3密封Run；并发重放一次、原被动段不升级、伪唤醒/撤权拒绝', {
  skip: (!pgUrl || !redisUrl) && '需要显式隔离PostgreSQL/Redis',
}, async () => {
  const { Pool } = await import('pg'), schema = `im_pending_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl }), pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 5 })
  const commands = createRedisStreamCommands(redisUrl!), touched = new Set<string>(), index = 'im:node:{pending-ask}:due:v1'
  const redis = { async sendCommand(parts: string[]) {
    if (parts[0] === 'EVAL') for (const key of parts.slice(3,3+Number(parts[2]))) if (key !== index) touched.add(key)
    return commands.sendCommand(parts)
  } }
  const secretKey = randomUUID(), ownerId = randomUUID(), binding = { ownerId, platform: 'qq' as const, botId: '42' }
  const scope = { ...binding, groupId: 'synthetic-group' }, signal = new AbortController().signal
  let now = Date.now(), enqueued = 0
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,
        group_requires_at boolean,group_read_enabled boolean,group_attention_mode text,group_attention_config_version integer,name text,
        owner_platform_user_id text,group_allowed_tools jsonb,group_owner_memory_enabled boolean);
      CREATE TABLE conversation_sessions(id serial PRIMARY KEY,user_id uuid REFERENCES users(id),title text,title_locked boolean,summary text,source text,bot_id varchar(128),chat_id text,platform_user_id text,chat_type text,context_epoch integer,baseline_message_seq bigint,last_message_seq bigint,execution_state text,pending_message_count integer,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE conversation_messages(id serial PRIMARY KEY,session_id integer REFERENCES conversation_sessions(id),conversation_seq bigint,role text,content text,client_message_id varchar(64),files jsonb,quoted_text text,platform_user_id text,platform_user_name text,platform_bot_user_id text,chat_type text,im_platform_message_id text,im_reply_to_message_id text,im_reply_target_sender_id text,im_reply_target_is_bot boolean,im_sender_is_bot boolean,im_event_received_ms bigint,im_platform_sent_ms bigint,run_id text,created_at timestamptz,sent_at timestamptz,UNIQUE(session_id,conversation_seq),UNIQUE(session_id,client_message_id));
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_dispatch(sequence bigint GENERATED ALWAYS AS IDENTITY,user_id uuid,session_id integer,run_id text,state text,nonce bytea,payload bytea,request_expires_at timestamptz,message_id integer,PRIMARY KEY(user_id,session_id,run_id));`)
    await pool.query(await readFile(new URL('../../../src/modules/im/gateway/conversation-schema.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../../src/modules/im/gateway/pending-ask-schema.sql', import.meta.url), 'utf8'))
    await pool.query(`INSERT INTO users VALUES($1,true,'active')`, [ownerId])
    await pool.query(`INSERT INTO user_bots VALUES(42,$1,'qq',true,true,NULL,false,false,'natural',0,'合成咕咕','owner-user','[]',false)`, [ownerId])
    const pending = createRedisImPendingAskStore({ redis, secretKey, now: () => now })
    const snapshot = createPostgresRedisImAttentionSnapshot({ pool, redis, secretKey, acceptedFacts: { async read() { return [] } } })
    const attention = createPostgresImAttentionRuntime({ pool, snapshot, pending, now: () => now })
    const payload = { platform: 'qq', owner_user_id: ownerId, bot_id: '42', channel_id: '42', chat_type: 'group', chat_id: scope.groupId,
      platform_user_id: 'synthetic-member', message_id: 'native-ask', platform_message_id: 'native-ask', text: '请问为什么一直无法启动？', attachments: [], native_bot_mentioned: false }
    const eventId = `${now}-1`
    const store = createPostgresImConversationStore({ pool, secretKey, attachments: { mode: 'text-only' },
      async authorize(client, b, p) { const access = createPostgresImAccess({ query: (sql, values) => client.query(sql,values), supportedPlatforms: () => ['qq'] }); return !!await access.readBot({ ownerId:b.ownerId,botId:b.botId,platform:b.platform,chatType:'group',chatId:String(p.chat_id),platformUserId:String(p.platform_user_id) }) },
      async classify() { return 'reply' },
    })
    const { segments } = await store.persistBatch(binding,[{ eventId,payload }], { batchId: 'synthetic-batch', mode:'dispatch',
      async beforeDispatch(segment) {
        const r = await attention.evaluate({ scope, sessionId: segment.anchors[0]!.sessionId,candidates:[{eventId,payload}] }, signal)
        return parseImAttentionRecord({v:1,disposition:r.disposition,mode:r.mode,configVersion:r.configVersion,subjectEventId:r.subject?.eventId??null,
          sourceAttentionKind:attentionSourceKind(r.decision?.kind),proactive:r.decision?.kind==='PROACTIVE',replyChoice:'reply'})
      },
      async validateAttention(client,r) { return (await client.query('SELECT 1 FROM user_bots WHERE id=42 AND group_attention_config_version=$1',[r.configVersion])).rowCount===1 },
      async onDispatch() { assert.fail('首次ASK必须被动，不创建Run') },
    })
    assert.equal(segments[0]?.runId,null)
    now += 60_000
    const [resume] = await pending.claimDue(); assert.ok(resume)
    const dispatcher = createPostgresImPendingAskDispatcher({ pool,secretKey,pending,attention,supportedPlatforms:()=>['qq'],notify:async()=>{},diagnose:()=>{},
      async enqueue(client,input) {
        enqueued++
        const identity = {ownerId,sessionId:String(input.anchor.sessionId),runId:randomUUID()}
        assert.equal(await registerAgentRunStartupLocked(client,identity),true)
        await enqueueAgentRunLocked(client,secretKey,identity,{v:3,source:'im',origin:null,userMessageId:input.anchor.messageId,locale:null,accessVersion:'a'.repeat(64),
          im:{platform:'qq',botId:'42',chatType:'group',chatId:scope.groupId,platformUserId:'synthetic-member',attention:input.attention}},604800)
        return identity.runId
      },
    })
    const [a,b] = await Promise.all([dispatcher.dispatch(resume,signal),dispatcher.dispatch(resume,signal)])
    assert.equal(a.state,'dispatched'); assert.deepEqual(a,b); assert.equal(enqueued,1)
    assert.equal((await pool.query("SELECT 1 FROM gugu_im_inbound_segments WHERE mode='passive' AND state='completed' AND run_id IS NULL")).rowCount,1)
    const dispatch = (await pool.query('SELECT nonce,payload,run_id FROM agent_run_dispatch')).rows[0]!
    const request = decryptAgentDispatchInput(secretKey,{ownerId,sessionId:String(resume.trigger.payload.session_id),runId:dispatch.run_id},dispatch.nonce,dispatch.payload)
    assert.equal(request.v,3); assert.equal(request.source,'im'); assert.equal(request.im?.attention?.subjectEventId,eventId)
    const identity = {ownerId,sessionId:String(resume.trigger.payload.session_id),runId:a.runId!}
    const route = createImInboundEnvelope(secretKey).open(binding,(await pool.query("SELECT sealed_payload FROM gugu_im_inbound_receipts WHERE state='dispatched'")).rows[0]!.sealed_payload)
    assert.equal(await dispatcher.verifyRun(identity,route,signal),'ready')
    await pending.complete(resume)
    assert.deepEqual(await dispatcher.dispatch(resume,signal),a)
    assert.equal(await dispatcher.verifyRun(identity,route,signal),'ready','Redis正常complete不取消已提交Run的恢复')
    const issuedKey=[...touched].find(key=>key.includes(':issued:'))!
    const issuedValue=await commands.sendCommand(['GET',issuedKey])
    await commands.sendCommand(['EVAL',"return redis.call('DEL',KEYS[1])",'1',issuedKey])
    assert.equal(await dispatcher.verifyRun(identity,route,signal),'cancelled','Redis丢失已签发证明时不能把旧Run误判为未取消')
    await commands.sendCommand(['EVAL',"return redis.call('SET',KEYS[1],ARGV[1],'EX',604800)",'1',issuedKey,String(issuedValue)])
    await pending.cancel(scope,now)
    assert.equal(await dispatcher.verifyRun(identity,route,signal),'cancelled')
    await assert.rejects(dispatcher.verifyRun({...identity,runId:'forged-run'},route,signal),/群延迟回复派发不可用/u)
    await assert.rejects(dispatcher.dispatch({...resume,scope:{...scope,groupId:'other-group'}},signal),/群延迟回复派发不可用/u)
    // 后续配置版本变化不能把旧ASK按新策略升级；内部收据消费后不再造Run。
    now += 1000
    const payload2 = {...payload,message_id:'native-ask-2',platform_message_id:'native-ask-2'}, event2=`${now}-1`
    await store.persistBatch(binding,[{eventId:event2,payload:payload2}],{batchId:'synthetic-batch-2',mode:'dispatch',
      async beforeDispatch(segment) {
        const r=await attention.evaluate({scope,sessionId:segment.anchors[0]!.sessionId,candidates:[{eventId:event2,payload:payload2}]},signal)
        return parseImAttentionRecord({v:1,disposition:r.disposition,mode:r.mode,configVersion:r.configVersion,subjectEventId:r.subject?.eventId??null,
          sourceAttentionKind:attentionSourceKind(r.decision?.kind),proactive:r.decision?.kind==='PROACTIVE',replyChoice:'reply'})
      },async validateAttention(){return true},async onDispatch(){assert.fail('ASK应保持pending')},
    })
    now+=60_000
    const [changed] = await pending.claimDue();assert.ok(changed)
    await pool.query('UPDATE user_bots SET group_attention_config_version=1')
    assert.deepEqual(await dispatcher.dispatch(changed,signal),{state:'consumed',runId:null})
    assert.equal(enqueued,1)
    await pool.query('UPDATE user_bots SET enabled=false')
    await assert.rejects(dispatcher.dispatch(resume,signal),/IM 权限不可用/u)
    assert.equal(enqueued,1)
  } finally {
    await commands.sendCommand(['EVAL',"for i=1,#KEYS-1 do redis.call('DEL',KEYS[i]); local id=string.match(KEYS[i],':v1:([a-f0-9]+)$'); if id then redis.call('ZREM',KEYS[#KEYS],id) end end;return 1",String(touched.size+1),...touched,index])
    await commands.close(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
  }
})
