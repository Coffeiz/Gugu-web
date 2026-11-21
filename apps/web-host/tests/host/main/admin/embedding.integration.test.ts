import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createServer as createPortServer} from 'node:net'
async function freePort(){const s=createPortServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
import test from 'node:test'
import {startServer} from '../../../../src/main.js'
test('生产Embedding诊断入口认证优先且只读最新配置，错误脱敏',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL;assert.ok(databaseUrl)
 let requests=0;const server=createServer((_req,res)=>{requests++;res.end(JSON.stringify({data:[{embedding:[1,2]}]}))});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string')
 const root=await mkdtemp(join(tmpdir(),'embedding-probe-')),path=join(root,'override.json');let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  const original=JSON.stringify({db:{keep:true},embedding:{provider:'ollama',base_url:`http://127.0.0.1:${address.port}/v1`,model:'synthetic'}});await writeFile(path,original)
  host=await startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-embedding-secret',GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const url='/api/v1/admin/config/test-embedding';assert.equal((await host.app.inject({method:'POST',url,payload:{}})).statusCode,401);assert.equal(requests,0)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const response=await host.app.inject({method:'POST',url,headers,payload:{}});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{ok:true,message:'OK — 连通，向量维度 2'});assert.equal(requests,1);assert.equal(await readFile(path,'utf8'),original)
  await writeFile(path,'broken-json');const failed=await host.app.inject({method:'POST',url,headers,payload:{}});assert.equal(failed.statusCode,503);assert.equal(failed.body.includes(root),false);assert.equal(await readFile(path,'utf8'),'broken-json')
 }finally{await host?.close();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}
})
