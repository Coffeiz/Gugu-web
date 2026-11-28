import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { AttentionMessage } from '@gugu/core/im/attention/types'
import { createImAcceptedEvidenceCodec, createPostgresImAcceptedFactsReader, type ImDeliveryLedgerContext } from '../../../../src/modules/im/gateway/attention/ledger.js'
import { withPostgresImDeliveryStore } from '../../../../src/modules/im/gateway/delivery/store.js'

const ownerId = '00000000-0000-4000-8000-000000000011'
const identity = {ownerId,sessionId:'21',runId:'synthetic-run'}
const secretKey = 'synthetic-attention-ledger-key'
const context: ImDeliveryLedgerContext = {scope:{ownerId,botId:'1',platform:'telegram',chatType:'group',chatId:'-12345'},recipientSenderId:'speaker',sourceAttentionKind:'DIRECT'}
const hash = (text:string) => createHash('sha256').update(text).digest('hex')
const evidence = (text = '可见安全正文',id = '321') => ({v:1,scope:{...context.scope},recipient:'-12345',kind:'text',platformMessageIds:[id],sourceMessageIds:['123'],
  sourceEventIds:['1791000000000-1'],coverage:{nativeMessageIds:true,sourceEventIds:true},text,contentHash:hash(text)})
const fact = (sequence:number,final = false) => ({eventType:final ? 'final' as const : 'round_end' as const,sequence,final})
const message = (time:number,senderId='speaker',reply:string|null=null): AttentionMessage => ({eventId:'1791000000001-1',platform:'telegram',botId:'1',groupId:'-12345',
  platformMessageId:'1000',senderId,eventReceivedMs:time,platformSentMs:time,rawText:'合成问题',text:'合成问题',replyToPlatformMessageId:reply,
  replyToSenderId:null,replyTargetIsBot:reply ? true : null,hasAttachments:false,botMentioned:false} as unknown as AttentionMessage)

