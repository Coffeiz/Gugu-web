import { encryptByokEnvelope } from '../../../src/modules/byok/crypto.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { transcribeCompatibleAsr } from '@gugu/core/providers'
import { createImVoiceSelection,resolveImVoiceSettings } from '../../../src/modules/im/gateway/media/config.js'

const owner='00000000-0000-4000-8000-000000000041',other='00000000-0000-4000-8000-000000000042'
const item={id:'voice-a',name:'合成识别模型',provider:'qwen',model:'asr-synthetic',api_format:'openai',base_url:'https://platform-asr.example/v1',api_key:'synthetic-platform-key'}
const document=()=>({voice_presets:{active_id:'voice-a',items:[{...item}]}})
const emptyPool={async query(){return{rows:[]}}} as unknown as Pick<Pool,'query'>
test('voice默认未配置、ENV独立预设与override整段优先，不从VOICE或聊天模型偷取配置',()=>{
  assert.equal(resolveImVoiceSettings({},{}).settings.model,undefined)
  assert.equal(resolveImVoiceSettings({}, {VOICE__MODEL:'not-a-settings-field',AI__MODEL:'chat-not-asr'}).settings.model,undefined)
  const env={VOICE_PRESETS:JSON.stringify({active_id:'voice-a',items:[item]}),VOICE_PRESETS__ACTIVE_ID:'voice-b',VOICE_PRESETS__ITEMS:JSON.stringify([{...item,id:'voice-b',model:'env-asr'}])}
  assert.equal(resolveImVoiceSettings({},env).settings.model,'env-asr')
  assert.equal(resolveImVoiceSettings(document(),env).settings.model,'asr-synthetic')
  assert.equal(resolveImVoiceSettings({voice_presets:{}},env).settings.model,undefined)
  assert.equal(resolveImVoiceSettings({byok:{enabled:false},ai:{deployment_mode:'local'}},{}).byokEnabled,true)
  assert.equal(resolveImVoiceSettings({}, {BYOK__ENABLED:'false'}).byokEnabled,false)
  assert.throws(()=>resolveImVoiceSettings({}, {VOICE_PRESETS:'private malformed token'}),error=>error instanceof Error&&!error.message.includes('private'))
})
test('全局预设按实际独立格式规格，不向普通JSON暴露配置Key；更换活动预设使旧binding撤权',async()=>{
  let config=document()
  const resolver=createImVoiceSelection({pool:emptyPool,document:()=>config,environment:{},authorize:async()=>true})
  const base=await resolver.select(owner)
  assert.equal(base.config!.provider,undefined,'Python Settings.voice不复制preset.provider到协议路由')
  assert.equal(base.profile.maxFileBytes,36*1024*1024);assert.equal(base.profile.maxDurationSeconds,null)
  assert.equal(base.config!.api_key,item.api_key);assert.equal(JSON.stringify(base).includes(item.api_key),false)
  assert.equal(await base.authorizeCurrent(),true)
  config={voice_presets:{active_id:'other',items:[item]}}
  assert.equal(await base.authorizeCurrent(),false);assert.equal((await resolver.select(owner)).config,null)
  const minimax=createImVoiceSelection({pool:emptyPool,document:()=>({voice_presets:{active_id:'m',items:[{...item,id:'m',provider:'minimax',model:'asr-1.0',api_format:'minimax-asr',base_url:''}]}}),environment:{},authorize:async()=>true})
  const selected=await minimax.select(owner)
  assert.equal(selected.profile.maxFileBytes,50*1024*1024);assert.equal(selected.profile.maxDurationSeconds,500)
  assert.equal(selected.profile.providerLabel,'MiniMax ASR')
})
test('账户撤权/解密失败固定错误，unsupported BYOK不回落平台或LLM',async()=>{
  let enabled=true
  const row={id:1,provider:'minimax',api_format:'minimax-asr',base_url:'https://api.minimax.cn',model:'not-supported',encrypted_value:'synthetic',nonce:'synthetic',encrypted_data_key:'synthetic',key_version:1}
  const pool={async query(){return{rows:[row]}}} as unknown as Pick<Pool,'query'>
  const resolver=createImVoiceSelection({pool,document,environment:{},authorize:async()=>enabled,decryptCredential:async()=> 'synthetic-user-key'})
  const selected=await resolver.select(owner);assert.equal(selected.configured,false);assert.equal(selected.config,null);assert.equal(selected.usage.isByok,true)
  enabled=false;assert.equal(await selected.authorizeCurrent(),false)
  await assert.rejects(resolver.select(owner),/语音识别未授权/u)
  enabled=true
  const damaged=createImVoiceSelection({pool,document,environment:{},authorize:async()=>true,async decryptCredential(){throw Error('synthetic-private-envelope')}})
  await assert.rejects(damaged.select(owner),error=>error instanceof Error&&error.message==='语音识别配置暂不可用'&&!('cause'in error))
  const revoked=createImVoiceSelection({pool,document,environment:{},authorize:async()=>enabled,async decryptCredential(){enabled=false;return'synthetic-user-key'}})
  await assert.rejects(revoked.select(owner),/语音识别未授权/u)
})
test('只有可信显式local预设和明确base授权本地ASR，不根据URL猜测或改变空base路由',async()=>{
  let preset={...item,provider:'local',base_url:'http://localhost:12345/v1'}
  const resolver=createImVoiceSelection({pool:emptyPool,document:()=>({voice_presets:{active_id:preset.id,items:[preset]}}),environment:{},authorize:async()=>true})
  const local=await resolver.select(owner)
  assert.equal(local.config!.provider,'local')
  const requests:{url:string;allowLocal?:boolean}[]=[]
  const dependencies={digest:()=> 'synthetic-digest',toWav:async()=>null,transport:{async request(request:{url:string;allowLocal?:boolean}){
    requests.push(request)
    return{status:200,headers:{},body:(async function*(){yield new TextEncoder().encode(JSON.stringify({choices:[{message:{content:'合成转写'}}]}))})(),cancel(){}}
  }}}
  const media=[{type:'audio',mime:'audio/wav',raw:new Uint8Array([1,2,3])}]
  assert.equal(await transcribeCompatibleAsr(media,local.config!,dependencies,new AbortController().signal,{raiseErrors:true}),'合成转写')
  assert.equal(requests[0]!.url,'http://localhost:12345/v1/chat/completions')
  assert.equal(requests[0]!.allowLocal,true)
  preset={...preset,provider:'openai'}
  assert.equal(await local.authorizeCurrent(),false)
  const ordinary=await resolver.select(owner)
  await transcribeCompatibleAsr(media,ordinary.config!,dependencies,new AbortController().signal,{raiseErrors:true})
  assert.equal(requests[1]!.allowLocal,false,'相同URL不会自行获得内网授权')
  for(const provider of ['local','qwen','minimax']){
    preset={...preset,provider,base_url:''}
    const empty=await resolver.select(owner)
    assert.equal(empty.config!.provider,undefined)
    assert.equal(empty.config!.base_url,'','保留原空目的地，不按provider自动补地址')
  }
})
const pgUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG真实信封：同owner speech_to_text最小ID、用户Key目的地独立、版本/停用/账户撤权实时复核',{
  skip:!pgUrl&&'未运行：显式隔离PG连接后验证真实speech_to_text与BYOK信封，query替身不能证明归属',
},async()=>{
  const{Pool}=await import('pg'),admin=new Pool({connectionString:pgUrl}),schema=`im_voice_${randomUUID().replaceAll('-','')}`
  let pool:Pool|undefined
  const master='a'.repeat(64),env={CREDENTIALS_MASTER_KEY:master,CREDENTIALS_MASTER_KEY_VERSION:'1'}
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:pgUrl,options:`-c search_path=${schema}`})
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_provider_credentials(id integer PRIMARY KEY,user_id uuid,capability text,enabled boolean,provider text,api_format text,base_url text,model text,
        encrypted_value text,nonce text,encrypted_data_key text,key_version integer)`)
    await pool.query("INSERT INTO users VALUES($1,true,'active'),($2,true,'active')",[owner,other])
    const db=pool
    async function insert(id:number,user:string,capability:string,key:string,provider='openai',format='openai',model='user-asr'){
      const e=encryptByokEnvelope(key,master,1)
      await db.query('INSERT INTO user_provider_credentials VALUES($1,$2,$3,true,$4,$5,\'\',$6,$7,$8,$9,$10)',[id,user,capability,provider,format,model,e.ciphertext,e.nonce,e.encryptedDataKey,e.keyVersion])
    }
    await insert(1,other,'speech_to_text','synthetic-other-owner-key')
    await insert(2,owner,'llm','synthetic-chat-key')
    await insert(3,owner,'speech_to_text','synthetic-user-asr-key')
    await insert(4,owner,'speech_to_text','synthetic-secondary-key')
    const resolver=createImVoiceSelection({pool:db,document,environment:env,async authorize(id){return(await db.query("SELECT 1 FROM users WHERE id=$1 AND is_active IS TRUE AND account_status='active'",[id])).rows.length===1}})
    const selected=await resolver.select(owner)
    assert.equal(selected.config!.api_key,'synthetic-user-asr-key');assert.equal(selected.usage.credentialId,3)
    assert.equal(selected.config!.base_url,'https://api.openai.com/v1')
    const old=(await db.query('SELECT encrypted_value,nonce,encrypted_data_key,key_version FROM user_provider_credentials WHERE id=3')).rows[0]
    const rotated=encryptByokEnvelope('synthetic-rotated-user-key',master,2)
    env.CREDENTIALS_MASTER_KEY_VERSION='2'
    await db.query('UPDATE user_provider_credentials SET encrypted_value=$1,nonce=$2,encrypted_data_key=$3,key_version=2 WHERE id=3',[rotated.ciphertext,rotated.nonce,rotated.encryptedDataKey])
    assert.equal(await selected.authorizeCurrent(),false)
    assert.equal((await resolver.select(owner)).config!.api_key,'synthetic-rotated-user-key')
    env.CREDENTIALS_MASTER_KEY_VERSION='1'
    await db.query('UPDATE user_provider_credentials SET encrypted_value=$1,nonce=$2,encrypted_data_key=$3,key_version=$4 WHERE id=3',[old.encrypted_value,old.nonce,old.encrypted_data_key,old.key_version])
    assert.notEqual(selected.config!.base_url,item.base_url);assert.equal(await selected.authorizeCurrent(),true)
    await db.query('UPDATE user_provider_credentials SET enabled=false WHERE id=3')
    assert.equal(await selected.authorizeCurrent(),false)
    const next=await resolver.select(owner);assert.equal(next.usage.credentialId,4)
    await db.query("UPDATE user_provider_credentials SET provider='qwen',api_format='dashscope',model='fun-asr-synthetic',base_url='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' WHERE id=4")
    const dash=await resolver.select(owner);assert.equal(dash.config!.dashscope_service,'fun-asr');assert.equal(await next.authorizeCurrent(),false)
    await db.query("UPDATE user_provider_credentials SET encrypted_value='broken-envelope' WHERE id=4")
    await assert.rejects(resolver.select(owner),/语音识别配置暂不可用/u)
    await db.query('UPDATE user_provider_credentials SET enabled=false WHERE user_id=$1',[owner])
    assert.equal((await resolver.select(owner)).usage.isByok,false)
    await db.query("UPDATE users SET account_status='disabled' WHERE id=$1",[owner])
    assert.equal(await dash.authorizeCurrent(),false);await assert.rejects(resolver.select(owner),/语音识别未授权/u)
  }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
})
