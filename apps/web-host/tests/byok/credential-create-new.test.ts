import { byokBindings } from '@gugu/database/postgres/migrations/0021_byok_bindings'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCredentialCreator, readPostgresLlmCredentialSnapshot } from '../../src/modules/byok/store.js'

test('BYOK创建在关闭时拒绝且不读取或写入用户凭据',async()=>{
 let called=false
 const create=createCredentialCreator({transaction:async()=>{called=true;throw Error('unexpected')},encrypt:async()=>{called=true;throw Error('unexpected')},enabled:()=>false})
 await assert.rejects(create('00000000-0000-4000-8000-000000000071',{provider:'openai',capability:'llm',value:'synthetic'}),(error:unknown)=>(error as {statusCode:number}).statusCode===403)
 assert.equal(called,false)
})

test('创建凭据时保留通用模型默认绑定、隔离 owner 并回滚失败写入',{skip:!process.env.GUGU_WEBUI_TEST_DATABASE_URL&&'需要隔离 PostgreSQL'},async()=>{
 const {Pool}=await import('pg'),{randomUUID}=await import('node:crypto')
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL
 assert.ok(url)
 const schema=`byok_create_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:1})
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)')
  await pool.query(`CREATE TABLE user_provider_credentials(id serial PRIMARY KEY,user_id uuid,provider text,api_format text,capability text,encrypted_value text,nonce text,encrypted_data_key text,key_version int,base_url text,model text,max_tokens int,context_tokens int,thinking text,reasoning_effort text,reasoning_persistence text,web_search_enabled boolean,image boolean,video boolean,audio boolean,image_detail text,dimensions int,enabled boolean,last_verified_at timestamptz,created_at timestamptz,updated_at timestamptz)`)
  await pool.query(`CREATE TABLE user_provider_bindings(user_id uuid, capability text, credential_id int
    REFERENCES user_provider_credentials(id) ON DELETE CASCADE, PRIMARY KEY(user_id,capability))`)
  await pool.query(`CREATE TABLE provider_reasoning_states(user_id uuid,status text,invalidated_reason text,invalidated_at timestamptz,encrypted_payload text,payload_nonce text,encrypted_data_key text,payload_size int,version int,updated_at timestamptz)`)
  const a='00000000-0000-4000-8000-000000000071',b='00000000-0000-4000-8000-000000000072'
  await pool.query('INSERT INTO users VALUES ($1),($2)',[a,b])
  const transaction=async<T>(work:(q:(sql:string,v:readonly unknown[])=>Promise<{rows:Record<string,any>[]}>)=>Promise<T>)=>{const client=await pool.connect();try{await client.query('BEGIN');const out=await work((sql,v)=>client.query(sql,[...v]));await client.query('COMMIT');return out}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
  let fail=false
  const create=createCredentialCreator({transaction,enabled:()=>true,encrypt:async(value,allowEmpty)=>{if(fail)throw Error('synthetic');return {ciphertext:`cipher:${value}`,nonce:'n',encryptedDataKey:'k',keyVersion:1}}})
  await pool.query("INSERT INTO provider_reasoning_states(user_id,status,encrypted_payload,payload_nonce,encrypted_data_key,payload_size,version) VALUES($1,'active','cipher','nonce','wrapped',3,1)",[a])
  const initial = await create(a,{provider:'openai',capability:'llm',value:'one'})
  const saved = await create(a, {provider:'openai', capability:'llm', value:'saved'}, false)
  assert.equal(saved.enabled, false)
  assert.equal((await pool.query('SELECT credential_id FROM user_provider_bindings WHERE user_id=$1 AND capability=$2',[a,'llm'])).rows[0].credential_id,initial.id)
  assert.deepEqual((await pool.query('SELECT status,encrypted_payload,version FROM provider_reasoning_states WHERE user_id=$1',[a])).rows[0],{status:'invalidated',encrypted_payload:'',version:2})
  await create(b,{provider:'openai',capability:'llm',value:'foreign'})
  fail=true;await assert.rejects(create(a,{provider:'openai',capability:'llm',value:'two'}))
  assert.equal((await pool.query('SELECT count(*)::int n FROM user_provider_credentials WHERE user_id=$1 AND enabled',[a])).rows[0].n,1)
  fail=false;const result=await create(a,{provider:'openai',capability:'llm',value:'two'})
  assert.equal(result.has_value,true);assert.equal('encrypted_value' in result,false)
  assert.equal(result.enabled, false)
  const client = await pool.connect()
  try {
    assert.equal((await readPostgresLlmCredentialSnapshot(client, a, 'synthetic-version-secret')).credentialId, initial.id)
    assert.equal((await readPostgresLlmCredentialSnapshot(client, a, 'synthetic-version-secret', Number(result.id))).credentialId, result.id)
  } finally {
    client.release()
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM user_provider_credentials WHERE user_id=$1 AND enabled',[a])).rows[0].n,1)
  assert.equal((await pool.query('SELECT count(*)::int n FROM user_provider_credentials WHERE user_id=$1 AND enabled',[b])).rows[0].n,1)
  await assert.rejects(create(a,{provider:'openai',capability:'llm',value:''}),(error:unknown)=>(error as {statusCode:number}).statusCode===422)
  await create(a,{provider:'local',capability:'embedding',value:''})
  await assert.rejects(create(a,{provider:'ollama',base_url:'https://ollama.com',capability:'embedding',value:''}))
  await assert.rejects(create(a,{provider:'openai',capability:'llm',value:'synthetic',web_search_enabled:true}))
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('正式 PG 模型和 Python 创建 handler 同语义', {skip:!process.env.GUGU_WEBUI_TEST_DATABASE_URL||!process.env.GUGU_CORE_GOLDEN_PYTHON},async()=>{
 const {Pool}=await import('pg'),{randomUUID}=await import('node:crypto'),{execFileSync}=await import('node:child_process')
 const {createByokEnvelope}=await import('../../src/modules/byok/crypto.js'),{mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL!,schema=`byok_formal_${randomUUID().replaceAll('-','')}`,dir=await mkdtemp(join(tmpdir(),'byok-formal-'))
 const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4})
 try{
  const env={...process.env,BYOK_TEST_PG:url.replace(/^postgresql:/,'postgresql+asyncpg:'),BYOK_TEST_SCHEMA:schema,CREDENTIALS_MASTER_KEY:'synthetic-formal-key',CREDENTIALS_MASTER_KEY_FILE:join(dir,'master'),GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(dir,'missing'),PYTHONPATH:'.'}
  const py=JSON.parse(execFileSync(process.env.GUGU_CORE_GOLDEN_PYTHON!,['../apps/web-host/tests/byok/fixtures/create_python.py'],{cwd:'../../backend',env,encoding:'utf8',timeout:60000}))
  await byokBindings.apply(pool)
  const envelope=createByokEnvelope({keyFile:join(dir,'master'),version:1,masterKey:'synthetic-formal-key'})
  const transaction=async<T>(work:(q:(sql:string,v:readonly unknown[])=>Promise<{rows:Record<string,any>[]}>)=>Promise<T>)=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await work((sql,v)=>client.query(sql,[...v]));await client.query('COMMIT');return result}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
  const create=createCredentialCreator({transaction,enabled:()=>true,encrypt:envelope.encrypt})
  const result=await create('00000000-0000-4000-8000-000000000072',{provider:'local',capability:'embedding',value:'',dimensions:32})
  for(const key of ['provider','api_format','capability','base_url','model','max_tokens','context_tokens','thinking','reasoning_effort','reasoning_persistence','web_search_enabled','image','video','audio','image_detail','dimensions','enabled','has_value','last_verified_at'])assert.deepEqual(result[key],py[key],key)
  const pythonStored=(await pool.query('SELECT encrypted_value,nonce,encrypted_data_key,key_version FROM user_provider_credentials WHERE user_id=$1',['00000000-0000-4000-8000-000000000071'])).rows[0]
  assert.equal(await envelope.decrypt({ciphertext:pythonStored.encrypted_value,nonce:pythonStored.nonce,encryptedDataKey:pythonStored.encrypted_data_key,keyVersion:pythonStored.key_version}),'')
  const verified=JSON.parse(execFileSync(process.env.GUGU_CORE_GOLDEN_PYTHON!,['../apps/web-host/tests/byok/fixtures/create_python.py'],{cwd:'../../backend',env:{...env,BYOK_TEST_VERIFY:'1'},encoding:'utf8',timeout:60000}))
  assert.equal(verified.value,'')
  const stored=(await pool.query('SELECT encrypted_value,nonce,encrypted_data_key,key_version FROM user_provider_credentials WHERE id=$1',[result.id])).rows[0]
  assert.equal(await envelope.decrypt({ciphertext:stored.encrypted_value,nonce:stored.nonce,encryptedDataKey:stored.encrypted_data_key,keyVersion:stored.key_version}),'')
  const owner='00000000-0000-4000-8000-000000000072'
  const {default:Fastify}=await import('fastify'),{registerCredentialCreateRoute}=await import('../../src/modules/byok/routes.js')
  const app=Fastify()
  registerCredentialCreateRoute(app,{requireUser:async(req,reply)=>{if(!req.headers.authorization)return reply.code(401).send()},ownerIdFromRequest:()=>owner,create})
  try{
   const response=await app.inject({method:'POST',url:'/api/v1/byok',headers:{authorization:'synthetic'},payload:{provider:'local',capability:'embedding',value:'host-synthetic'}})
   assert.equal(response.statusCode,200);assert.equal(response.body.includes('host-synthetic'),false)
   const hostVerified=JSON.parse(execFileSync(process.env.GUGU_CORE_GOLDEN_PYTHON!,['../apps/web-host/tests/byok/fixtures/create_python.py'],{cwd:'../../backend',env:{...env,BYOK_TEST_VERIFY:'1'},encoding:'utf8',timeout:60000}))
   assert.equal(hostVerified.value,'host-synthetic')
  }finally{await app.close()}
  await Promise.all([create(owner,{provider:'local',capability:'embedding',value:'a'}),create(owner,{provider:'local',capability:'embedding',value:'b'})])
  assert.equal((await pool.query("SELECT count(*)::int n FROM user_provider_credentials WHERE user_id=$1 AND capability='embedding' AND enabled",[owner])).rows[0].n,1)
  await pool.query("CREATE FUNCTION reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$")
  await pool.query('CREATE TRIGGER reject_insert BEFORE INSERT ON user_provider_credentials FOR EACH ROW EXECUTE FUNCTION reject_insert()')
  await assert.rejects(create(owner,{provider:'local',capability:'embedding',value:'c'}))
  assert.equal((await pool.query("SELECT count(*)::int n FROM user_provider_credentials WHERE user_id=$1 AND capability='embedding' AND enabled",[owner])).rows[0].n,1)
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true})}
})
