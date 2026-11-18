import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createServer as createHttpServer} from 'node:http'
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
 let host:Awaited<ReturnType<typeof startServer>>|undefined,providerServer:ReturnType<typeof createHttpServer>|undefined
 try{
  const master='synthetic-production-master',secret='synthetic-production-auth'
  const env={...process.env,BYOK_TEST_PG:databaseUrl!.replace(/^postgresql:/,'postgresql+asyncpg:'),BYOK_TEST_SCHEMA:schema,CREDENTIALS_MASTER_KEY:master,CREDENTIALS_MASTER_KEY_FILE:join(root,'master'),GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'config.json'),PYTHONPATH:'.:../compat/core-python/src'}
  await writeFile(env.GUGU_CONFIG_OVERRIDE_FILE,'{}')
  execFileSync(python!,['../apps/web-host/tests/byok/fixtures/create_python.py'],{cwd:'../../backend',env,encoding:'utf8',timeout:60000})
  const providerRequests:string[]=[],providerBodies:Record<string,unknown>[]=[]
  providerServer=createHttpServer((request,response)=>{
   const chunks:Buffer[]=[]
   request.on('data',chunk=>chunks.push(Buffer.from(chunk)))
   request.on('end',()=>{
    providerRequests.push(request.headers.authorization??'')
    const raw=Buffer.concat(chunks).toString()
    providerBodies.push(raw?JSON.parse(raw) as Record<string,unknown>:{})
    const data=request.url?.endsWith('/embeddings')
     ? [{embedding:[0.25,0.5]}]
     : [{id:'model-z'},{id:'model-a'},{id:'model-z'}]
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data}))
   })
  })
  await new Promise<void>(resolve=>providerServer!.listen(0,'127.0.0.1',resolve));const providerAddress=providerServer.address();assert.ok(providerAddress&&typeof providerAddress!=='string')
  const providerBase=`http://127.0.0.1:${providerAddress.port}/v1`
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:env.GUGU_CONFIG_OVERRIDE_FILE,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:root,CREDENTIALS_MASTER_KEY:master,BYOK__ENABLED:'true'})
  const owner='00000000-0000-4000-8000-000000000072',headers={authorization:`Bearer ${signedUserToken(secret,owner)}`},payload={provider:'local',api_format:'openai',capability:'embedding',value:'synthetic-host-value',base_url:providerBase,model:'original-model'}
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
  const credentialId=listed.json().items[0].id
  const foreignCredentialId=(await pool.query('SELECT id FROM user_provider_credentials WHERE user_id<>$1 LIMIT 1',[owner])).rows[0]?.id
  assert.ok(foreignCredentialId)
  assert.equal((await host.app.inject({method:'POST',url:'/api/v1/byok/models-preview',payload:{provider:'local'}})).statusCode,401)
  const models=await host.app.inject({method:'POST',url:'/api/v1/byok/models-preview',headers,payload:{provider:'local',api_format:'openai',base_url:`${providerBase}/`,model:'preview-model',credential_id:credentialId}})
  assert.equal(models.statusCode,200,models.body);assert.deepEqual(models.json(),{models:['model-a','model-z']});assert.deepEqual(providerRequests,['Bearer synthetic-host-value'])
  assert.doesNotMatch(models.body,/synthetic-host-value|api_key/)
  const foreignCredential=await host.app.inject({method:'POST',url:'/api/v1/byok/models-preview',headers,payload:{provider:'local',base_url:providerBase,credential_id:foreignCredentialId}})
  assert.equal(foreignCredential.statusCode,404,foreignCredential.body);assert.equal(providerRequests.length,1)
  const wrongDestination=await host.app.inject({method:'POST',url:'/api/v1/byok/models-preview',headers,payload:{provider:'local',base_url:'http://127.0.0.1:9/v1',credential_id:credentialId}})
  assert.equal(wrongDestination.statusCode,422,wrongDestination.body);assert.equal(providerRequests.length,1)
  assert.equal((await host.app.inject({method:'POST',url:'/api/v1/byok/media-capability-probe',payload:{provider:'local',dim:'image'}})).statusCode,401)
  const media=await host.app.inject({method:'POST',url:'/api/v1/byok/media-capability-probe',headers,payload:{provider:'local',api_format:'openai',base_url:providerBase,model:'preview-vision',credential_id:credentialId,dim:'image'}})
  assert.equal(media.statusCode,200,media.body)
  assert.deepEqual(media.json(),{dim:'image',supported:true,status:200,detail:'模型接受了图片输入'})
  assert.equal(providerRequests.length,2);assert.equal(providerRequests[1],'Bearer synthetic-host-value')
  const mediaMessages=providerBodies[1]?.messages as Array<{content:Array<{image_url?:{url:string}}>}>|undefined
  assert.match(mediaMessages?.[0]?.content[1]?.image_url?.url??'',/^data:image\/png;base64,/)
  assert.doesNotMatch(media.body,/synthetic-host-value|encrypted_value|encrypted_data_key/)
  const foreignMedia=await host.app.inject({method:'POST',url:'/api/v1/byok/media-capability-probe',headers,payload:{provider:'local',api_format:'openai',base_url:providerBase,model:'preview-vision',credential_id:foreignCredentialId,dim:'image'}})
  assert.equal(foreignMedia.statusCode,404,foreignMedia.body);assert.equal(providerRequests.length,2)
  const wrongMediaDestination=await host.app.inject({method:'POST',url:'/api/v1/byok/media-capability-probe',headers,payload:{provider:'local',api_format:'openai',base_url:'http://127.0.0.1:9/v1',model:'preview-vision',credential_id:credentialId,dim:'image'}})
  assert.equal(wrongMediaDestination.statusCode,422,wrongMediaDestination.body);assert.equal(providerRequests.length,2)
  const draft={provider:'local',api_format:'openai',capability:'embedding',base_url:providerBase,model:'preview-embedding',dimensions:2,credential_id:credentialId}
  assert.equal((await host.app.inject({method:'POST',url:'/api/v1/byok/test-preview',payload:draft})).statusCode,401)
  const foreignDraft=await host.app.inject({method:'POST',url:'/api/v1/byok/test-preview',headers,payload:{...draft,credential_id:foreignCredentialId}})
  assert.equal(foreignDraft.statusCode,404,foreignDraft.body)
  assert.equal(providerRequests.length,2)
  const preview=await host.app.inject({method:'POST',url:'/api/v1/byok/test-preview',headers,payload:draft})
  const saved=await host.app.inject({method:'POST',url:`/api/v1/byok/${credentialId}/test`,headers})
  for(const probe of [preview,saved]){
   assert.equal(probe.statusCode,200,probe.body)
   assert.deepEqual(probe.json(),{ok:true,status:200,message:'Embedding 连接正常'})
  }
  assert.deepEqual(providerRequests.slice(2),['','Bearer synthetic-host-value'])
  assert.deepEqual(providerBodies.slice(2),[
   {model:'preview-embedding',input:'ping',dimensions:2},
   {model:'original-model',input:'ping'},
  ])
  const afterPreview=await host.app.inject({url:'/api/v1/byok',headers})
  assert.equal(afterPreview.json().items[0].model,'original-model')
  assert.equal(afterPreview.json().items[0].dimensions,null)
  assert.equal((await host.app.inject({method:'PATCH',url:`/api/v1/byok/${credentialId}`,payload:{model:'patched-model'}})).statusCode,401)
  const deniedPatch=await host.app.inject({method:'PATCH',url:`/api/v1/byok/${credentialId}`,headers,payload:{base_url:'https://other.example.test/v1'}})
  assert.equal(deniedPatch.statusCode,422,deniedPatch.body)
  assert.equal(deniedPatch.json().detail,'Provider 或自定义 Endpoint 已变更。请确认目标地址；如地址已更换，请重新填写 API Key')
  const patched=await host.app.inject({method:'PATCH',url:`/api/v1/byok/${credentialId}`,headers,payload:{base_url:'https://other.example.test/v1',model:'patched-model',value:'synthetic-patched-secret'}})
  assert.equal(patched.statusCode,200,patched.body);assert.equal(patched.json().model,'patched-model');assert.equal(patched.json().has_value,true)
  assert.doesNotMatch(patched.body,/synthetic-patched-secret|encrypted_value|encrypted_data_key/)
  const afterPatch=await host.app.inject({url:'/api/v1/byok',headers})
  assert.equal(afterPatch.json().items[0].base_url,'https://other.example.test/v1')
  assert.equal(afterPatch.json().items[0].model,'patched-model')
  const compatiblePatch=await host.app.inject({method:'PATCH',url:`/api/v1/byok/${credentialId}`,headers,payload:{max_tokens:'123',image:'false'}})
  assert.equal(compatiblePatch.statusCode,200,compatiblePatch.body);assert.equal(compatiblePatch.json().max_tokens,123);assert.equal(compatiblePatch.json().image,false)
  assert.equal((await host.app.inject({method:'PATCH',url:'/api/v1/byok/-1',headers,payload:{model:'missing'}})).statusCode,404)
  assert.equal((await host.app.inject({method:'POST',url:'/api/v1/byok/capabilities',payload:{provider:'ollama'}})).statusCode,401)
  const capability=await host.app.inject({method:'POST',url:'/api/v1/byok/capabilities',headers,payload:{provider:'ollama',model:'qwen3:8b',ollama_api_mode:'native',api_key:'synthetic-preview-secret'}})
  assert.equal(capability.statusCode,200,capability.body);assert.equal(capability.json().selected_api_format,'openai')
  assert.doesNotMatch(capability.body,/synthetic-preview-secret|api_key/)
  const row=await pool.query('SELECT count(*)::int AS n FROM user_provider_credentials WHERE user_id=$1 AND enabled',[owner]);assert.equal(row.rows[0].n,1)
  const verified=JSON.parse(execFileSync(python!,['../apps/web-host/tests/byok/fixtures/create_python.py'],{cwd:'../../backend',env:{...env,BYOK_TEST_VERIFY:'1'},encoding:'utf8',timeout:60000}))
  assert.equal(verified.value,'synthetic-patched-secret')
 }finally{await host?.close();if(providerServer)await new Promise<void>(resolve=>providerServer!.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