test('送达证据按完整scope/Run/key/attempt认证加密，改址/密文篡改和不完整协议形状拒绝', () => {
  const codec = createImAcceptedEvidenceCodec(secretKey,context), attempt = randomUUID()
  const sealed = codec.seal(identity,'round:1:text',attempt,evidence())
  assert.equal(sealed.payload.includes(Buffer.from('可见安全正文')),false)
  assert.equal(sealed.payload.includes(Buffer.from('1791000000000-1')),false)
  assert.deepEqual(codec.open(identity,'round:1:text',attempt,sealed.nonce,sealed.payload).evidence,evidence())
  for (const changed of [{...identity,runId:'other'},{...identity,sessionId:'22'},{...identity,ownerId:randomUUID()}])
    assert.throws(() => codec.open(changed,'round:1:text',attempt,sealed.nonce,sealed.payload),/IM 送达事实不可用/u)
  const tampered = Buffer.from(sealed.payload); tampered[0] = tampered[0]! ^ 1
  assert.throws(() => codec.open(identity,'round:1:text',attempt,sealed.nonce,tampered))
  const other = createImAcceptedEvidenceCodec(secretKey,{...context,scope:{...context.scope,botId:'2'}})
  assert.throws(() => other.open(identity,'round:1:text',attempt,sealed.nonce,sealed.payload))
  for (const value of [{...evidence(),recipient:'other-group'},{...evidence(),contentHash:'a'.repeat(64)},
    {...evidence(),sourceEventIds:['not-stream-id']},{...evidence(),scope:{...context.scope,context_token:'合成不可存字段'}},
    {...evidence(),platformMessageIds:[],coverage:{nativeMessageIds:true,sourceEventIds:true}}])
    assert.throws(() => codec.seal(identity,'round:1:text',attempt,value),/IM 送达事实不可用/u)
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG：accepted和密文事实同SQL原子；插入故障保留pending，确认final不重发且精确scope/时钟/撤权', {
  skip: !pgUrl && '未运行：需显式 GUGU_IM_GATEWAY_TEST_DATABASE_URL，隔离schema验证真实PG原子性',
},async () => {
  const {Pool} = await import('pg'), admin = new Pool({connectionString:pgUrl})
  const schema = `im_accepted_${randomUUID().replaceAll('-','')}`
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({connectionString:pgUrl,options:`-c search_path=${schema}`})
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),platform text,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),source text,bot_id varchar(128),chat_type text,chat_id text)`)
    await pool.query(`INSERT INTO users VALUES($1,true,'active');`,[ownerId])
    await pool.query(`INSERT INTO user_bots VALUES(1,$1,'telegram',true,true,NULL),(2,$1,'telegram',true,true,NULL)`,[ownerId])
    await pool.query(`INSERT INTO conversation_sessions VALUES(21,$1,'telegram','1','group','-12345'),(22,$1,'telegram','2','group','-12345')`,[ownerId])
    for (const file of ['delivery','attentionLedger'] as const) await pool.query(imGatewaySql[file])
    const db = pool, options = {secretKey,ledger:context}, scope = {ownerId,botId:'1',platform:'telegram' as const,groupId:'-12345'}
    await db.query(`CREATE FUNCTION reject_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-body'; END $$;
      CREATE TRIGGER reject_fact BEFORE INSERT ON gugu_im_accepted_delivery_facts FOR EACH ROW EXECUTE FUNCTION reject_fact()`)
    await assert.rejects(withPostgresImDeliveryStore(db,identity,async receipts => {
      await receipts.begin(identity,'failed-commit',hash('failure'))
      await receipts.settle(identity,'failed-commit','accepted',evidence(),fact(1,true))
    },options),error => error instanceof Error && !error.message.includes('synthetic-private-body'))
    assert.equal((await db.query(`SELECT state FROM gugu_im_delivery_receipts WHERE delivery_key='failed-commit'`)).rows[0].state,'pending')
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM gugu_im_accepted_delivery_facts')).rows[0].n,0)
    await db.query('DROP TRIGGER reject_fact ON gugu_im_accepted_delivery_facts')
    await withPostgresImDeliveryStore(db,identity,async receipts => assert.equal(await receipts.begin(identity,'failed-commit',hash('failure')),'pending'),options)
    const reader = createPostgresImAcceptedFactsReader({pool:db,secretKey})
    const boundaryTime=Date.now()+1000
    await assert.rejects(reader.read(scope,boundaryTime,[message(boundaryTime)],new AbortController().signal))
    // 仅结束本隔离fixture的合成故障场景；生产pending/unknown绝不能这样推断为未发送。
    await db.query("UPDATE gugu_im_delivery_receipts SET state='rejected' WHERE delivery_key='failed-commit'")
    assert.deepEqual(await reader.read(scope,boundaryTime,[message(boundaryTime)],new AbortController().signal),[])
    await withPostgresImDeliveryStore(db,identity,async receipts=>{
      await receipts.begin(identity,'unknown-result',hash('unknown'))
      await receipts.settle(identity,'unknown-result','unknown')
    },options)
    await assert.rejects(reader.read(scope,boundaryTime,[message(boundaryTime)],new AbortController().signal))
    assert.deepEqual(await reader.read({...scope,botId:'2'},boundaryTime,[message(boundaryTime)],new AbortController().signal),[])
    // 同上，清除已完成断言的纯合成未知情景，后续正常final独立验收。
    await db.query("UPDATE gugu_im_delivery_receipts SET state='rejected' WHERE delivery_key='unknown-result'")
    await withPostgresImDeliveryStore(db,identity,async receipts => {
      await receipts.begin(identity,'round:1:text',hash('body'))
      await receipts.settle(identity,'round:1:text','accepted',evidence(),fact(1))
    },options)
    const before = Number((await db.query(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS t`)).rows[0].t)
    assert.deepEqual(await reader.read(scope,before,[message(before)],new AbortController().signal),[])
    await withPostgresImDeliveryStore(db,identity,async receipts => {
      assert.equal(await receipts.begin(identity,'round:1:text',hash('body')),'accepted')
      await receipts.confirmFinal!(identity,'round:1:text',hash('body'),fact(2,true))
      await receipts.confirmFinal!(identity,'round:1:text',hash('body'),fact(2,true))
      await assert.rejects(receipts.confirmFinal!(identity,'round:1:text',hash('wrong'),fact(2,true)))
    },options)
    const now = Number((await db.query(`SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS t`)).rows[0].t)
    const replies = await reader.read(scope,now,[message(now,'speaker','321')],new AbortController().signal)
    assert.equal(replies.length,1); assert.equal(replies[0]!.platformMessageId,'321'); assert.equal(replies[0]!.finalText,'可见安全正文')
    assert.deepEqual(await reader.read(scope,before,[message(before)],new AbortController().signal),[])
    assert.deepEqual(await reader.read({...scope,botId:'2'},now,[message(now)],new AbortController().signal),[])
    await db.query('UPDATE user_bots SET group_chat_enabled=false WHERE id=1')
    await assert.rejects(reader.read(scope,now,[message(now)],new AbortController().signal))
    await db.query('UPDATE user_bots SET group_chat_enabled=true WHERE id=1')
    // 最新32条之外的本人激活，以及批内较晚候选之前新发生的激活，都需保留。
    const base=now-100000
    for(let index=0;index<38;index++){
      const key=`round:member-${index}:text`,native=`member-${index}`
      const recipient=index===0?'older-member':index===36?'later-member':index===37?'future-member':'other-member'
      await withPostgresImDeliveryStore(db,identity,async receipts=>{
        await receipts.begin(identity,key,hash(key)); await receipts.settle(identity,key,'accepted',evidence('合成激活',native),fact(10+index,true))
      },{secretKey,ledger:{...context,recipientSenderId:recipient,sourceAttentionKind:'member_CONTINUE'}})
      const delta=index===36?200:index===37?600:index+1
      await db.query(`UPDATE gugu_im_accepted_delivery_facts SET accepted_at=to_timestamp($2::numeric/1000),final_confirmed_at=to_timestamp($2::numeric/1000) WHERE delivery_key=$1`,[key,base+delta])
    }
    const multi=await reader.read(scope,base+100,[message(base+100,'older-member'),message(base+500,'later-member')],new AbortController().signal)
    assert.ok(multi.some(f=>f.platformMessageId==='member-0'))
    assert.ok(multi.some(f=>f.platformMessageId==='member-36'))
    assert.equal(multi.some(f=>f.platformMessageId==='member-37'),false)
    // 不接受另一owner/Bot/群的密文拼接，也不把投递body哈希错配当安全正文。
    const row=(await db.query(`SELECT nonce,payload FROM gugu_im_accepted_delivery_facts WHERE delivery_key='round:1:text'`)).rows[0]
    await db.query(`UPDATE gugu_im_accepted_delivery_facts SET payload=set_byte(payload,0,get_byte(payload,0)#1) WHERE delivery_key='round:1:text'`)
    await assert.rejects(reader.read(scope,now+1000,[message(now+1000)],new AbortController().signal))
    await db.query(`UPDATE gugu_im_accepted_delivery_facts SET nonce=$1,payload=$2 WHERE delivery_key='round:1:text'`,[row.nonce,row.payload])
    // 无证据的真实final不能冒充覆盖完整；已有accepted不得补造平台回执。
    await withPostgresImDeliveryStore(db,identity,async receipts => {
      await receipts.begin(identity,'round:2:text',hash('legacy'))
      await receipts.settle(identity,'round:2:text','accepted',undefined,fact(3,true))
    },options)
    const afterLastWrite = Number((await db.query(`SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS t`)).rows[0].t)
    await assert.rejects(reader.read(scope,afterLastWrite,[message(afterLastWrite)],new AbortController().signal))
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
  }
})
