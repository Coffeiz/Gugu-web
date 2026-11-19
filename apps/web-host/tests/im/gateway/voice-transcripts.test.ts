import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool,PoolClient } from 'pg'
import { imActorInputFromPayload,resolveImActor } from '@gugu/core/im/access'
import { createImVoiceTranscriptStore,ImVoiceTranscriptError } from '../../../src/modules/im/gateway/voice-transcripts.js'
import { createImVoiceRuntime } from '../../../src/modules/im/gateway/voice-runtime.js'
import { createImVoiceSelection } from '../../../src/modules/im/gateway/voice-config.js'
import { context,receipt,owner,other } from './run-sender.fixtures.js'

test('转写目标必须属于冻结messageIds且状态/类型有效，不借卡片中的引用ID扩权',async()=>{
  const c=context(),pool={async connect(){assert.fail('无效目标不应借数据库连接')},async query(){assert.fail('无效目标不应查数据库')}} as unknown as Pool
  const store=createImVoiceTranscriptStore({...c,pool,messageIds:['11'],authorize:async()=>true})
  for(const id of ['12','0','-1','11 OR 1=1'])await assert.rejects(store.save(id,'合成字幕','completed'),ImVoiceTranscriptError)
  await assert.rejects(store.save('11','合成字幕','invalid' as never),ImVoiceTranscriptError)
})
const pgUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG：首个非quoted语音消息级聚合、幂等/状态清理与原files保持，真实scope/密文/撤权失败回滚',{
  skip:!pgUrl&&'未运行：显式隔离PG随机schema验证真实事务；query替身不能证明持久化',
},async t=>{
  const{Pool}=await import('pg'),admin=new Pool({connectionString:pgUrl}),schema=`im_transcript_${randomUUID().replaceAll('-','')}`
  let pool:Pool|undefined
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:pgUrl,options:`-c search_path=${schema} -c lock_timeout=2000`,max:5})
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,run_id text,role text,chat_type text,platform_user_id text,conversation_seq integer,im_platform_message_id text,files json);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id varchar(128),chat_type text,scope_hash text,event_hash text,fingerprint text,sealed_payload jsonb)`)
    await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
    const db=pool,c=context(),proof=receipt(c)
    await db.query("INSERT INTO conversation_sessions VALUES(91,$1,'web',NULL,NULL,NULL),(92,$2,'telegram','91','group','other-group')",[owner,other])
    const original=[{kind:'voice',quoted:true,attach_id:'quoted-voice',transcript:'引用卡片保持原样'},
      {kind:'file',name:'合成附件',extra:{preserve:true}},
      {kind:'voice',quoted:[],attach_id:'voice-main',duration:2,extra:{preserve:['nested',1]},transcript:'旧字幕',transcript_status:'failed'},
      {kind:'voice',attach_id:'voice-second',transcript:'第二声源卡片不单独写入'},'legacy-card',null]
    await db.query("INSERT INTO conversation_messages VALUES(11,91,$1,'user','c2c','202',3,'31',$2::json)",[c.identity.runId,JSON.stringify(original)])
    await db.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,11,$2,'dispatched','telegram','91','c2c',$3,$4,$5,$6)",[owner,c.identity.runId,proof.scope_hash,proof.event_hash,proof.fingerprint,proof.sealed_payload])
    let allowed=true
    const opts={...c,pool:db,messageIds:['11'],authorize:async()=>allowed},store=createImVoiceTranscriptStore(opts)
    const saved=async()=>(await db.query('SELECT files FROM conversation_messages WHERE id=11')).rows[0].files
    const reset=async(files:unknown=original)=>db.query('UPDATE conversation_messages SET files=$1::json WHERE id=11',[JSON.stringify(files)])
    await t.test('两声源转写聚合只写首个本消息voice；引用/第二卡/其他结构不变且重复保存幂等',async()=>{
      const transcript='第一声源合成字幕\n第二声源合成字幕'
      const files=await store.save('11',` \u3000${transcript}\t `,'completed');assert.ok(files)
      const expected=structuredClone(original)
      Object.assign(expected[2]!,{transcript,transcript_status:'completed',transcript_scope:'message'})
      assert.deepEqual(files,expected);assert.deepEqual(await saved(),expected)
      assert.deepEqual(await store.save('11',transcript,'completed'),expected);assert.deepEqual(await saved(),expected)
      await store.save('11','\u001c合成字幕\u0085','completed');assert.equal((await saved())[2].transcript,'合成字幕')
      await store.save('11','\ufeff字幕\ufeff','completed');assert.equal((await saved())[2].transcript,'\ufeff字幕\ufeff')
      for(const status of ['empty','failed','completed'] as const){await store.save('11',status==='completed'?' \t\r\n\u3000 ':'应移除的字幕',status)
        const value=await saved();assert.equal(value[2].transcript,undefined);assert.equal(value[2].transcript_status,status);assert.equal(value[2].transcript_scope,'message')
        assert.deepEqual(value[0],original[0]);assert.deepEqual(value[3],original[3])}
    })
    await t.test('实际Core ASR附加字幕→真实PG保存三状态，引用卡片/入站密封事实始终保持',async()=>{
      const voice=createImVoiceSelection({pool:db,environment:{BYOK__ENABLED:'false'},authorize:async()=>allowed,
        document:()=>({voice_presets:{active_id:'voice',items:[{id:'voice',name:'合成字幕识别',provider:'qwen',model:'synthetic-asr',api_format:'openai',
          api_key:'synthetic-asr-only',base_url:'https://asr.example.test/v1'}]}})})
      for(const mode of ['completed','empty','failed']as const){
        await reset();let requests=0
        const runtime=createImVoiceRuntime({ownerId:owner,voice,mainConfig:{provider:'openai',model:'synthetic-native',capability_overrides:{audio:true}},
          authorize:async()=>allowed,diagnose(){},provider:{transport:{async request(request){
            requests++;assert.equal(request.headers.Authorization,'Bearer synthetic-asr-only')
            return{status:mode==='failed'?401:200,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify(mode==='failed'?{error:'synthetic-private'}
              :{choices:[{message:{content:mode==='empty'?'':'合成原生字幕'}}]}))})(),cancel(){}}
          }}}})
        const input={bytes:Buffer.from('synthetic-wav'),mime:'audio/wav',ext:'wav',duration:1,attachId:'voice-main'}
        const native=await runtime.nativeAudio(input),subtitle=await runtime.transcribeNative(input)
        assert.equal(native?.type,'input_audio');assert.ok(subtitle)
        await store.save('11',subtitle.text,subtitle.status)
        const files=await saved();assert.equal(files[2].transcript_status,mode)
        assert.equal(files[2].transcript,mode==='completed'?'合成原生字幕':undefined)
        assert.deepEqual(files[0],original[0]);assert.deepEqual(files[3],original[3]);assert.equal(requests,1)
        assert.deepEqual((await db.query('SELECT sealed_payload FROM gugu_im_inbound_receipts WHERE message_id=11')).rows[0].sealed_payload,proof.sealed_payload)
      }
      await reset()
    })
    await t.test('无本消息voice或files非列表返回null并保持存储原样',async()=>{
      for(const files of [null,{legacy:'原对象'},[{kind:'voice',quoted:true,transcript:'引用不改'}]]){
        await reset(files);assert.equal(await store.save('11','不应写入','completed'),null);assert.deepEqual(await saved(),files)}
      await reset()
    })
    await t.test('Run/Bot/私聊speaker和跨群scope不符、同scope密文错置全部拒绝不更改卡片',async()=>{
      const before=await saved()
      const variants=[{identity:{...c.identity,runId:'other-run'}},
        {identity:{...c.identity,ownerId:other},scope:{...c.scope,ownerId:other},actor:{...c.actor,ownerId:other},payload:{...c.payload,owner_user_id:other}},
        {scope:{...c.scope,platformUserId:'303'},actor:{...c.actor,platformUserId:'303'},payload:{...c.payload,platform_user_id:'303'}},
        {scope:{...c.scope,botId:'92'},actor:{...c.actor,botId:'92'},payload:{...c.payload,bot_id:'92',channel_id:'92'}},
        {scope:{...c.scope,chatType:'group' as const,chatId:'other-group'},actor:{...c.actor,chatType:'group' as const,chatId:'other-group'},payload:{...c.payload,chat_type:'group',chat_id:'other-group'}}]
      for(const patch of variants){const invalid=createImVoiceTranscriptStore({...opts,...patch});await assert.rejects(invalid.save('11','不能写入','completed'),ImVoiceTranscriptError);assert.deepEqual(await saved(),before)}
      const swapped=context();swapped.payload.message_id='99';swapped.payload.platform_message_id='99';swapped.payload.text='同scope其他事件'
      await db.query('UPDATE gugu_im_inbound_receipts SET sealed_payload=$1',[receipt(swapped).sealed_payload])
      await assert.rejects(store.save('11','不能写入','completed'),ImVoiceTranscriptError);assert.deepEqual(await saved(),before)
      await db.query('UPDATE gugu_im_inbound_receipts SET sealed_payload=$1',[proof.sealed_payload])
    })
    await t.test('混合群批次可保存非末条speaker语音，但任一其他锚点收据失效则全批拒绝',async()=>{
      const groupScope={...c.scope,chatType:'group' as const,chatId:'synthetic-group',platformUserId:'303'},identity={...c.identity,sessionId:'93',runId:'synthetic-group-run'}
      const first={...c.payload,chat_type:'group' as const,chat_id:'synthetic-group',platform_user_id:'202',message_id:'41',platform_message_id:'41',text:'合成owner语音'}
      const last={...first,platform_user_id:'303',message_id:'42',platform_message_id:'42',text:'合成member语音'}
      const payload={...last,_batch_messages:[first,last]}
      const actor=resolveImActor(imActorInputFromPayload({ownerId:owner,platform:'telegram',botId:'91'},payload),input=>({role:input.platformUserId==='202'?'owner':'member',allowedToolNames:input.platformUserId==='202'?null:['read_file']}))
      assert.equal(actor.role,'member')
      await db.query("INSERT INTO conversation_sessions VALUES(93,$1,'telegram','91','group','synthetic-group')",[owner])
      for(const[id,fact]of[[21,first],[22,last]]as const){const sealed=receipt({...c,identity,scope:{...groupScope,platformUserId:fact.platform_user_id},payload:fact})
        await db.query("INSERT INTO conversation_messages VALUES($1,93,$2,'user','group',$3,$4,$5,$6::json)",[id,identity.runId,fact.platform_user_id,id,fact.message_id,JSON.stringify([{kind:'voice',attach_id:`synthetic-${id}`}])])
        await db.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,93,$2,$3,'dispatched','telegram','91','group',$4,$5,$6,$7)",[owner,id,identity.runId,sealed.scope_hash,sealed.event_hash,sealed.fingerprint,sealed.sealed_payload])}
      const group=createImVoiceTranscriptStore({...opts,identity,scope:groupScope,actor,payload,messageIds:['21','22']})
      const files=await group.save('21','首speaker字幕','completed');assert.equal((files![0]as Record<string,unknown>).transcript,'首speaker字幕')
      assert.deepEqual((await db.query('SELECT files FROM conversation_messages WHERE id=22')).rows[0].files,[{kind:'voice',attach_id:'synthetic-22'}])
      await db.query("UPDATE gugu_im_inbound_receipts SET fingerprint=$1 WHERE message_id=22",['0'.repeat(64)])
      await assert.rejects(group.save('21','不能覆盖首speaker字幕','completed'),ImVoiceTranscriptError)
      assert.deepEqual((await db.query('SELECT files FROM conversation_messages WHERE id=21')).rows[0].files,files)
    })
    await t.test('写后撤权在同一真实PG事务回滚，SQL失败静态脱敏且不吞错',async()=>{
      const before=await saved()
      // 只注入撤权时机；所有query/BEGIN/COMMIT/ROLLBACK仍实际执行于此随机schema。
      const wrapped={query:db.query.bind(db),async connect(){const client=await db.connect();return new Proxy(client,{get(target,key){
        if(key==='query')return async(...args:unknown[])=>{const result=await(target.query as (...a:unknown[])=>Promise<unknown>).apply(target,args)
          if(typeof args[0]==='string'&&args[0].includes('UPDATE conversation_messages SET files='))allowed=false
          return result}
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}}) as PoolClient}} as Pick<Pool,'query'|'connect'>
      await assert.rejects(createImVoiceTranscriptStore({...opts,pool:wrapped}).save('11','会回滚的字幕','completed'),ImVoiceTranscriptError)
      assert.deepEqual(await saved(),before);allowed=true
      await db.query("CREATE FUNCTION reject_transcript() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic-private-transcript';END$$;CREATE TRIGGER reject_transcript BEFORE UPDATE ON conversation_messages FOR EACH ROW EXECUTE FUNCTION reject_transcript()")
      await assert.rejects(store.save('11','不应提交','completed'),error=>error instanceof ImVoiceTranscriptError&&!error.message.includes('synthetic-private')&&!('cause'in error))
      assert.deepEqual(await saved(),before);await db.query('DROP TRIGGER reject_transcript ON conversation_messages')
    })
  }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
})
