import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import test from 'node:test'
import {startServer} from '../../../../src/main.js'
import {temporarySmtp} from '../../../admin/fixtures/temporary-smtp.js'
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产管理员SMTP动态配置到真实TLS服务，认证优先、只读及错误脱敏',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL;assert.ok(databaseUrl)
 const root=await mkdtemp(join(tmpdir(),'smtp-probe-')),path=join(root,'override.json'),relay=await temporarySmtp(root)
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  const settings={host:'127.0.0.1',port:relay.port,user:'sender@example.test',password:'synthetic-secret',from_addr:'测试咕咕',test_to_addr:'recipient@example.test'}
  const original=JSON.stringify({smtp:settings,db:{keep:true}});await writeFile(path,original)
  host=await startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-smtp-secret',GUGU_CONFIG_OVERRIDE_FILE:path,SSL_CERT_FILE:relay.cert,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const url='/api/v1/admin/config/test-smtp',payload={host:'',port:0,user:'',to_addr:''}
  assert.equal((await host.app.inject({method:'POST',url,payload})).statusCode,401);assert.equal(relay.received.length,0)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  assert.equal((await host.app.inject({method:'POST',url,headers,payload:{}})).statusCode,422)
  const response=await host.app.inject({method:'POST',url,headers,payload});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{ok:true,message:'测试邮件已发送至 recipient@example.test'});assert.equal(relay.received.length,1);assert.equal(relay.received[0]!.encrypted,true);assert.equal(await readFile(path,'utf8'),original)
  await writeFile(path,JSON.stringify({smtp:{...settings,test_to_addr:'changed@example.test'}}));assert.equal((await host.app.inject({method:'POST',url,headers,payload})).json().message,'测试邮件已发送至 changed@example.test');assert.match(relay.received[1]!.to[0]!,/changed@example\.test/)
  relay.rejectAuth=true;const failed=await host.app.inject({method:'POST',url,headers,payload});assert.equal(failed.statusCode,200);assert.equal(failed.json().ok,false);assert.equal(failed.body.includes('synthetic-secret'),false)
  await writeFile(path,'broken');const broken=await host.app.inject({method:'POST',url,headers,payload});assert.equal(broken.statusCode,503);assert.equal(broken.body.includes(root),false);assert.equal(await readFile(path,'utf8'),'broken')
 }finally{await host?.close();await relay.close();await rm(root,{recursive:true,force:true})}
})
