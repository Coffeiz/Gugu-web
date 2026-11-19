import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createImVoiceCache,ImVoiceCacheError } from '../../../src/modules/im/gateway/media/cache.js'
import type { ImVoiceSelection } from '../../../src/modules/im/gateway/media/config.js'
import type { ImAttentionVoiceSource,ImVoiceRunProof } from '../../../src/modules/im/gateway/attention/voice.js'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound/envelope.js'
import { imConversationDigest,imConversationFingerprint,imConversationScopeHash } from '../../../src/modules/im/gateway/agent/identity.js'
import { imAttachmentScopeKey } from '../../../src/modules/im/gateway/inbound/attachments.js'
import { context,owner,other } from './run-sender.fixtures.js'

const pgUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('语音缓存构造和无效源错误固定，不输出秘密或连接原异常',async()=>{
  assert.throws(()=>createImVoiceCache({secretKey:'',pool:{} as Pool,voice:{} as never,transcribeSelected:async()=>null}),ImVoiceCacheError)
  const cache=createImVoiceCache({secretKey:'synthetic',pool:{} as Pool,voice:{async select(){throw Error('synthetic-private-key')}},transcribeSelected:async()=>null})
  await assert.rejects(cache.prepare([{identity:{ownerId:owner} as never} as never]),error=>error instanceof ImVoiceCacheError&&!error.message.includes('synthetic')&&!('cause'in error))
})
test('真实隔离PG：attention ASR原子收据/未知不重发/同事务Run绑定与完整消息归属',{
  skip:!pgUrl&&'未运行：需显式隔离PG随机schema验证持久CAS/事务；无PG不以query替身冒充',
},async t=>{
  const{Pool}=await import('pg'),admin=new Pool({connectionString:pgUrl}),schema=`im_voice_cache_${randomUUID().replaceAll('-','')}`
  let pool:Pool|undefined
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:pgUrl,options:`-c search_path=${schema} -c lock_timeout=2000`,max:8})
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,run_id text,role text,chat_type text,platform_user_id text,conversation_seq integer,im_platform_message_id text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id varchar(128),chat_type text,scope_hash text,event_hash text,fingerprint text,sealed_payload jsonb);
      CREATE TABLE chat_attachments(attach_id text,user_id uuid,message_id integer,state text,platform text,extra jsonb)`)
    await pool.query(imGatewaySql.voiceCache)
    await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
    const db=pool,c=context(),payload={...c.payload,attachments:['voice-a'],_node_stream_event_id:'1791000000000-1'}
    const scopeHash=imConversationScopeHash(c.secretKey,{ownerId:owner,platform:c.scope.platform,botId:c.scope.botId},payload)
    const eventHash=imConversationDigest(c.secretKey,[scopeHash,payload.platform_user_id,payload.message_id])
    const fingerprint=imConversationFingerprint(c.secretKey,scopeHash,payload,['voice-a'])
    const sealed=createImInboundEnvelope(c.secretKey).seal({ownerId:owner,platform:c.scope.platform,botId:c.scope.botId},payload)
    await db.query("INSERT INTO conversation_sessions VALUES(91,$1,'web',NULL,NULL,NULL)",[owner])
    await db.query("INSERT INTO conversation_messages VALUES(11,91,NULL,'user','c2c','202',3,'31')")
    await db.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,11,NULL,'started','telegram','91','c2c',$2,$3,$4,$5)",[owner,scopeHash,eventHash,fingerprint,sealed])
    await db.query("INSERT INTO chat_attachments VALUES('voice-a',$1,11,'attached','telegram',$2)",[owner,JSON.stringify({im_ingress_scope:imAttachmentScopeKey(c.scope)})])
    let authorized=true,version='a'.repeat(64),calls=0,answer:string|null='合成语音正文',request:(source:ImAttentionVoiceSource)=>Promise<string|null>=async()=>answer
    const selected=():ImVoiceSelection=>({ownerId:owner,version,configured:true,config:{model:'synthetic-asr'},profile:{configured:true,maxFileBytes:1024,maxDurationSeconds:null,providerLabel:'合成',resolved:true},usage:{provider:'openai',model:'synthetic-asr',isByok:false,credentialId:null},async authorizeCurrent(){return authorized}})
    const voice={async select(){return selected()}}
    const cache=createImVoiceCache({pool:db,secretKey:c.secretKey,voice,async transcribeSelected(source,selection,signal){
      calls++;await source.assertCurrent(signal);assert.equal(selection.ownerId,source.identity.ownerId);return request(source)
    }})
    const source:ImAttentionVoiceSource={identity:{ownerId:owner,platform:'telegram',botId:'91',sessionId:'91',messageId:'11',attachId:'voice-a',scopeHash,eventHash,eventId:'1791000000000-1'},
      input:{bytes:new Uint8Array([1,2,3]),mime:'audio/wav',ext:'wav',duration:1,attachId:'voice-a'},mayRequest:true,async assertCurrent(signal){signal.throwIfAborted();if(!authorized)throw Error('synthetic-private-revocation')}}
    const proof:ImVoiceRunProof={...c,payload,messageIds:['11'],authorize:async()=>authorized}
    const reset=async()=>{await db.query('DELETE FROM gugu_im_voice_run_bindings');await db.query('DELETE FROM gugu_im_voice_cache');calls=0;authorized=true;version='a'.repeat(64);answer='合成语音正文';request=async()=>answer}
    const dispatch=async()=>{await db.query('UPDATE conversation_messages SET run_id=$1',[c.identity.runId]);await db.query("UPDATE gugu_im_inbound_receipts SET run_id=$1,state='dispatched'",[c.identity.runId])}
    const bind=async(p=proof)=>{const client=await db.connect();try{await client.query('BEGIN');await cache.bindRunLocked(client,p);await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
    await t.test('首次真实请求前requesting已提交，重放/重启复用密文结果，DB不含正文或原生消息ID',async()=>{
      request=async()=>{const state=(await db.query('SELECT state FROM gugu_im_voice_cache')).rows[0].state;assert.equal(state,'requesting');return answer}
      assert.deepEqual(await cache.prepare([source]),[{eventId:source.identity.eventId,attachId:'voice-a',text:answer}]);assert.equal(calls,1)
      const raw=JSON.stringify((await db.query('SELECT * FROM gugu_im_voice_cache')).rows)
      assert.equal(raw.includes(answer!),false);assert.equal(raw.includes(source.identity.eventId),false)
      assert.deepEqual(await cache.prepare([{...source,mayRequest:false}]),[{eventId:source.identity.eventId,attachId:'voice-a',text:answer}]);assert.equal(calls,1)
      await dispatch();await bind()
      const restarted=createImVoiceCache({pool:db,secretKey:c.secretKey,voice,async transcribeSelected(){assert.fail('恢复不得重新请求')}})
      assert.deepEqual(await restarted.readForRun(proof,source.input,selected()),{text:answer})
    })
    await t.test('passive没有缓存只读，无HTTP/无写；未绑定缓存不得回落正常ASR',async()=>{
      await reset();assert.equal((await cache.prepare([{...source,mayRequest:false}]))[0]!.text,null);assert.equal(calls,0)
      assert.equal((await db.query('SELECT count(*)::int AS n FROM gugu_im_voice_cache')).rows[0].n,0)
      assert.equal(await cache.readForRun(proof,source.input,selected()),null)
      await cache.prepare([source]);await assert.rejects(cache.readForRun(proof,source.input,selected()),e=>e instanceof ImVoiceCacheError&&e.code==='unauthorized')
    })
    await t.test('并发同一源只一个请求，requesting中断/unknown及升级密钥都不再次发送',async()=>{
      await reset();let release!:(v:string)=>void,entered!:()=>void
      const enteredPromise=new Promise<void>(resolve=>entered=resolve),gate=new Promise<string>(resolve=>release=resolve)
      request=async()=>{entered();return gate}
      const first=cache.prepare([source]);await enteredPromise
      await assert.rejects(cache.prepare([source]),e=>e instanceof ImVoiceCacheError&&e.code==='uncertain');assert.equal(calls,1)
      release('并发合成结果');await first
      version='b'.repeat(64);await assert.rejects(cache.prepare([source]),e=>e instanceof ImVoiceCacheError&&e.code==='mismatch');assert.equal(calls,1)
      await db.query("UPDATE gugu_im_voice_cache SET state='requesting'");version='a'.repeat(64)
      await assert.rejects(cache.prepare([source]),e=>e instanceof ImVoiceCacheError&&e.code==='uncertain');assert.equal(calls,1)
      await db.query("UPDATE gugu_im_voice_cache SET state='unknown'");await bind()
      await assert.rejects(cache.readForRun(proof,source.input,selected()),e=>e instanceof ImVoiceCacheError&&e.code==='uncertain');assert.equal(calls,1)
    })
    await t.test('来源独立连接锁锚点与派发先锚点后缓存并发时不反转锁序，所有复核都在缓存事务外',async()=>{
      await reset();let checks=0
      const lockingSource:ImAttentionVoiceSource={...source,async assertCurrent(signal){
        signal.throwIfAborted();checks++
        const dispatcher=await db.connect(),reader=await db.connect()
        let reading:Promise<unknown>|undefined
        try{
          await dispatcher.query('BEGIN');await dispatcher.query('SELECT id FROM conversation_messages WHERE id=11 FOR UPDATE')
          await reader.query('BEGIN')
          // 来源读取在独立连接等待原消息；派发事务必须能继续取缓存锁并提交。
          reading=reader.query('SELECT id FROM conversation_messages WHERE id=11 FOR SHARE')
          await dispatcher.query('SELECT source_key FROM gugu_im_voice_cache FOR UPDATE')
          await dispatcher.query('COMMIT');await reading;await reader.query('COMMIT')
        }finally{
          await dispatcher.query('ROLLBACK');await reading?.catch(()=>{});await reader.query('ROLLBACK');dispatcher.release();reader.release()
        }
      }}
      assert.equal((await cache.prepare([lockingSource]))[0]!.text,answer)
      assert.equal(calls,1);assert.equal(checks>=4,true,'含请求前后和最终提交后的真实源复核')
      assert.equal((await db.query('SELECT state FROM gugu_im_voice_cache')).rows[0].state,'completed')
    })
    await t.test('Buffer输入冻结为独立字节，不让调用方await期间修改影响实际ASR或缓存摘要',async()=>{
      await reset();const original=Buffer.from([1,2,3])
      request=async value=>{assert.deepEqual([...value.input.bytes],[1,2,3]);return answer}
      const buffered={...source,input:{...source.input,bytes:original},async assertCurrent(){original.fill(9)}}
      await cache.prepare([buffered]);assert.deepEqual([...original],[9,9,9]);assert.equal(calls,1)
      await bind();assert.deepEqual(await cache.readForRun(proof,source.input,selected()),{text:answer})
    })
    await t.test('明确空结果复用空串，未配置保留null收据且Run明确不可用，不伪造字幕',async()=>{
      await reset();answer='';await cache.prepare([source]);await bind();assert.deepEqual(await cache.readForRun(proof,source.input,selected()),{text:''});assert.equal(calls,1)
      await reset();answer=null;assert.equal((await cache.prepare([source]))[0]!.text,null);await bind()
      await assert.rejects(cache.readForRun(proof,source.input,selected()),e=>e instanceof ImVoiceCacheError&&e.code==='unavailable');assert.equal(calls,1)
      assert.equal((await cache.prepare([source]))[0]!.text,null);assert.equal(calls,1)
    })
    await t.test('网络异常、取消、请求后撤权和最终提交失败均保留不可重发状态且错误脱敏',async()=>{
      for(const mode of ['network','abort','revoke','commit'] as const){
        await reset();const controller=new AbortController()
        request=async()=>{if(mode==='network')throw Error('synthetic-private-provider-body');if(mode==='abort')controller.abort();if(mode==='revoke')authorized=false;return answer}
        if(mode==='commit')await db.query("CREATE FUNCTION reject_voice_result() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='completed' THEN RAISE EXCEPTION 'synthetic-private-transcript';END IF;RETURN NEW;END$$;CREATE TRIGGER reject_voice_result BEFORE UPDATE ON gugu_im_voice_cache FOR EACH ROW EXECUTE FUNCTION reject_voice_result()")
        await assert.rejects(cache.prepare([source],controller.signal),e=>e instanceof ImVoiceCacheError&&e.code==='uncertain'&&!e.message.includes('synthetic')&&!('cause'in e))
        if(mode==='commit')await db.query('DROP TRIGGER reject_voice_result ON gugu_im_voice_cache;DROP FUNCTION reject_voice_result()')
        assert.equal((await db.query('SELECT state FROM gugu_im_voice_cache')).rows[0].state,'unknown');authorized=true
        await assert.rejects(cache.prepare([source]),ImVoiceCacheError);assert.equal(calls,1)
      }
    })
    await t.test('prepared尚未发HTTP可以重新认领，字节变化和同附件错置事件不能借新选择重发',async()=>{
      // 专用合成夹具模拟reserve后、requesting前崩溃；生产绝不能把未知结果降为prepared。
      await reset();await cache.prepare([source]);await db.query("UPDATE gugu_im_voice_cache SET state='prepared',nonce=NULL,sealed_result=NULL")
      calls=0;version='b'.repeat(64);await cache.prepare([source]);assert.equal(calls,1)
      await assert.rejects(cache.prepare([{...source,input:{...source.input,bytes:new Uint8Array([9])}}]),ImVoiceCacheError)
      await assert.rejects(cache.prepare([{...source,identity:{...source.identity,eventHash:'f'.repeat(64)}}]),ImVoiceCacheError);assert.equal(calls,1)
    })
    await t.test('Run绑定必须同事务已dispatched、回滚不留binding；跨Run/speaker/Bot/owner/附件拒绝',async()=>{
      await reset();await cache.prepare([source])
      await db.query("UPDATE gugu_im_inbound_receipts SET state='started',run_id=NULL");await assert.rejects(bind(),ImVoiceCacheError)
      await dispatch()
      const client=await db.connect();try{await client.query('BEGIN');await cache.bindRunLocked(client,proof);await client.query('ROLLBACK')}finally{client.release()}
      await assert.rejects(cache.readForRun(proof,source.input,selected()),ImVoiceCacheError)
      await bind();assert.deepEqual(await cache.readForRun(proof,source.input,selected()),{text:answer})
      for(const p of [{...proof,identity:{...proof.identity,runId:'other-run'}},
        {...proof,scope:{...proof.scope,platformUserId:'303'},actor:{...proof.actor,platformUserId:'303'},payload:{...payload,platform_user_id:'303'}},
        {...proof,scope:{...proof.scope,botId:'92'},actor:{...proof.actor,botId:'92'},payload:{...payload,bot_id:'92'}},
        {...proof,identity:{...proof.identity,ownerId:other}}])await assert.rejects(cache.readForRun(p,source.input,selected()),ImVoiceCacheError)
      await db.query("UPDATE chat_attachments SET state='released'");await assert.rejects(cache.readForRun(proof,source.input,selected()),ImVoiceCacheError)
      await db.query("UPDATE chat_attachments SET state='attached'");await db.query("UPDATE gugu_im_inbound_receipts SET fingerprint='tampered'")
      await assert.rejects(cache.readForRun(proof,source.input,selected()),ImVoiceCacheError);assert.equal(calls,1)
      await db.query('UPDATE gugu_im_inbound_receipts SET fingerprint=$1',[fingerprint])
    })
    await t.test('密文跨源/损坏不可读取，当前权限撤销与固定选择owner不符不访问Provider',async()=>{
      await reset();await cache.prepare([source]);await bind()
      const row=(await db.query('SELECT sealed_result FROM gugu_im_voice_cache')).rows[0]
      await db.query("UPDATE gugu_im_voice_cache SET sealed_result=decode('0011','hex')")
      await assert.rejects(cache.readForRun(proof,source.input,selected()),ImVoiceCacheError)
      await db.query('UPDATE gugu_im_voice_cache SET sealed_result=$1',[row.sealed_result]);authorized=false
      await assert.rejects(cache.readForRun(proof,source.input,selected()),ImVoiceCacheError);authorized=true
      await assert.rejects(cache.readForRun(proof,source.input,{...selected(),ownerId:other}),ImVoiceCacheError);assert.equal(calls,1)
    })
  }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
})
