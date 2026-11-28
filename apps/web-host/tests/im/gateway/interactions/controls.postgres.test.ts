import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import { createHash,createHmac,randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createAgentRunner,stableJson,type AgentRunnerPorts,type PendingInteraction } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/gateway'
import { createUserBotBindingCodeIssuer } from '@gugu/core/im/binding-code'
import { createPostgresImControls } from '../../../../src/modules/im/gateway/attention/controls.js'
import { createPostgresImNativeInteractions } from '../../../../src/modules/im/gateway/interactions/store.js'
import { createTelegramBotApi } from '@gugu/gateway/telegram'
import { createTelegramSender } from '@gugu/gateway/telegram'
import { createQqClient } from '@gugu/gateway/qq'
import { createQqSender } from '@gugu/gateway/qq'
import { createQqReplySequences } from '../../../../src/modules/im/gateway/platforms/qq/sequences.js'
import { createQqMediaUploader } from '@gugu/gateway/qq'
import { createFeishuClient } from '@gugu/gateway/feishu'
import { createFeishuSender } from '@gugu/gateway/feishu'
import type { ProviderTransport } from '@gugu/core/providers'
import type { GatewayPlatformSender } from '../../../../src/modules/im/gateway/connections.js'
import { createPostgresImAccess } from '../../../../src/modules/im/gateway/inbound/access.js'
import { createPostgresImConversationStore } from '../../../../src/modules/im/gateway/agent/conversations.js'
import { createImInboundEnvelope } from '../../../../src/modules/im/gateway/inbound/envelope.js'
import { createByokEnvelope } from '../../../../src/modules/byok/crypto.js'
import { createRedisStreamCommands } from '../../../../src/adapters/cache/redis-stream-commands.js'
import { withPostgresTransaction } from '../../../../src/adapters/database/postgres-transaction.js'
import { enqueueAgentRunLocked } from '../../../../src/modules/agent/run/dispatch.js'
import { createPostgresAgentRunStore } from '../../../../src/modules/agent/run/store.js'
import { createPostgresAgentRunLeasePort } from '../../../../src/modules/agent/run/lease.js'
import { createPostgresInteractionActivator } from '../../../../src/modules/agent/interactions/activate.js'
import { createImRunSender } from '../../../../src/modules/im/gateway/delivery/reply.js'
import { createPostgresFileReadOperations } from '../../../../src/modules/files/browse.js'
import { imConversationDigest,imConversationFingerprint } from '../../../../src/modules/im/gateway/agent/identity.js'
import { context as senderContext,platform as senderPlatform,temporary,deliveryOutcome } from '../run-sender.fixtures.js'

