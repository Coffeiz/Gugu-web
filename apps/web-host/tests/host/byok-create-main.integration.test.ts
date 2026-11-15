import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON
test('生产入口创建的凭据由正式 PG 模型持久化并由 Python 解密',{skip:!databaseUrl||!python},async()=>{
 const schema=`byok_host_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:1}),root=await mkdtemp(join(tmpdir(),'byok-host-'))
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  const master='synthetic-production-master',secret='synthetic-production-auth'
  const env={...process.env,BYOK_TEST_PG:databaseUrl!.replace(/^postgresql:/,'postgresql+asyncpg:'),BYOK_TEST_SCHEMA:schema,CREDENTIALS_MASTER_KEY:master,CREDENTIALS_MASTER_KEY_FILE:join(root,'master'),GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'config.json'),PYTHONPATH:'.:../compat/core-python/src'}
  await writeFile(env.GUGU_CONFIG_OVERRIDE_FILE,'{}')
  execFileSync(python!,['../apps/web-host/tests/byok/fixtures/create_python.py'],{cwd:'../../backend',env,encoding:'utf8',timeout:60000})
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:env.GUGU_CONFIG_OVERRIDE_FILE,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:root,CREDENTIALS_MASTER_KEY:master,BYOK__ENABLED:'true'})
  const owner='00000000-0000-4000-8000-000000000072',headers={authorization:`Bearer ${signedUserToken(secret,owner)}`},payload={provider:'local',capability:'embedding',value:'synthetic-host-value'}
  assert.equal((await host.app.inject({method:'POST',url:'/api/v1/byok',payload})).statusCode,401)
  const response=await host.app.inject({method:'POST',url:'/api/v1/byok',headers,payload})
  assert.equal(response.statusCode,200,response.body)
  assert.equal(response.json().has_value,true);assert.doesNotMatch(response.body,/synthetic-host-value|encrypted_value|encrypted_data_key/)
  assert.equal((await host.app.inject({url:'/api/v1/byok'})).statusCode,401)
  const listed=await host.app.inject({url:'/api/v1/byok',headers})
  assert.equal(listed.statusCode,200,listed.body)
  assert.equal(listed.json().enabled,true);assert.equal(listed.json().status,'ready')
  assert.equal(listed.json().items.length,1);assert.equal(listed.json().items[0].has_value,true)
  assert.equal(listed.json().items[0].dimensions,null)
  assert.doesNotMatch(listed.body,/synthetic-host-value|encrypted_value|encrypted_data_key/)
  const row=await pool.query('SELECT count(*)::int AS n FROM user_provider_credentials WHERE user_id=$1 AND enabled',[owner]);assert.equal(row.rows[0].n,1)
  const verified=JSON.parse(execFileSync(python!,['../apps/web-host/tests/byok/fixtures/create_python.py'],{cwd:'../../backend',env:{...env,BYOK_TEST_VERIFY:'1'},encoding:'utf8',timeout:60000}))
  assert.equal(verified.value,payload.value)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
