import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {createServer as createSocket} from 'node:net'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {startServer} from '../../../../src/main.js'
import {signedUserToken} from '../../../helpers/auth.js'

test('生产模型目录经真实安全HTTP传输与动态配置，权限/凭据目的地/错误隔离',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(databaseUrl);assert.ok(python)
 const schema=`model_directory_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-model-directory-')),path=join(root,'config.json'),secret='synthetic-model-directory-secret'
 let status=200,payload:unknown={data:[{id:'z-model'},{id:'a-model'},{id:'a-model'}]},raw:string|undefined
 const requests:{url:string;authorization:string|undefined}[]=[]
 const relay=createServer((request,response)=>{requests.push({url:request.url!,authorization:request.headers.authorization});response.writeHead(status,{'content-type':'application/json'});response.end(raw??JSON.stringify(payload))})
 await new Promise<void>(done=>relay.listen(0,'127.0.0.1',done));const relayAddress=relay.address();assert.ok(relayAddress&&typeof relayAddress!=='string');const baseUrl=`http://127.0.0.1:${relayAddress.port}/v1`
 await admin.query(`CREATE SCHEMA "${schema}"`);const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`)
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  execFileSync(python,[resolve('../../compat/support/llm_strategy.py'),'setup'],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:path,TEST_SCHEMA:schema,TEST_OWNER:owner},timeout:20000})
  const document={ai_presets:{active_id:'a',items:[{id:'a',provider:'local',api_key:'synthetic-saved-key',base_url:baseUrl}]},voice_presets:{active_id:'v',items:[{id:'v',provider:'local',api_key:'synthetic-voice-key',base_url:baseUrl}]},other:{keep:true}}
  const original=JSON.stringify(document);await writeFile(path,original)
  const socket=createSocket();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(done=>socket.close(()=>done()))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:path,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:join(root,'storage'),ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const base='/api/v1/admin/agent',saved=`${base}/llm-presets/a/models`,preview=`${base}/llm-presets/models-preview`,voice=`${base}/voice-presets/models-preview`
  for(const [method,url] of [['GET',saved],['POST',preview],['POST',voice]] as const){assert.equal((await host.app.inject({method,url,payload:method==='POST'?{}:undefined})).statusCode,401);assert.equal((await host.app.inject({method,url,payload:method==='POST'?{}:undefined,headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)}assert.equal(requests.length,0)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const read=await host.app.inject({method:'GET',url:saved,headers});assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.json(),{models:['a-model','z-model'],source:'provider'});assert.equal(requests.at(-1)!.url,'/v1/models');assert.equal(requests.at(-1)!.authorization,'Bearer synthetic-saved-key');assert.doesNotMatch(read.body,/synthetic-saved-key/)
  assert.equal((await host.app.inject({method:'POST',url:preview,headers,payload:{provider:'local',base_url:baseUrl,api_key:'synthetic-preview-key'}})).statusCode,200);assert.equal(requests.at(-1)!.authorization,'Bearer synthetic-preview-key')
  assert.equal((await host.app.inject({method:'POST',url:voice,headers,payload:{provider:'local',base_url:baseUrl+'/',preset_id:'v'}})).statusCode,200);assert.equal(requests.at(-1)!.authorization,'Bearer synthetic-voice-key')
  let before=requests.length;assert.equal((await host.app.inject({method:'POST',url:voice,headers,payload:{provider:'local',base_url:baseUrl+'/changed',preset_id:'v'}})).statusCode,422);assert.equal(requests.length,before)
  before=requests.length;assert.equal((await host.app.inject({method:'POST',url:preview,headers,payload:{provider:'openai',base_url:baseUrl,api_key:'synthetic-cloud-key'}})).statusCode,502);assert.equal(requests.length,before)
  status=401;payload={error:'synthetic-upstream-secret'};const unauthorized=await host.app.inject({method:'GET',url:saved,headers});assert.equal(unauthorized.statusCode,502);assert.deepEqual(unauthorized.json(),{detail:'服务商鉴权失败'});assert.doesNotMatch(unauthorized.body,/synthetic-upstream-secret/)
  status=200;raw='broken';assert.equal((await host.app.inject({method:'GET',url:saved,headers})).statusCode,502);raw=undefined;payload={data:[{id:'updated-model'}]}
  document.ai_presets.items[0]!.api_key='synthetic-new-key';await writeFile(path,JSON.stringify(document));assert.deepEqual((await host.app.inject({method:'GET',url:saved,headers})).json(),{models:['updated-model'],source:'provider'});assert.equal(requests.at(-1)!.authorization,'Bearer synthetic-new-key')
  const final=await readFile(path,'utf8');assert.deepEqual(JSON.parse(final),document)
  await writeFile(path,'{');before=requests.length;assert.equal((await host.app.inject({method:'GET',url:saved,headers})).statusCode,503);assert.equal(requests.length,before);assert.equal(await readFile(path,'utf8'),'{')
 }finally{await host?.close();await new Promise<void>(done=>relay.close(()=>done()));await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