test('生产组合缺少业务加密、确认或平台reply时拒绝构造，不注入空端口',()=>{
  assert.throws(()=>createPostgresImControls({} as never),{message:'IM 控制服务暂不可用'})
})
const url=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_GATEWAY_TEST_REDIS_URL
test('隔离PG/Redis：真实Core预检组合绑定、凭据、选择及冻结取消，替身仅Provider/平台reply/业务确认边界',{
  skip:!(url&&redisUrl)&&'未运行：显式设置 GUGU_IM_GATEWAY_TEST_DATABASE_URL 和 GUGU_IM_GATEWAY_TEST_REDIS_URL',timeout:30000,
},async t=>{
  const {Pool}=await import('pg'),schema=`im_controls_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),secretKey='synthetic-controls-secret'
  const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:6})
  const redis=createRedisStreamCommands(redisUrl!),keyId=100000000+Math.floor(Math.random()*900000000),server=randomUUID()
  const signal=new AbortController().signal,replies:{text:string;quote:boolean}[]=[],diagnostics:string[]=[],cancelled=new Set<string>()
  let wakes=0,bindingInvalidations=0
  let beforeDecrypt:()=>Promise<void>=async()=>{}
  const scope:ImPreflightScope={ownerId:owner,botId:String(keyId),platform:'telegram',chatType:'c2c',chatId:null,platformUserId:'8181',eventId:'control',admissionCutoff:'2090-01-01T00:00:00Z'}
  const byok=createByokEnvelope({keyFile:'unused-synthetic-keyfile',version:1,masterKey:'synthetic-control-master-key'})
  const conversation=createPostgresImConversationStore({pool,secretKey,attachments:{mode:'text-only'},
    authorize:async(client,binding,payload)=>await createPostgresImAccess({query:(q,p)=>client.query(q,p),supportedPlatforms:()=>['telegram','qq','feishu','wechat']}).readBot({...binding,chatType:payload.chat_type as 'group'|'c2c',platformUserId:String(payload.platform_user_id)})!==null,
    classify:async()=>{throw new Error('本测试仅借用真实持久路由读取，不调用写入分类')} })
  const controls=createPostgresImControls({pool,redis,secretKey,supportedPlatforms:()=>['telegram','qq','feishu','wechat'],readRoute:conversation.readRoute,
    history:{async writeHistory(){throw new Error('本控制消费测试不结束Runner，不应写历史')}},
    crypto:{encrypt:values=>byok.encrypt(JSON.stringify(values)),decrypt:async envelope=>{await beforeDecrypt();return byok.decrypt(envelope)}},
    invalidateMcpLocked:async(client,user,target)=>{await client.query('INSERT INTO invalidations VALUES($1,$2)',[user,target])},
    interactionEffects:{async applyCommandAction(){throw new Error('合成普通选择不执行业务命令')},async redeemConfirmation(){throw new Error('合成普通选择不兑换工具确认')}},
    cancellation:{async request(identity){cancelled.add(identity.runId)},async notify(){}},async wakeInteractions(){wakes++},wakeDispatch(){wakes++},
    invalidateBinding(){bindingInvalidations++},async publishBindingChanged(){},async reply(_scope,text,options){replies.push({text,quote:options.quote})},diagnose:code=>diagnostics.push(code)})
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),platform text,enabled boolean,owner_platform_user_id text,owner_bound_at timestamptz,group_allowed_tools json,group_owner_memory_enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),source text,bot_id text,chat_type text,chat_id text,platform_user_id text,updated_at timestamptz DEFAULT clock_timestamp(),execution_state text DEFAULT 'idle',active_run_id text,pending_message_count integer DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer REFERENCES conversation_sessions(id),role text,run_id text,platform_user_id text,chat_type text,conversation_seq bigint,im_platform_message_id text,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id varchar(128),state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX selected ON agent_run_dispatch(user_id,session_id) WHERE state='selected';
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text,version bigint,sequence bigint,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id));
      CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text,created_at timestamptz);
      CREATE TABLE interaction_prompts(id serial PRIMARY KEY,user_id uuid,session_id integer,kind text,title text,body text,schema_json jsonb,status text,expires_at timestamptz,created_at timestamptz,resolved_at timestamptz);
      CREATE TABLE interaction_actions(id serial PRIMARY KEY,prompt_id integer,token_hash text,action_type text,option_id text,context_json jsonb,status varchar(20),expires_at timestamptz,created_at timestamptz,consumed_at timestamptz,consumed_event_id text);
      CREATE TABLE agent_interaction_bindings(prompt_id integer PRIMARY KEY,user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text,created_at timestamptz);
      CREATE TABLE mcp_secret_inputs(id serial PRIMARY KEY,prompt_id integer,user_id uuid,server_id uuid,session_id integer,platform text,bot_id text,chat_id text,chat_type text,platform_user_id text,status text,next_field_index integer,consumed_event_ids json,encrypted_payload text,payload_nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,UNIQUE(prompt_id));
      CREATE TABLE user_mcp_servers(id uuid PRIMARY KEY,user_id uuid,scope text,credential_slots jsonb,encrypted_credentials text DEFAULT '',credentials_nonce text DEFAULT '',encrypted_credentials_key text DEFAULT '',credentials_key_version integer DEFAULT 1);
      CREATE TABLE invalidations(owner_id uuid,server_id uuid);`)
    for(const file of ['conversation','bindingConsume','shortcut','admission','nativeInteraction'] as const)await pool.query(imGatewaySql[file])
    async function reset(){
      await pool.query(`TRUNCATE gugu_im_native_prompt_messages,gugu_im_native_deliveries,gugu_im_gateway_admissions,invalidations,user_mcp_servers,mcp_secret_inputs,agent_interaction_resumes,agent_interaction_bindings,interaction_actions,interaction_prompts,gugu_im_shortcut_controls,gugu_im_binding_consumptions,gugu_im_inbound_segments,gugu_im_inbound_receipts,agent_run_checkpoints,agent_run_events,agent_run_leases,agent_run_interaction_receipts,agent_run_dispatch,agent_run_startups,conversation_messages,conversation_sessions,user_bots,users CASCADE`)
      await pool.query("INSERT INTO users VALUES($1,true,'active')",[owner])
      await pool.query("INSERT INTO user_bots VALUES($1,$2,'telegram',true,'8181',NULL,'[]',false,true,NULL)",[keyId,owner])
      await pool.query("INSERT INTO conversation_sessions(id,user_id,source,bot_id,chat_type,platform_user_id)VALUES(1,$1,'telegram',$2,'c2c','8181')",[owner,String(keyId)])
      replies.length=0;cancelled.clear();wakes=0;beforeDecrypt=async()=>{}
    }
    async function run(kind:'question'|'credential'|'confirmation',current=scope,toolName='ask_user_question'){
      const binding={ownerId:owner,botId:String(keyId),platform:current.platform},identity={ownerId:owner,sessionId:'1',runId:`run-${kind}`}
      const payload={owner_user_id:owner,platform:current.platform,bot_id:String(keyId),channel_id:String(keyId),chat_type:current.chatType,chat_id:current.chatId,
        platform_user_id:current.platformUserId,message_id:current.platform==='wechat'?'synthetic-private-reply-context':'31',
        ...(current.platform==='wechat'?{context_token:'synthetic-private-reply-context'}:{platform_message_id:'31'}),text:'合成消息',bot_mentioned:false,mentions_other_bot:false}
      await pool.query('UPDATE conversation_sessions SET source=$1,chat_type=$2,chat_id=$3,platform_user_id=$4 WHERE id=1',[current.platform,current.chatType,current.chatId,current.platformUserId])
      await pool.query('UPDATE user_bots SET platform=$1 WHERE id=$2',[current.platform,keyId])
      await pool.query("INSERT INTO conversation_messages(id,session_id,role,run_id,platform_user_id,chat_type,conversation_seq,im_platform_message_id)VALUES(1,1,'user',$1,$2,$3,1,$4)",[identity.runId,current.platformUserId,current.chatType,current.platform==='wechat'?null:'31'])
      const scopeHash=createHmac('sha256',secretKey).update('gugu-im-conversation-v1\0').update(stableJson([owner,current.platform,String(keyId),current.chatType,current.chatId??current.platformUserId])).digest('hex')
      await pool.query(`INSERT INTO gugu_im_inbound_receipts VALUES($1,$2,$3,$4,$5,$6,$7,1,1,'dispatched',$8,$9)`,[owner,current.platform,String(keyId),current.chatType,scopeHash,
        imConversationDigest(secretKey,[scopeHash,current.platformUserId,payload.message_id]),imConversationFingerprint(secretKey,scopeHash,payload,[]),identity.runId,JSON.stringify(createImInboundEnvelope(secretKey).seal(binding,payload))])
      await pool.query("INSERT INTO agent_run_startups(user_id,session_id,run_id,status)VALUES($1,1,$2,'pending')",[owner,identity.runId])
      await withPostgresTransaction(pool,client=>enqueueAgentRunLocked(client,secretKey,identity,{v:3,source:'im',userMessageId:1,locale:null,origin:null,accessVersion:'a'.repeat(64),im:{platform:current.platform,botId:String(keyId),chatType:current.chatType,chatId:current.chatId,platformUserId:current.platformUserId}},60))
      const pending:PendingInteraction={id:`pending-${kind}`,kind,toolCall:{id:'tool-synthetic',name:toolName,input:{}}}
      const activator=createPostgresInteractionActivator(pool,{async describe(){return kind==='credential'
        ?{kind:'form',title:'合成凭据',body:'',options:[],context:{secret_target:{kind:'mcp_credentials',server_id:server}},secretFields:[{name:'api_key',label:'合成密钥',type:'secret'}]}
        :kind==='confirmation'?{kind:'confirm',title:'合成确认',body:'',options:[{id:'confirm',label:'确认',actionType:'confirm'}],context:{}}
        :{kind:'choice',title:'合成选项',body:'',allowTextInput:true,options:[{id:'yes',label:'继续',actionType:'choice'}],context:{}}}})
      const store=createPostgresAgentRunStore<string[]>(pool,secretKey,{async writeHistory(){throw new Error('等待前不应结束历史')}})
      const ports:AgentRunnerPorts<string[]>={clock:{now:()=>new Date().toISOString()},store,leases:createPostgresAgentRunLeasePort(pool),
        cancellation:{async isRequested(){return false},async request(){},async notify(){},async subscribe(){return()=>{}}},
        provider:{async *stream(){yield{type:'complete',text:'',calls:[pending.toolCall]}}},
        context:{assertIdentity(){},async checkpointToolResult(_s,v){return v},async restoreToolResult(_s,v){return v},async prepare(){return[owner,'1','合成可信上下文']},async afterRound(c){return c},async afterTool(c){return c},async resumeInteraction(c){return c},async recoverOverflow(c){return{context:c,applied:false}},async afterUsage(c){return{context:c,applied:false}}},
        tools:{async dispatch(){return{kind:'waiting',interaction:pending}},async reconcile(){return{kind:'unknown'}}},interactions:activator,
        execution:{async execute(){throw new Error('不应执行进程')}},reply:{async evaluate(){return'accept'}},sanitizeText:v=>v,createStreamSanitizer:()=>({feed:v=>v,flush:()=>''}),
        presentError:()=>({code:'failed',text:'合成测试失败'}),async presentToolResult(v){return v},async publish(){},diagnose(){}}
      for await(const _event of createAgentRunner(ports).start(identity,{anchorMessageId:'1'})){}
      assert.equal((await store.read(identity))?.status,'waiting')
      return identity
    }
    const preflight=(text:string,s=scope)=>controls.preflight({scope:s,text,hasPendingMedia:false,botMentioned:false},signal)
    await t.test('TG绑定经真实Redis Lua与PG消费收据，未知私聊能绑定而非预先放宽owner',async()=>{
      await reset();await pool.query('UPDATE user_bots SET owner_platform_user_id=NULL')
      const code='123456'
      const key=`im:telegram-binding:${keyId}`
      await createUserBotBindingCodeIssuer({query:(q,p)=>pool.query(q,p),save:(name,value,ttl)=>redis.sendCommand(['EVAL',"redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); return 1",'1',name,value,String(ttl)]),
        generateCode:()=>code,generateChallenge:()=>`synthetic-${keyId}`,sign:message=>createHmac('sha256',secretKey).update(message).digest('hex')})(owner,keyId,'telegram')
      assert.equal(await controls.preflight({scope,text:`/bind ${code}`,telegramCommand:'bind',hasPendingMedia:false,botMentioned:false},signal),'consumed')
      assert.equal((await pool.query('SELECT owner_platform_user_id FROM user_bots')).rows[0].owner_platform_user_id,'8181')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_im_binding_consumptions')).rows[0].n,1)
      assert.equal(await redis.sendCommand(['GET',key]),null);assert.equal(bindingInvalidations,1);assert.equal(replies[0]?.text,'绑定成功。')
    })
    await t.test('真实PG prompt/token消费与恢复队列，数字不进入普通Agent历史，重投无第二次回复',async()=>{
      await reset();await run('question')
      assert.equal(await preflight('1'),'consumed')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_messages')).rows[0].n,1)
      assert.equal(wakes,1);assert.equal(replies.length,1)
      assert.equal(await preflight('1'),'consumed');assert.equal(replies.length,1)
    })
    await t.test('秘密输入经真实BYOK加密与MCP写入/失效/恢复同事务，回复不引用秘密',async()=>{
      await reset();await pool.query("INSERT INTO user_mcp_servers(id,user_id,scope,credential_slots)VALUES($1,$2,'user','[{\"id\":\"api_key\",\"target\":\"header\"}]')",[server,owner])
      await run('credential',scope,'mcp_connect')
      assert.equal(await preflight('输入凭据',{...scope,eventId:'secret-start'}),'consumed')
      assert.equal(await preflight('synthetic-private-secret',{...scope,eventId:'secret-value'}),'consumed')
      const stored=(await pool.query('SELECT * FROM user_mcp_servers')).rows[0]
      assert.doesNotMatch(JSON.stringify(stored),/synthetic-private-secret/)
      assert.deepEqual(JSON.parse(await byok.decrypt({ciphertext:stored.encrypted_credentials,nonce:stored.credentials_nonce,encryptedDataKey:stored.encrypted_credentials_key,keyVersion:stored.credentials_key_version})),{api_key:'synthetic-private-secret'})
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM invalidations')).rows[0].n,1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,1)
      assert.ok(replies.every(r=>r.quote===false));assert.doesNotMatch(JSON.stringify(replies),/synthetic-private-secret/)
    })
    await t.test('私聊绑定撤销后旧秘密stage仍被消费为失效，未知私聊普通文字可以进入原Run路径',async()=>{
      await reset();await pool.query("INSERT INTO user_mcp_servers(id,user_id,scope,credential_slots)VALUES($1,$2,'user','[{\"id\":\"api_key\",\"target\":\"header\"}]')",[server,owner])
      await run('credential',scope,'mcp_connect')
      await pool.query("UPDATE user_bots SET owner_platform_user_id='9191'")
      assert.equal(await preflight('synthetic-revoked-secret',{...scope,eventId:'revoked-value'}),'consumed')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_messages')).rows[0].n,1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,0)
      assert.doesNotMatch(JSON.stringify(replies),/synthetic-revoked-secret/)
      await reset();await pool.query('UPDATE user_bots SET owner_platform_user_id=NULL')
      assert.equal(await preflight('合成普通问题'),'enqueue')
    })
    await t.test('群成员不能恢复owner-only工具确认，owner撤销及跨scope不能消费原prompt',async()=>{
      await reset();const group={...scope,chatType:'group' as const,chatId:'synthetic-room'}
      await run('question',group,'create_skill')
      await assert.rejects(preflight('1',group),{message:'IM 入站控制消息暂时无法处理'})
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,0)
      assert.equal((await pool.query('SELECT status FROM interaction_actions')).rows[0].status,'pending')
      assert.equal(await preflight('1',{...group,chatId:'other-room'}),'enqueue')
      await pool.query('UPDATE user_bots SET group_chat_enabled=false')
      assert.equal(await preflight('1',group),'consumed');assert.equal(replies.length,0)
    })
    await t.test('工具名称、交互kind或来源漂移拒绝消费，不能只用同owner和toolCallId绕过精确pending证明',async()=>{
      for(const mutate of [
        "UPDATE interaction_prompts SET schema_json=jsonb_set(schema_json,'{context,tool_name}','\"other_tool\"')",
        "UPDATE interaction_prompts SET kind='confirm'",
        "UPDATE interaction_prompts SET schema_json=jsonb_set(schema_json,'{source}','\"web\"')",
      ]){
        await reset();await run('question');await pool.query(mutate)
        await assert.rejects(preflight('1'),{message:'IM 入站控制消息暂时无法处理'})
        assert.equal((await pool.query('SELECT status FROM interaction_actions')).rows[0].status,'pending')
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,0)
        assert.equal(replies.length,0)
      }
    })
    for(const platform of ['telegram','qq','feishu'] as const)for(const kind of ['question','confirmation','credential'] as const)for(const mode of platform==='telegram'&&kind==='question'?['normal','rejected','unknown','index-failure']:['normal'])await t.test(`${platform}/${kind}/${mode}实际sender发送token并登记HMAC消息证明，原生callback进入真实消费与恢复事务`,async()=>{
      await reset();const current={...scope,platform,platformUserId:platform==='feishu'?'ou_synthetic':scope.platformUserId}
      if(platform==='feishu')await pool.query('UPDATE user_bots SET owner_platform_user_id=$1',[current.platformUserId])
      if(kind==='credential')await pool.query("INSERT INTO user_mcp_servers(id,user_id,scope,credential_slots)VALUES($1,$2,'user','[{\"id\":\"api_key\",\"target\":\"header\"}]')",[server,owner])
      const identity=await run(kind,current,kind==='credential'?'mcp_connect':'ask_user_question'),binding={ownerId:owner,botId:String(keyId),platform}
      const requests:{path:string;body:Record<string,unknown>}[]=[]
      const transport:ProviderTransport={async request(request){
        const url=new URL(request.url),body=request.body?JSON.parse(typeof request.body==='string'?request.body:Buffer.from(request.body as Uint8Array).toString('utf8')):{}
        requests.push({path:url.pathname,body})
        if(platform==='telegram'&&url.pathname.endsWith('/sendMessage')&&mode==='unknown')throw new Error('合成已可能发送的网络故障')
        if(platform==='telegram'&&url.pathname.endsWith('/sendMessage')&&mode==='rejected'&&requests.length===1)return{status:403,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify({ok:false,error_code:403,description:'synthetic rejection'}))})(),async cancel(){}}
        const result=url.pathname.includes('tenant_access_token')?{code:0,tenant_access_token:'synthetic-feishu-token',expire:7200}
          :url.pathname.includes('getAppAccessToken')?{access_token:'synthetic-qq-token',expires_in:7200}
          :platform==='telegram'?{ok:true,result:{message_id:701}}
          :platform==='feishu'?{code:0,data:{message_id:'om_synthetic'}}:{id:'qq_synthetic_message'}
        return{status:200,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify(result))})(),async cancel(){}}
      }}
      const telegram=createTelegramBotApi({transport}),qq=createQqClient({appId:'synthetic-app',appSecret:'synthetic-secret',sandbox:false,transport}),feishu=createFeishuClient({appId:'synthetic-app',appSecret:'synthetic-secret',transport})
      const qqUpload=createQqMediaUploader({client:qq,transport})
      const wire:GatewayPlatformSender=platform==='telegram'?{platform,sender:createTelegramSender({api:telegram,token:'123456:synthetic-token-value-0000000000',sleep:async()=>{}})}
        :platform==='qq'?{platform,sender:createQqSender({client:qq,botId:String(keyId),sanitizeText:text=>text,sequences:createQqReplySequences(redis,binding)}),mediaUpload:qqUpload}
        :{platform,sender:createFeishuSender({client:feishu}),streaming:{} as never}
      const native=createPostgresImNativeInteractions({pool,secretKey,supportedPlatforms:()=>['telegram','qq','feishu'],controls,readRoute:conversation.readRoute,sender:requested=>requested.ownerId===owner&&requested.botId===String(keyId)&&requested.platform===platform?wire:null})
      const store=createPostgresAgentRunStore<string[]>(pool,secretKey,{async writeHistory(){throw new Error('不应写历史')}})
      const event=(await store.readEventsAfter(identity,0)).find(e=>e.type==='interaction_required')!
      try{
        if(mode==='index-failure')await pool.query(`CREATE FUNCTION reject_native_index() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic index failure'; END $$;
          CREATE TRIGGER reject_native_index BEFORE INSERT ON gugu_im_native_prompt_messages FOR EACH ROW EXECUTE FUNCTION reject_native_index()`)
        if(mode==='rejected')assert.equal(await native.interaction({identity,event,deliveryId:`delivery-${platform}`}),'rejected')
        if(mode==='unknown'||mode==='index-failure'){
          assert.equal(await native.interaction({identity,event,deliveryId:`delivery-${platform}`}),'unknown')
          assert.equal(await native.interaction({identity,event,deliveryId:`delivery-${platform}`}),'unknown')
          assert.equal(requests.length,1)
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_im_native_prompt_messages')).rows[0].n,0)
          assert.equal((await pool.query('SELECT state FROM gugu_im_native_deliveries')).rows[0].state,'unknown')
          return
        }
        const delivered=await native.interaction({identity,event,deliveryId:`delivery-${platform}`})
        assert.equal(typeof delivered==='object'?delivered.outcome:delivered,'accepted')
        assert.equal(typeof delivered,'object')
        if(typeof delivered==='object')assert.equal((delivered.evidence as {kind:string}).kind,'interaction')
        assert.equal(await native.interaction({identity,event,deliveryId:`delivery-${platform}`}),'accepted')
        const sent=requests.filter(r=>platform==='telegram'?r.path.endsWith('/sendMessage'):platform==='qq'?r.path.includes('/messages'):r.path.endsWith('/im/v1/messages')).at(-1)!
        assert.ok(sent)
        let promptId:number,token:string,cancelToken:string|undefined,customToken:string|undefined
        if(platform==='telegram'){
          const buttons=((sent.body.reply_markup as any).inline_keyboard)[0],button=buttons[0].callback_data as string
          ;[promptId,token]=[Number(button.split(':')[0]),button.split(':')[1]!]
          cancelToken=buttons[1]?.callback_data.split(':')[1]
          if(kind==='question')customToken=cancelToken
        }else if(platform==='qq'){
          const buttons=(sent.body.keyboard as any).content.rows[0].buttons,button=buttons[0].action.data as string
          ;[promptId,token]=[Number(button.split(':')[0]),button.split(':')[1]!]
          cancelToken=buttons[1]?.action.data.split(':')[1]
          if(kind==='question')customToken=cancelToken
        }else{
          assert.equal(sent.body.receive_id,current.platformUserId)
          const content=JSON.parse(String(sent.body.content)),buttons=content.elements.find((e:any)=>e.tag==='action').actions,value=buttons[0].value
          promptId=value.prompt_id;token=value.token
          cancelToken=buttons[1]?.value.token
          if(kind==='question')customToken=cancelToken
        }
        const raw=platform==='telegram'?{id:'callback-native',from:{id:8181},message:{message_id:701,chat:{id:8181,type:'private'}},data:`${promptId}:${token}`}
          :platform==='qq'?{id:'callback-native',user_openid:'8181',data:{resolved:{button_data:`${promptId}:${token}`}}}
          :{kind:'card_action',ownerId:owner,botId:String(keyId),eventId:'callback-native',operatorId:current.platformUserId,promptId,actionToken:token,label:'不可信标签',raw:{header:{event_id:'callback-native'},event:{operator:{open_id:current.platformUserId},action:{value:{prompt_id:promptId,token}},context:{open_chat_id:'oc_synthetic',open_message_id:'om_synthetic'}}}}
        assert.equal((await native.callback({binding,platform,data:{...raw,...(platform==='telegram'?{message:{message_id:702,chat:{id:8181,type:'private'}}}:platform==='qq'?{message_id:'other-message'}:{raw:{...(raw as any).raw,event:{...(raw as any).raw.event,context:{open_chat_id:'oc_synthetic',open_message_id:'other-message'}}}})}},signal)).accepted,false)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,0)
        assert.equal((await native.callback({binding:{...binding,ownerId:randomUUID()},platform,data:raw},signal)).accepted,false)
        const otherActor=platform==='telegram'?{...raw,from:{id:9191}}:platform==='qq'?{...raw,user_openid:'other-sender'}:{...raw,operatorId:'other-sender',raw:{...(raw as any).raw,event:{...(raw as any).raw.event,operator:{open_id:'other-sender'}}}}
        assert.equal((await native.callback({binding,platform,data:otherActor},signal)).accepted,false)
        if (kind === 'question') {
          assert.ok(customToken)
          const eventId = 'callback-custom'
          const customData = `${promptId}:${customToken}`
          const custom = platform === 'qq' ? { ...raw, id: eventId, data: { resolved: { button_data: customData } } }
            : platform === 'telegram' ? { ...raw, id: eventId, data: customData }
            : { ...raw, eventId, actionToken: customToken, raw: {
              header: { event_id: eventId },
              event: { operator: { open_id: current.platformUserId }, action: { value: { prompt_id: promptId, token: customToken } },
                context: { open_chat_id: 'oc_synthetic', open_message_id: 'om_synthetic' } },
            } }
          const first = await native.callback({ binding, platform, data: custom }, signal)
          assert.equal(first.accepted, true)
          assert.equal((await native.callback({ binding, platform, data: custom }, signal)).accepted, true)
          assert.equal((await pool.query("SELECT schema_json->>'custom_input_active' AS active FROM interaction_prompts")).rows[0].active, 'true')
          if (platform === 'feishu') assert.match(JSON.stringify(first.response), /请直接发送你的回复/u)
          else assert.equal(replies.filter(text => text.text.includes('请直接发送你的回复')).length, 1)
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n, 0)
          assert.equal(await preflight('合成自定义回答', {...current, eventId:'custom-text'}),'consumed')
        } else {
          assert.equal((await native.callback({binding,platform,data:raw},signal)).accepted,true)
          assert.equal((await native.callback({binding,platform,data:raw},signal)).accepted,true)
        }
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,kind==='credential'?0:1)
        if(kind==='credential'){
          assert.ok(cancelToken)
          assert.equal((await pool.query('SELECT status FROM mcp_secret_inputs')).rows[0].status,'awaiting_secret')
          const cancelRaw=platform==='telegram'?{...raw,id:'callback-cancel',data:`${promptId}:${cancelToken}`}
            :platform==='qq'?{...raw,id:'callback-cancel',data:{resolved:{button_data:`${promptId}:${cancelToken}`}}}
            :{...raw,eventId:'callback-cancel',actionToken:cancelToken,raw:{header:{event_id:'callback-cancel'},event:{...(raw as any).raw.event,action:{value:{prompt_id:promptId,token:cancelToken}}}}}
          assert.equal((await native.callback({binding,platform,data:cancelRaw},signal)).accepted,true)
          assert.equal((await pool.query('SELECT status FROM mcp_secret_inputs')).rows[0].status,'cancelled')
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,1)
        }
        const indexes=JSON.stringify((await pool.query('SELECT * FROM gugu_im_native_prompt_messages')).rows)
        assert.doesNotMatch(indexes,new RegExp(token));assert.doesNotMatch(indexes,/om_synthetic|qq_synthetic_message|oc_synthetic/)
        assert.equal(requests.filter(r=>platform==='telegram'?r.path.endsWith('/sendMessage'):platform==='qq'?r.path.includes('/messages'):r.path.endsWith('/im/v1/messages')).length,mode==='rejected'?2:1)
      }finally{
        if(mode==='index-failure')await pool.query('DROP TRIGGER reject_native_index ON gugu_im_native_prompt_messages;DROP FUNCTION reject_native_index()')
        await qqUpload.close();await telegram.close();await qq.close();await feishu.close()
      }
    })
    await t.test('原生秘密token与stage推进同事务，不按label启动且同event重投不重复恢复',async()=>{
      await reset();await pool.query("INSERT INTO user_mcp_servers(id,user_id,scope,credential_slots)VALUES($1,$2,'user','[{\"id\":\"api_key\",\"target\":\"header\"}]')",[server,owner])
      await run('credential',scope,'mcp_connect')
      const prompt=(await pool.query('SELECT id,schema_json,expires_at FROM interaction_prompts')).rows[0],token='synthetic-native-secret-token'
      await pool.query(`INSERT INTO interaction_actions(prompt_id,token_hash,action_type,option_id,context_json,status,expires_at)VALUES($1,$2,'choice','input_credentials',$3,'pending',$4)`,[prompt.id,createHash('sha256').update(token).digest('hex'),prompt.schema_json.context,prompt.expires_at])
      assert.equal((await controls.consumeNativeAction(scope,prompt.id,'wrong-token',signal)).accepted,false)
      assert.equal((await pool.query('SELECT status FROM mcp_secret_inputs')).rows[0].status,'pending_choice')
      assert.equal((await controls.consumeNativeAction(scope,prompt.id,token,signal)).accepted,true)
      assert.equal((await controls.consumeNativeAction(scope,prompt.id,token,signal)).replayed,true)
      assert.equal((await pool.query('SELECT status FROM mcp_secret_inputs')).rows[0].status,'awaiting_secret')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,0)
    })
    await t.test('秘密引用解密await期间解绑，stage事务内实时owner复核拒绝推进且不耗原生token',async()=>{
      await reset();await pool.query("INSERT INTO user_mcp_servers(id,user_id,scope,credential_slots)VALUES($1,$2,'user','[{\"id\":\"api_key\",\"target\":\"header\"}]')",[server,owner])
      await run('credential',scope,'mcp_connect')
      const prompt=(await pool.query('SELECT id,schema_json,expires_at FROM interaction_prompts')).rows[0],token='synthetic-race-token'
      await pool.query(`INSERT INTO interaction_actions(prompt_id,token_hash,action_type,option_id,context_json,status,expires_at)VALUES($1,$2,'choice','input_credentials',$3,'pending',$4)`,[prompt.id,createHash('sha256').update(token).digest('hex'),prompt.schema_json.context,prompt.expires_at])
      beforeDecrypt=async()=>{beforeDecrypt=async()=>{};await pool.query("UPDATE user_bots SET owner_platform_user_id='9191'")}
      await assert.rejects(controls.consumeNativeAction(scope,prompt.id,token,signal),{message:'IM 凭据输入已结束或暂时无法处理'})
      assert.equal((await pool.query('SELECT status FROM mcp_secret_inputs')).rows[0].status,'pending_choice')
      assert.equal((await pool.query('SELECT status FROM interaction_actions')).rows[0].status,'pending')
    })
    await t.test('实际waiting checkpoint/prompt授权→微信文字选择与凭据说明，禁止任意prompt及撤权后出站',async()=>temporary(async root=>{
      for(const kind of ['question','credential'] as const){
        await reset()
        if(kind==='credential')await pool.query("INSERT INTO user_mcp_servers(id,user_id,scope,credential_slots)VALUES($1,$2,'user','[{\"id\":\"api_key\",\"target\":\"header\"}]')",[server,owner])
        const wxScope={...scope,platform:'wechat' as const},identity=await run(kind,wxScope,kind==='credential'?'mcp_connect':'ask_user_question')
        const route=await conversation.readRoute(identity)
        const access=createPostgresImAccess({query:(q,p)=>pool.query(q,p),supportedPlatforms:()=>['wechat']})
        const actor=await access.resolveActor({...wxScope,botMentioned:false,mentionsOtherBot:false}),wire=senderPlatform('wechat')
        const native=createPostgresImNativeInteractions({pool,secretKey,supportedPlatforms:()=>['wechat'],controls,readRoute:conversation.readRoute,sender:()=>wire.sender})
        try{
          const sender=await createImRunSender({...senderContext('wechat'),secretKey,identity,scope:wxScope,actor,payload:route.payload,pool,
            storageRoot:root,messageIds:['1'],files:createPostgresFileReadOperations(pool, root),sender:()=>wire.sender,
            authorize:()=>access.authorizeDelivery(actor),controls,nativeInteraction:native.interaction,publicAppUrl:'https://app.example'})
          const store=createPostgresAgentRunStore<string[]>(pool,secretKey,{async writeHistory(){throw new Error('等待Run不得终结历史')}})
          const event=(await store.readEventsAfter(identity,0)).find(e=>e.type==='interaction_required')!
          assert.ok(event);assert.equal((await store.read(identity))?.status,'waiting')
          const input={identity,deliveryId:`wx-${kind}`,event}
          assert.equal(deliveryOutcome(await sender.interaction(input)),'accepted')
          const sent=JSON.parse(String(wire.requests.at(-1)!.body)).msg
          assert.equal(sent.context_token,'synthetic-private-reply-context')
          const text=sent.item_list[0].text_item.text
          if(kind==='question'){assert.match(text,/1\. 继续/);assert.match(text,/自定义回复/)}
          else{assert.match(text,/https:\/\/app\.example\/\?mcp_credential_prompt=/);assert.doesNotMatch(text,/api_key|synthetic-private-secret/)}
          assert.doesNotMatch(text,/"token"|token_hash/)
          const count=wire.requests.length
          assert.equal(await sender.interaction({...input,deliveryId:'wrong',event:{...event,payload:{...event.payload,interactionId:'wrong-prompt'}}}),'rejected')
          await pool.query('UPDATE user_bots SET enabled=false')
          assert.equal(await sender.interaction({...input,deliveryId:'revoked'}),'rejected');assert.equal(wire.requests.length,count)
          if(kind==='question'){
            await pool.query('UPDATE user_bots SET enabled=true')
            assert.equal(await preflight('自定义回复',{...wxScope,eventId:'wechat-custom'}),'consumed')
            assert.equal(await preflight('合成自定义回答',{...wxScope,eventId:'wechat-custom-text'}),'consumed')
            assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_resumes')).rows[0].n,1)
          }
        }finally{await wire.close()}
      }
    }))
    await t.test('完整组合冻结并持久取消原Run，状态查询故障按旧优化语义回Run',async()=>{
      await reset();const identity=await run('question')
      assert.equal(await preflight('/stop',{...scope,eventId:'stop'}),'consumed')
      assert.equal(cancelled.has(identity.runId),true)
      assert.equal((await pool.query('SELECT cancel_requested FROM agent_run_dispatch')).rows[0].cancel_requested,true)
      assert.equal(replies[0]!.text,'🛑 已停止当前任务')
      await pool.query('DROP TABLE gugu_im_shortcut_controls')
      assert.equal(await controls.ports.decideShortcut(scope,'当前进度',signal).then(r=>r.action),'run')
      assert.ok(diagnostics.includes('shortcut_read_unavailable'))
    })
  }finally{
    for(const key of [`im:telegram-binding:${keyId}`,`im:telegram-binding-attempts:${keyId}:synthetic-${keyId}`])await redis.sendCommand(['EVAL',"return redis.call('DEL',KEYS[1])",'1',key])
    await redis.close();await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()
  }
})
