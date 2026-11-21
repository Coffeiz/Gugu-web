import assert from 'node:assert/strict'
import type {LightMyRequestResponse} from 'fastify'
import { randomUUID,createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../../../src/modules/auth/session/token.js'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createRedisLiveSubscription } from '../../../../src/adapters/cache/redis-live-subscription.js'
import { createRedisAgentCancellationCommands,createRedisFilesystemAuthorizationCommands } from '../../../../src/adapters/cache/redis-events.js'
import { startServer } from '../../../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test('生产Host鉴权后执行审计、通知历史、用户设置与引导重置', {
  skip: !databaseUrl && '需要隔离PostgreSQL',
}, async () => {
  const schema = `admin_settings_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-settings-'))
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString(), max: 1 })
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  await admin.query(`CREATE SCHEMA "${schema}"`)
  try {
    const overridePath = join(root, 'config.json')
    await writeFile(overridePath, '{}')
    await pool.query('CREATE TABLE audit_logs(id serial PRIMARY KEY,username varchar(100) NOT NULL,action varchar(50) NOT NULL,description text NOT NULL,ip varchar(60),created_at timestamptz NOT NULL)')
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY, username varchar(100) NOT NULL, is_developer boolean NOT NULL DEFAULT false, token_limit_6h bigint, token_limit_weekly bigint, storage_limit_bytes bigint, search_limit_daily integer)')
    await pool.query('CREATE TABLE site_notifications(id serial PRIMARY KEY,title text NOT NULL,content text NOT NULL,color text NOT NULL,target text NOT NULL,created_at timestamptz NOT NULL,created_by text NOT NULL)')
    const userId = '00000000-0000-4000-8000-000000000031'
    await pool.query("INSERT INTO users(id,username) VALUES ($1,'小北')", [userId])
    await pool.query("INSERT INTO site_notifications(title,content,color,target,created_at,created_by) VALUES ('公告','合成通知','blue','all','2026-11-14T01:02:03.123456Z','admin'),('任务','合成任务','blue','all','2026-11-14T02:00:00Z','task')")
    host = await startServer({ GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: 'synthetic-admin-settings-secret',
      GUGU_CONFIG_OVERRIDE_FILE: overridePath, STORAGE__LOCAL_PATH: join(root, 'storage'), GUGU_WEBUI_HOST: '127.0.0.1',
      GUGU_WEBUI_PORT: String(await freePort()), GUGU_WEBUI_REDIS_URL: redisUrl ?? '', ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password' })
    const endpoints = [
      {method:'GET' as const,url:'/api/v1/admin/audit-log'},
      {method:'GET' as const,url:'/api/v1/admin/notifications/history'},
      {method:'DELETE' as const,url:'/api/v1/admin/notifications/history/1'},
      {method:'PATCH' as const,url:`/api/v1/admin/users/${userId}/quota`, payload:{token_limit_6h:100}},
      {method:'PATCH' as const,url:`/api/v1/admin/users/${userId}/developer`},
    ]
    for (const endpoint of endpoints) assert.equal((await host.app.inject(endpoint)).statusCode,401)
    const login = await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
    assert.equal(login.statusCode,200)
    const headers = {authorization:`Bearer ${login.json().access_token}`}
    const history = await host.app.inject({...endpoints[1]!,headers})
    assert.equal(history.statusCode,200)
    assert.deepEqual(history.json().map((row:{title:string}) => row.title),['公告'])
    assert.equal((await host.app.inject({...endpoints[2]!,headers})).statusCode,200)
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM site_notifications')).rows[0].count,1)
    const quota = await host.app.inject({...endpoints[3]!,headers})
    assert.equal(quota.statusCode,200)
    assert.equal(quota.json().token_limit_6h,100)
    const developer = await host.app.inject({...endpoints[4]!,headers})
    assert.equal(developer.statusCode,200)
    assert.equal(developer.json().is_developer,true)
    const stored = (await pool.query('SELECT token_limit_6h,is_developer FROM users WHERE id=$1',[userId])).rows[0]
    assert.equal(Number(stored.token_limit_6h),100)
    assert.equal(stored.is_developer,true)
    await pool.query(`ALTER TABLE users ADD COLUMN display_name text, ADD COLUMN email text DEFAULT 'synthetic@example.invalid', ADD COLUMN is_active boolean DEFAULT true, ADD COLUMN account_status text DEFAULT 'active', ADD COLUMN security_version integer DEFAULT 1, ADD COLUMN avatar text, ADD COLUMN created_at timestamptz DEFAULT CURRENT_TIMESTAMP, ADD COLUMN timezone text, ADD COLUMN email_subscribed boolean DEFAULT false, ADD COLUMN last_active_at timestamptz`)
    await pool.query('CREATE TABLE user_bots(id serial PRIMARY KEY,user_id uuid,platform text,enabled boolean)')
    await pool.query('CREATE TABLE onboarding_state(user_id uuid PRIMARY KEY,state json NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL)')
    const resetPath = '/api/v1/onboarding/dev/reset-guide'
    assert.equal((await host.app.inject({method:'POST',url:resetPath})).statusCode,401)
    const userToken = createUserToken(userId,1,'synthetic-admin-settings-secret')
    assert.equal((await host.app.inject('/api/v1/mcp/status')).statusCode,401)
    const mcpHeaders = {authorization:`Bearer ${userToken}`}
    const initialMcp = await host.app.inject({url:'/api/v1/mcp/status',headers:mcpHeaders})
    assert.equal(initialMcp.statusCode,200,initialMcp.body)
    assert.deepEqual(initialMcp.json(),{enabled:true})
    await writeFile(overridePath,JSON.stringify({mcp:{enabled:false}}))
    assert.deepEqual((await host.app.inject({url:'/api/v1/mcp/status',headers:mcpHeaders})).json(),{enabled:false})
    await writeFile(overridePath,JSON.stringify({mcp:{enabled:true}}))
    assert.deepEqual((await host.app.inject({url:'/api/v1/mcp/status',headers:mcpHeaders})).json(),{enabled:true})
    await writeFile(overridePath,'{}')
    const reset = await host.app.inject({method:'POST',url:resetPath,headers:{authorization:`Bearer ${userToken}`}})
    assert.equal(reset.statusCode,200,reset.body)
    assert.equal(reset.json().state.should_show,true)
    assert.equal((await pool.query('SELECT state FROM onboarding_state WHERE user_id=$1',[userId])).rows[0].state.guide.enabled,true)
    if (redisUrl) {
      const noRedisHost = await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:'synthetic-admin-settings-secret',GUGU_CONFIG_OVERRIDE_FILE:overridePath,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
      try {
        const unavailableStatus = await noRedisHost.app.inject({url:'/api/v1/byok/embedding-rebuild/status',headers:{authorization:`Bearer ${userToken}`}})
        assert.equal(unavailableStatus.statusCode,503,unavailableStatus.body)
        assert.notDeepEqual(unavailableStatus.json(),{status:'idle'})
        const noRedisLogin:LightMyRequestResponse=await noRedisHost.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
        assert.equal(noRedisLogin.statusCode,200)
        assert.equal((await noRedisHost.app.inject({url:'/api/v1/admin/config/embedding-rebuild/status',headers:{authorization:`Bearer ${noRedisLogin.json().access_token}`}})).statusCode,503)
        const noRedisEvents:LightMyRequestResponse=await noRedisHost.app.inject({url:'/api/v1/admin/filesync/events',headers:{authorization:`Bearer ${noRedisLogin.json().access_token}`}})
        assert.equal(noRedisEvents.statusCode,200);assert.equal(noRedisEvents.body,': live connection reset; client will reconnect\n\n')
      } finally {await noRedisHost.close()}
      const statusRedis = createRedisAgentCancellationCommands(redisUrl)
      const statusCleanup = createRedisFilesystemAuthorizationCommands(redisUrl)
      const statusKey = `emb:rebuild:user:${userId}`
      const foreignStatusKey = `emb:rebuild:user:${randomUUID()}`
      try {
        await statusRedis.set(foreignStatusKey,JSON.stringify({status:'error',message:'其他用户状态'}),60)
        const idleStatus = await host.app.inject({url:'/api/v1/byok/embedding-rebuild/status',headers:{authorization:`Bearer ${userToken}`}})
        assert.equal(idleStatus.statusCode,200,idleStatus.body)
        assert.deepEqual(idleStatus.json(),{status:'idle'})
        const workerStatus = {status:'done',done:1,total:1,with_patterns:1,pattern_vectors:7,memory_vectors:9,failed_users:0,message:'重建完成',ts:123}
        await statusRedis.set(statusKey,JSON.stringify(workerStatus),60)
        const progress = await host.app.inject({url:'/api/v1/byok/embedding-rebuild/status?user_id=foreign',headers:{authorization:`Bearer ${userToken}`}})
        assert.equal(progress.statusCode,200,progress.body)
        assert.deepEqual(progress.json(),workerStatus)
        await statusRedis.set(statusKey,JSON.stringify({status:'error',message:'失败 /tmp/synthetic-error token=syntheticsecretvalue',ts:124}),60)
        const failedStatus = await host.app.inject({url:'/api/v1/byok/embedding-rebuild/status',headers:{authorization:`Bearer ${userToken}`}})
        assert.equal(failedStatus.statusCode,200)
        assert.equal(failedStatus.json().status,'error')
        assert.equal(failedStatus.body.includes('synthetic-error'),false)
        assert.equal(failedStatus.body.includes('syntheticsecretvalue'),false)
        assert.equal((await host.app.inject('/api/v1/byok/embedding-rebuild/status')).statusCode,401)
      } finally {await statusCleanup.del(statusKey,foreignStatusKey)}
      const adminStatusUrl='/api/v1/admin/config/embedding-rebuild/status'
      try{
        await statusCleanup.del('emb:rebuild')
        assert.equal((await host.app.inject(adminStatusUrl)).statusCode,401)
        assert.equal((await host.app.inject({url:adminStatusUrl,headers:mcpHeaders})).statusCode,403)
        assert.deepEqual((await host.app.inject({url:adminStatusUrl,headers})).json(),{status:'idle'})
        const platformProgress={status:'running',done:7,total:12,tag:'synthetic-model',message:'进度 /tmp/synthetic-progress',ts:321}
        await statusRedis.set('emb:rebuild',JSON.stringify(platformProgress),60)
        const platformStatus:LightMyRequestResponse=await host.app.inject({url:adminStatusUrl,headers})
        assert.equal(platformStatus.statusCode,200,platformStatus.body);assert.deepEqual(platformStatus.json(),platformProgress)
        // 平台全局键不可被用户状态键或查询中的 owner 替换。
        await statusRedis.set(statusKey,JSON.stringify({status:'done',done:999}),60)
        assert.deepEqual((await host.app.inject({url:adminStatusUrl+'?user_id=foreign',headers})).json(),platformProgress)
        await statusRedis.set('emb:rebuild',JSON.stringify({status:'error',message:'失败 /tmp/synthetic-error token=syntheticsecretvalue',ts:322}),60)
        const platformFailure:LightMyRequestResponse=await host.app.inject({url:adminStatusUrl,headers})
        assert.equal(platformFailure.statusCode,200);assert.equal(platformFailure.json().status,'error');assert.equal(platformFailure.json().ts,322)
        assert.doesNotMatch(platformFailure.body,/synthetic-error|syntheticsecretvalue/)
      }finally{await statusCleanup.del('emb:rebuild',statusKey)}
      const python = process.env.GUGU_WEBUI_TEST_PYTHON
      assert.ok(python,'实际schema验证需要显式测试Python')
      const memoryDdl=execFileSync(python,['-c',"from app.models import MemoryReflectionCursor,MemoryScopeTombstone,MemoryEntry,MemoryReflectionJob; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [MemoryReflectionCursor,MemoryScopeTombstone,MemoryEntry,MemoryReflectionJob]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}})
      await pool.query(memoryDdl)
      await pool.query("INSERT INTO memory_reflection_cursors(owner_user_id,platform,bot_id,scope_type,scope_id,last_message_id,last_reflected_message_id,scope_version,pending_passive_count,pending_agent_count,created_at,updated_at) VALUES($1,'qq','private-bot','group','private-group',12,8,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[userId])
      for(const [method,url] of [['GET','/api/v1/admin/agent/memory/im-scopes'],['POST','/api/v1/admin/agent/memory/im-scopes/maintenance/preview']] as const){
        assert.equal((await host.app.inject({method,url})).statusCode,401)
        assert.equal((await host.app.inject({method,url,headers:mcpHeaders})).statusCode,403)
        const summary:LightMyRequestResponse=await host.app.inject({method,url,headers})
        assert.equal(summary.statusCode,200,summary.body)
        assert.deepEqual(summary.json(),{total_scopes:1,groups:1,members:0,total_entries:0,pending_jobs:0,needs_maintenance:1,failed_jobs:0,platforms:[{platform:'qq',scopes:1,groups:1,members:0,entries:0}]})
        assert.doesNotMatch(summary.body,/private-|00000000/)
      }
      const ddl = execFileSync(python,['-c',"from app.models import UserSkill; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(CreateTable(UserSkill.__table__).compile(dialect=postgresql.dialect()))"],{
        encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'},
      })
      await pool.query(ddl)
      await pool.query("INSERT INTO user_skills(owner_id,skill_id,name,description_short,category,body,related_tools,source,managed_by,enabled,content_digest,created_at,updated_at) VALUES($1,'U1','合成技能','合成指导','personal','合成正文','[]'::json,'user','user',true,'synthetic',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[userId])
      await pool.query('CREATE TABLE conversation_sessions(id integer PRIMARY KEY)')
      await pool.query('CREATE TABLE user_mcp_servers(id uuid PRIMARY KEY)')
      const secretDdl=execFileSync(python,['-c',"from app.models import InteractionRequest,McpSecretInput; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [InteractionRequest,McpSecretInput]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}})
      await pool.query(secretDdl)
      await pool.query('INSERT INTO conversation_sessions VALUES(991)')
      const secretServerId=randomUUID(),foreignPromptOwner=randomUUID()
      await pool.query('INSERT INTO user_mcp_servers VALUES($1)',[secretServerId]);await pool.query("INSERT INTO users(id,username) VALUES($1,'合成另一个用户')",[foreignPromptOwner])
      const secretSchema={secret_fields:[{name:'key',type:'secret'}],context:{secret_target:{kind:'mcp_credentials',server_id:secretServerId}}}
      for(const [id,owner] of [[991,userId],[992,foreignPromptOwner]] as const)await pool.query("INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES($1,$2,991,'form','补全凭据','合成正文',$3::json,'active',clock_timestamp()+interval '1 hour',clock_timestamp())",[id,owner,JSON.stringify(secretSchema)])
      await pool.query("INSERT INTO mcp_secret_inputs(prompt_id,user_id,server_id,session_id,platform,bot_id,chat_type,platform_user_id,status,next_field_index,consumed_event_ids,encrypted_payload,payload_nonce,encrypted_data_key,key_version,expires_at,created_at,updated_at) VALUES(991,$1,$2,991,'feishu','bot','c2c','actor','awaiting_secret',0,'[]'::json,'synthetic-cipher','synthetic-nonce','synthetic-wrapped',1,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())",[userId,secretServerId])
      const secretPath='/api/v1/agent/interactions/991/secrets/cancel'
      assert.equal((await host.app.inject({method:'POST',url:secretPath})).statusCode,401)
      assert.equal((await host.app.inject({method:'POST',url:'/api/v1/agent/interactions/992/secrets/cancel',headers:mcpHeaders})).statusCode,404)
      const cancelledSecret:LightMyRequestResponse=await host.app.inject({method:'POST',url:secretPath,headers:mcpHeaders})
      assert.equal(cancelledSecret.statusCode,200,cancelledSecret.body);assert.deepEqual(cancelledSecret.json(),{ok:true,prompt_id:991,status:'cancelled'})
      assert.equal((await host.app.inject({method:'POST',url:secretPath,headers:mcpHeaders})).statusCode,409)
      const wipedSecret=(await pool.query('SELECT status,encrypted_payload,payload_nonce,encrypted_data_key FROM mcp_secret_inputs WHERE prompt_id=991')).rows[0]
      assert.deepEqual(wipedSecret,{status:'cancelled',encrypted_payload:'',payload_nonce:'',encrypted_data_key:''})
      const waiterScript="import asyncio,json,os; from uuid import UUID; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.db import session as sessions; from app.services.interactions import wait_for_resolution\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n sessions.ensure_engine=lambda:None; sessions._SessionLocal=async_sessionmaker(engine)\n try: print(json.dumps(await wait_for_resolution(user_id=UUID(os.environ['TEST_OWNER']),prompt_id=991,timeout_seconds=1),ensure_ascii=False))\n finally: await engine.dispose()\nasyncio.run(scenario())"
      const waited=JSON.parse(execFileSync(python,['-c',waiterScript],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:userId}}))
      assert.deepEqual(waited,{kind:'form',status:'cancelled',prompt_id:991,option_id:'cancel',value:null,text:'已取消凭据输入'})

      const credentialDdl = execFileSync(python,['-c',"from app.models import UserProviderCredential, ProviderReasoningState; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [UserProviderCredential,ProviderReasoningState]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}})
      await pool.query(credentialDdl)
      await pool.query("INSERT INTO user_provider_credentials(user_id,provider,api_format,capability,encrypted_value,nonce,encrypted_data_key,key_version,base_url,model,image,video,audio,image_detail,enabled,created_at,updated_at) VALUES($1,'synthetic','openai','llm','synthetic','synthetic','synthetic',1,'','synthetic',false,false,false,'auto',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[userId])
      await pool.query('INSERT INTO conversation_sessions VALUES(1)')
      await pool.query("INSERT INTO provider_reasoning_states(user_id,session_id,provider,api_format,model_id,reasoning_persistence,config_digest,reasoning_config_digest,source_run_id,state_kind,encrypted_payload,payload_nonce,encrypted_data_key,payload_digest,created_at,last_used_at,expires_at,updated_at) VALUES($1,1,'synthetic','openai','synthetic','continuation','synthetic','synthetic','synthetic','synthetic','synthetic','synthetic','synthetic','synthetic',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 hour',CURRENT_TIMESTAMP)",[userId])
      await writeFile(overridePath,JSON.stringify({byok:{enabled:false},ai:{deployment_mode:'cloud'}}))
      const disabledByok = await host.app.inject({method:'DELETE',url:'/api/v1/byok/1',headers:{authorization:`Bearer ${userToken}`}})
      assert.equal(disabledByok.statusCode,403,disabledByok.body)
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_provider_credentials')).rows[0].count,1)
      await writeFile(overridePath,JSON.stringify({byok:{enabled:false},ai:{deployment_mode:'local'}}))
      const deletedCredential = await host.app.inject({method:'DELETE',url:'/api/v1/byok/1',headers:{authorization:`Bearer ${userToken}`}})
      assert.equal(deletedCredential.statusCode,204,deletedCredential.body)
      const stateAfterCredential = (await pool.query('SELECT status,encrypted_payload,version FROM provider_reasoning_states')).rows[0]
      assert.equal(stateAfterCredential.status,'invalidated')
      assert.equal(stateAfterCredential.encrypted_payload,'')
      assert.equal(stateAfterCredential.version,2)
      await writeFile(overridePath,'{}')
      await pool.query('CREATE TABLE workspaces(id integer PRIMARY KEY)')
      const syncDdl=execFileSync(python,['-c',"from app.models import FileSyncBinding,FileSyncReconcileRun; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [FileSyncBinding,FileSyncReconcileRun]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}})
      await pool.query(syncDdl)
      await pool.query("INSERT INTO file_sync_bindings(id,user_id,source,root_fingerprint,created_at,updated_at) VALUES(1,$1,'local_directory','private-root',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[userId])
      const adminEventsPath='/api/v1/admin/filesync/events'
      assert.equal((await host.app.inject(adminEventsPath)).statusCode,401)
      assert.equal((await host.app.inject({url:adminEventsPath,headers:mcpHeaders})).statusCode,403)
      const streamAddress=host.app.server.address()
      assert.ok(streamAddress&&typeof streamAddress!=='string')
      const streamAbort=new AbortController()
      const pythonEventEnv={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}
      const subscriberScript="import asyncio,os; import redis.asyncio as redis\nasync def scenario():\n client=redis.from_url(os.environ['GUGU_WEBUI_TEST_REDIS_URL'])\n try: print((await client.pubsub_numsub('events:filesync-admin'))[0][1])\n finally: await client.aclose()\nasyncio.run(scenario())"
      const subscriberCount=()=>Number(execFileSync(python,['-c',subscriberScript],{encoding:'utf8',cwd:resolve('../../backend'),env:pythonEventEnv}).trim())
      const beforeSubscribers=subscriberCount()
      try{
        const streamResponse=await fetch(`http://127.0.0.1:${streamAddress.port}${adminEventsPath}`,{headers,signal:AbortSignal.any([streamAbort.signal,AbortSignal.timeout(10000)])})
        assert.equal(streamResponse.status,200);assert.equal(streamResponse.headers.get('content-type'),'text/event-stream; charset=utf-8')
        const streamReader=streamResponse.body!.getReader(),decoder=new TextDecoder()
        let frames=decoder.decode((await streamReader.read()).value)
        assert.match(frames,/: connected/);assert.equal(subscriberCount(),beforeSubscribers+1)
        const publisher="import asyncio,os; import redis.asyncio as redis; from app.core import events\nasync def scenario():\n client=redis.from_url(os.environ['GUGU_WEBUI_TEST_REDIS_URL'])\n events.get_redis=lambda:client\n try:\n  await events.publish_filesync_run_changed(run_id='synthetic-run',binding_id=1,revision=7)\n  await events.publish_filesync_binding_health_changed(binding_id=1,revision=8)\n finally: await client.aclose()\nasyncio.run(scenario())"
        execFileSync(python,['-c',publisher],{encoding:'utf8',cwd:resolve('../../backend'),env:pythonEventEnv})
        while(!frames.includes('filesync.binding.health.changed')){const chunk=await streamReader.read();assert.equal(chunk.done,false);frames+=decoder.decode(chunk.value)}
        const received=frames.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)))
        assert.equal(received.length,2);assert.equal(received[0].run_id,'synthetic-run');assert.equal(received[0].revision,7);assert.equal(received[1].revision,8)
        assert.doesNotMatch(frames,/root_path|relative_path|user_id/)
        streamAbort.abort();await streamReader.cancel().catch(()=>undefined)
      }finally{streamAbort.abort()}
      // 空闲断开必须释放实际 Redis SUBSCRIBE，不能等下一条消息才清理。
      for(let attempt=0;attempt<10&&subscriberCount()>beforeSubscribers;attempt++)await new Promise(resolve=>setTimeout(resolve,20))
      assert.equal(subscriberCount(),beforeSubscribers)
      const syncId=randomUUID(),syncPath='/api/v1/admin/filesync/runs'
      await pool.query("INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,status,stage,root_fingerprint,lease_owner,result_counts,error_code,created_at,updated_at) VALUES($1,$2,1,'dry_run','succeeded','done','private-root','private-worker','{\"created\":2}'::json,'scan_failed','2026-11-15T01:00:00.123456Z',CURRENT_TIMESTAMP)",[syncId,userId])
      for(const url of [syncPath,syncPath+'/'+syncId]){
        assert.equal((await host.app.inject(url)).statusCode,401)
        assert.equal((await host.app.inject({url,headers:mcpHeaders})).statusCode,403)
      }
      const syncRuns:LightMyRequestResponse=await host.app.inject({url:syncPath+'?user_id='+userId+'&binding_id=1&limit=1',headers})
      assert.equal(syncRuns.statusCode,200,syncRuns.body);assert.equal(syncRuns.json().length,1)
      const syncRun:LightMyRequestResponse=await host.app.inject({url:syncPath+'/'+syncId,headers})
      assert.equal(syncRun.statusCode,200,syncRun.body);assert.deepEqual(syncRun.json(),syncRuns.json()[0])
      assert.equal(syncRun.json().createdAt,'2026-11-15T01:00:00.123456+00:00');assert.doesNotMatch(syncRun.body,/private-root|private-worker|user_id/)
      assert.equal((await host.app.inject({url:syncPath+'/'+randomUUID(),headers})).statusCode,404)
      assert.equal((await host.app.inject({url:syncPath+'?limit=101',headers})).statusCode,422)
      const cancelSyncId=randomUUID(),cancelSyncPath=syncPath+'/'+cancelSyncId+'/cancel'
      await pool.query("INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,status,root_fingerprint,created_at,updated_at) VALUES($1,$2,1,'dry_run','queued','synthetic-root',clock_timestamp(),clock_timestamp())",[cancelSyncId,userId])
      assert.equal((await host.app.inject({method:'POST',url:cancelSyncPath})).statusCode,401)
      assert.equal((await host.app.inject({method:'POST',url:cancelSyncPath,headers:mcpHeaders})).statusCode,403)
      const cancelStreamAbort=new AbortController()
      try{
        const cancelStream=await fetch(`http://127.0.0.1:${streamAddress.port}${adminEventsPath}`,{headers,signal:AbortSignal.any([cancelStreamAbort.signal,AbortSignal.timeout(10000)])})
        const reader=cancelStream.body!.getReader(),decoder=new TextDecoder()
        let frames=decoder.decode((await reader.read()).value)
        const cancelledRun:LightMyRequestResponse=await host.app.inject({method:'POST',url:cancelSyncPath,headers})
        assert.equal(cancelledRun.statusCode,200,cancelledRun.body);assert.equal(cancelledRun.json().status,'cancelled');assert.equal(cancelledRun.json().revision,1)
        while(!frames.includes('filesync.run.changed')){const chunk=await reader.read();assert.equal(chunk.done,false);frames+=decoder.decode(chunk.value)}
        const event=JSON.parse(frames.split('\n').find(line=>line.startsWith('data: '))!.slice(6))
        assert.equal(event.run_id,cancelSyncId);assert.equal(event.binding_id,1);assert.equal(event.revision,1)
        assert.doesNotMatch(frames,/root_path|relative_path|user_id/)
        cancelStreamAbort.abort();await reader.cancel().catch(()=>undefined)
      }finally{cancelStreamAbort.abort()}
      const repeatedCancel:LightMyRequestResponse=await host.app.inject({method:'POST',url:cancelSyncPath,headers})
      assert.equal(repeatedCancel.statusCode,200);assert.equal(repeatedCancel.json().revision,1)
      const runningSyncId=randomUUID()
      await pool.query("INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,status,root_fingerprint,lease_owner,created_at,updated_at) VALUES($1,$2,1,'dry_run','running','synthetic-root','synthetic-worker',clock_timestamp(),clock_timestamp())",[runningSyncId,userId])
      const runningCancel:LightMyRequestResponse=await host.app.inject({method:'POST',url:syncPath+'/'+runningSyncId+'/cancel',headers})
      assert.equal(runningCancel.statusCode,200,runningCancel.body);assert.equal(runningCancel.json().status,'cancelling');assert.equal(runningCancel.json().cancelRequested,true)
      const cancellationConsumer="import asyncio,json,os; from uuid import UUID; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.services.filesync import jobs\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n async def notify(*args,**kwargs): pass\n jobs.notify_run_changed=notify\n try:\n  async with async_sessionmaker(engine)() as db:\n   requested=await jobs.cancellation_requested(db,UUID(os.environ['TEST_RUN']),'synthetic-worker')\n   finished=await jobs.finish_run(db,UUID(os.environ['TEST_RUN']),'synthetic-worker',status='succeeded')\n   row=await jobs.get_reconcile_run(db,UUID(os.environ['TEST_RUN']))\n   print(json.dumps({'requested':requested,'finished':finished,'status':row.status}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
      const consumedCancellation=JSON.parse(execFileSync(python,['-c',cancellationConsumer],{encoding:'utf8',cwd:resolve('../../backend'),env:{...pythonEventEnv,TEST_SCHEMA:schema,TEST_RUN:runningSyncId}}))
      assert.deepEqual(consumedCancellation,{requested:true,finished:true,status:'cancelled'})
      const noRedisCancelId=randomUUID()
      await pool.query("INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,status,root_fingerprint,created_at,updated_at) VALUES($1,$2,1,'dry_run','queued','synthetic-root',clock_timestamp(),clock_timestamp())",[noRedisCancelId,userId])
      const cancellationWithoutRedis=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:'synthetic-admin-settings-secret',GUGU_CONFIG_OVERRIDE_FILE:overridePath,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
      try{
        const loginWithoutRedis:LightMyRequestResponse=await cancellationWithoutRedis.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
        assert.equal(loginWithoutRedis.statusCode,200)
        const noRedisCancellation:LightMyRequestResponse=await cancellationWithoutRedis.app.inject({method:'POST',url:syncPath+'/'+noRedisCancelId+'/cancel',headers:{authorization:`Bearer ${loginWithoutRedis.json().access_token}`}})
        assert.equal(noRedisCancellation.statusCode,200,noRedisCancellation.body);assert.equal(noRedisCancellation.json().status,'cancelled')
        assert.equal((await pool.query('SELECT status FROM file_sync_reconcile_runs WHERE id=$1',[noRedisCancelId])).rows[0].status,'cancelled')
      }finally{await cancellationWithoutRedis.close()}



      const taskAuthDdl = execFileSync(python,['-c',"from app.models import FilesystemAuthorizationGrant,SecurityEvent,ScheduledTask; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [FilesystemAuthorizationGrant,SecurityEvent,ScheduledTask]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}})
      await pool.query(taskAuthDdl)
      await pool.query("INSERT INTO filesystem_authorization_grants(user_id,subject_type,subject_id,granted_at,created_at,updated_at) VALUES($1,'scheduled_task','1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[userId])
      await pool.query("INSERT INTO scheduled_tasks(user_id,name,payload,cron,channels,enabled,filesystem_authorization_grant_id,created_at,updated_at) VALUES($1,'合成任务','','0 0 * * *','web',true,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[userId])
      const authSummary='允许定时任务「合成任务」读写整个用户沙箱（包含 /workspace、/personal、/project）'
      const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
      const authSuffix=`${userId}:${hash(authSummary)}:${hash('scheduled-task:filesystem:1')}`
      const confirmationKeys=[`agent:confirm-req:${authSuffix}`,`agent:confirm-grant:${authSuffix}`,`agent:confirm-code:${userId}:abcdef123456`]
      const confirmationRedis=createRedisAgentCancellationCommands(redisUrl)
      const metricCommands=createRedisFilesystemAuthorizationCommands(redisUrl)
      const metricKey=`ops:filesystem-auth:${new Date().toISOString().slice(0,10).replaceAll('-','')}`
      const readMetric=async()=>Number(await metricCommands.eval("return redis.call('HGET',KEYS[1],ARGV[1]) or '0'",1,metricKey,'scheduled_task:revoked'))
      const metricBefore=await readMetric()
      try {
        for(let index=0;index<confirmationKeys.length;index++)await confirmationRedis.set(confirmationKeys[index]!,index===0?'abcdef123456':'1',60)
        assert.equal((await host.app.inject({method:'DELETE',url:'/api/v1/scheduled-tasks/1/filesystem-authorization'})).statusCode,401)
        const revokedTask=await host.app.inject({method:'DELETE',url:'/api/v1/scheduled-tasks/1/filesystem-authorization',headers:{authorization:`Bearer ${userToken}`}})
        assert.equal(revokedTask.statusCode,200,revokedTask.body)
        assert.deepEqual(revokedTask.json(),{status:'revoked',task_id:1,revoked:true})
        for(const key of confirmationKeys)assert.equal(await confirmationRedis.get(key),null)
        assert.equal((await pool.query('SELECT filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=1')).rows[0].filesystem_authorization_grant_id,null)
        assert.ok((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=1')).rows[0].revoked_at)
        const authEvent=(await pool.query("SELECT reason_code,metadata_json FROM security_events WHERE user_id=$1 AND event_type='filesystem.authorization'",[userId])).rows
        assert.equal(authEvent.length,1)
        assert.equal(authEvent[0].reason_code,'revoked')
        assert.equal(authEvent[0].metadata_json.subject_type,'scheduled_task')
        assert.equal(await readMetric(),metricBefore+1)
        const metricTtl=Number(await metricCommands.eval("return redis.call('TTL',KEYS[1])",1,metricKey))
        assert.ok(metricTtl>0&&metricTtl<=14*24*60*60)
        const repeatedRevoke=await host.app.inject({method:'DELETE',url:'/api/v1/scheduled-tasks/1/filesystem-authorization',headers:{authorization:`Bearer ${userToken}`}})
        assert.deepEqual(repeatedRevoke.json(),{status:'revoked',task_id:1,revoked:false})
        assert.equal(await readMetric(),metricBefore+1)
        const readAuthMetric=async(outcome:string)=>Number(await metricCommands.eval("return redis.call('HGET',KEYS[1],ARGV[1]) or '0'",1,metricKey,`scheduled_task:${outcome}`))
        const requestedBefore=await readAuthMetric('requested'),grantedBefore=await readAuthMetric('granted')
        await writeFile(overridePath,JSON.stringify({sandbox:{full_user_sandbox_authorization_enabled:false}}))
        const authPath='/api/v1/scheduled-tasks/1/filesystem-authorization'
        const authHeaders={authorization:`Bearer ${userToken}`}
        assert.equal((await host.app.inject({method:'POST',url:`${authPath}/request`,headers:authHeaders})).statusCode,409)
        await writeFile(overridePath,JSON.stringify({storage:{backend:'local'},sandbox:{full_user_sandbox_authorization_enabled:true}}))
        const pendingTask=await host.app.inject({method:'POST',url:`${authPath}/request`,headers:authHeaders})
        assert.equal(pendingTask.statusCode,200,pendingTask.body)
        assert.equal(pendingTask.json().status,'waiting_confirmation')
        assert.equal(pendingTask.json().authorization_ttl_minutes,10)
        const confirmedTask=await host.app.inject({method:'POST',url:authPath,headers:authHeaders,payload:{confirm_code:pendingTask.json().confirm_code}})
        assert.equal(confirmedTask.statusCode,200,confirmedTask.body)
        assert.equal(confirmedTask.json().status,'authorized')
        assert.equal((await pool.query('SELECT filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=1')).rows[0].filesystem_authorization_grant_id,confirmedTask.json().grant_id)
        assert.equal(await readAuthMetric('requested'),requestedBefore+1)
        assert.equal(await readAuthMetric('granted'),grantedBefore+1)
        assert.equal((await pool.query("SELECT count(*)::integer AS count FROM security_events WHERE reason_code='granted'")).rows[0].count,1)
        assert.equal((await host.app.inject({method:'POST',url:authPath,headers:authHeaders,payload:{confirm_code:pendingTask.json().confirm_code}})).statusCode,400)
        const policyScript="import asyncio,json,os; from uuid import UUID; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.services.filesystem_authorization import resolve_filesystem_policy\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['GUGU_POLICY_TEST_SCHEMA']}})\n try:\n  async with async_sessionmaker(engine)() as db:\n   policy=await resolve_filesystem_policy(db,UUID(os.environ['GUGU_POLICY_TEST_OWNER']),subject_type='scheduled_task',subject_id=1)\n   print(json.dumps({'full_user_sandbox':policy.full_user_sandbox,'grant_id':policy.grant_id}))\n finally:\n  await engine.dispose()\nasyncio.run(scenario())"
        const actualPolicy=JSON.parse(execFileSync(python,['-c',policyScript],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:overridePath,PYTHONPATH:'.',GUGU_POLICY_TEST_SCHEMA:schema,GUGU_POLICY_TEST_OWNER:userId}}))
        assert.deepEqual(actualPolicy,{full_user_sandbox:true,grant_id:confirmedTask.json().grant_id})
        await writeFile(overridePath,'{}')

      } finally {await createRedisFilesystemAuthorizationCommands(redisUrl).del(...confirmationKeys)}
      await pool.query('CREATE TABLE conversation_messages(id integer PRIMARY KEY)')
      const attachmentDdl=execFileSync(python,['-c',"from app.models import ChatAttachment; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(CreateTable(ChatAttachment.__table__).compile(dialect=postgresql.dialect()))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}})
      await pool.query(attachmentDdl)
      const attachmentKey=`${userId}/.chat_staging/sample.txt`
      await mkdir(join(root,'storage',userId,'.chat_staging'),{recursive:true})
      await writeFile(join(root,'storage',attachmentKey),'合成下载')
      await pool.query("INSERT INTO chat_attachments(attach_id,user_id,storage_key,name,ext,mime,kind,size,state,created_at) VALUES('prod-attachment',$1,$2,'合成 文件','txt','text/plain','binary',12,'draft',CURRENT_TIMESTAMP)",[userId,attachmentKey])
      const legacyAttachmentKey=`chatfile:${userId}:legacy-attachment`
      try {
        await confirmationRedis.set(legacyAttachmentKey,JSON.stringify({name:'旧附件',ext:'txt',mime:'text/plain',size:12,storage_key:attachmentKey}),60)
        assert.equal((await host.app.inject('/api/v1/agent/attachment/prod-attachment/download')).statusCode,401)
        for(const attachmentId of ['prod-attachment','legacy-attachment']){
          const downloaded:LightMyRequestResponse=await host.app.inject({url:`/api/v1/agent/attachment/${attachmentId}/download`,headers:{authorization:`Bearer ${userToken}`}})
          assert.equal(downloaded.statusCode,200,downloaded.body)
          assert.equal(downloaded.body,'合成下载')
          assert.equal(downloaded.headers['content-length'],'12')
          assert.equal(downloaded.headers['content-type'],'text/plain; charset=utf-8')
        }
        assert.equal((await host.app.inject({url:'/api/v1/agent/attachment/missing-attachment/download',headers:{authorization:`Bearer ${userToken}`}})).statusCode,404)
      } finally {await createRedisFilesystemAuthorizationCommands(redisUrl).del(legacyAttachmentKey)}
      const terminalDdl=execFileSync(python,['-c',"from app.models import TerminalSessionRecord,TerminalEventRecord; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [TerminalSessionRecord,TerminalEventRecord]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}})
      await pool.query(terminalDdl)
      await pool.query("INSERT INTO terminal_sessions(id,owner_id,name,source,mode,status,shell_mode,network_profile,last_sequence,output_chars,created_at,updated_at) VALUES('synthetic-terminal',$1,'合成终端','user','agent-events','idle','sandbox','none',1,4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[userId])
      await pool.query("INSERT INTO terminal_events(terminal_id,sequence,event_type,stdout,stderr,occurred_at) VALUES('synthetic-terminal',1,'output','合成输出','',CURRENT_TIMESTAMP)")
      const subscription = await createRedisLiveSubscription(redisUrl)([`events:${userId}`])
      try {
        const deleted = await host.app.inject({method:'DELETE',url:'/api/v1/skills/U1',headers:{authorization:`Bearer ${userToken}`}})
        assert.equal(deleted.statusCode,204,deleted.body)
        assert.equal(deleted.body,'')
        assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_skills WHERE owner_id=$1',[userId])).rows[0].count,0)
        const notification = await subscription.next(AbortSignal.timeout(5000))
        assert.ok(notification)
        const event = JSON.parse(notification.data)
        assert.equal(event.resource,'skills')
        assert.equal(event.operation,'refresh')
        assert.equal(event.type,'resource.changed')
        assert.ok(event.revision>0)
        assert.equal((await host.app.inject({method:'DELETE',url:'/api/v1/skills/U1',headers:{authorization:`Bearer ${userToken}`}})).statusCode,404)
        assert.equal((await host.app.inject({method:'DELETE',url:'/api/v1/terminals/synthetic-terminal'})).statusCode,401)
        const deletedTerminal=await host.app.inject({method:'DELETE',url:'/api/v1/terminals/synthetic-terminal',headers:{authorization:`Bearer ${userToken}`,'x-client-id':'synthetic-client'}})
        assert.equal(deletedTerminal.statusCode,200,deletedTerminal.body)
        assert.deepEqual(deletedTerminal.json(),{deleted:true,terminalId:'synthetic-terminal'})
        assert.equal((await pool.query('SELECT count(*)::integer AS count FROM terminal_sessions')).rows[0].count,0)
        assert.equal((await pool.query('SELECT count(*)::integer AS count FROM terminal_events')).rows[0].count,0)
        const terminalNotification=await subscription.next(AbortSignal.timeout(5000))
        assert.ok(terminalNotification)
        const terminalEvent=JSON.parse(terminalNotification.data)
        assert.equal(terminalEvent.resource,'terminals')
        assert.equal(terminalEvent.operation,'delete')
        assert.equal(terminalEvent.entity_id,'synthetic-terminal')
        assert.equal(terminalEvent.origin,'synthetic-client')
        assert.equal((await host.app.inject({method:'DELETE',url:'/api/v1/terminals/synthetic-terminal',headers:{authorization:`Bearer ${userToken}`}})).statusCode,404)

      } finally {await subscription.close()}
    }
    const audit = await host.app.inject({...endpoints[0]!,headers})
    assert.equal(audit.statusCode,200)
    assert.ok(audit.json().items.some((row:{description:string})=>row.description.includes('配额')))
    assert.ok(audit.json().items.some((row:{description:string})=>row.description.includes('开发者')))
  } finally {
    await host?.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root,{recursive:true,force:true})
  }
})
