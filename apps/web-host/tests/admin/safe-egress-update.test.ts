import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import Fastify from 'fastify'
import {createSafeEgressFileUpdater,registerSafeEgressUpdateRoute} from '../../src/modules/admin/network-update.js'
import {encryptEncryptedString,decryptEncryptedString} from '../../src/adapters/encrypted-string.js'
test('代理配置PATCH加密保存、保留未提交密码、明确清除并保护其他配置段',async()=>{
 const root=await mkdtemp(join(tmpdir(),'egress-update-')),path=join(root,'override.json'),secret='synthetic-egress-secret',app=Fastify(),headers={authorization:'admin'}
 registerSafeEgressUpdateRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(401).send({detail:'未登录'})},update:createSafeEgressFileUpdater({},path,secret)})
 const patch=(payload:unknown)=>app.inject({method:'PATCH',url:'/api/v1/admin/safe-egress',headers,payload:payload as Record<string,unknown>})
 try{
  await writeFile(path,JSON.stringify({db:{marker:'preserve'},llm_presets:{items:[{id:'keep'}]},safe_egress:{enabled:false,proxy_url:'',proxy_auth_secret:encryptEncryptedString(secret,JSON.stringify({username:'old-user',password:'old-password'}))}}))
  assert.equal((await app.inject({method:'PATCH',url:'/api/v1/admin/safe-egress',payload:{enabled:true}})).statusCode,401)
  const response=await patch({enabled:true,proxy_url:' http://proxy.example:3128/ ',proxy_username:'new-user'});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{enabled:true,proxy_url:'http://proxy.example:3128',has_auth:true})
  let saved=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(JSON.parse(decryptEncryptedString(secret,saved.safe_egress.proxy_auth_secret)),{username:'new-user',password:'old-password'});assert.equal((await readFile(path,'utf8')).includes('old-password'),false);assert.deepEqual(saved.db,{marker:'preserve'});assert.deepEqual(saved.llm_presets,{items:[{id:'keep'}]})
  const before=await readFile(path,'utf8')
  for(const payload of [{proxy_url:'http://user:password@proxy.example:3128'},{proxy_url:'http://proxy.example:3128/path'},{proxy_auth_secret:'plaintext'},{enabled:false,proxy_url:'socks5://proxy.example:1080'}]){assert.equal((await patch(payload)).statusCode,422);assert.equal(await readFile(path,'utf8'),before)}
  await Promise.all([patch({proxy_username:'concurrent-user'}),patch({enabled:false})]);saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.safe_egress.enabled,false);assert.equal(JSON.parse(decryptEncryptedString(secret,saved.safe_egress.proxy_auth_secret)).username,'concurrent-user')
  assert.equal((await patch({clear_credentials:true,proxy_username:'ignored',proxy_password:'ignored'})).json().has_auth,false)
  saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.safe_egress.proxy_auth_secret,'')
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
})
test('坏认证不被clear静默覆盖，缺失/坏配置拒绝写入且错误脱敏',async()=>{
 const root=await mkdtemp(join(tmpdir(),'egress-update-')),path=join(root,'override.json'),secret='synthetic-egress-secret',app=Fastify()
 registerSafeEgressUpdateRoute(app,{requireAdmin:async()=>{},update:createSafeEgressFileUpdater({},path,secret)})
 const patch=(payload:unknown)=>app.inject({method:'PATCH',url:'/api/v1/admin/safe-egress',payload:payload as Record<string,unknown>})
 try{
  let response=await patch({enabled:false});assert.equal(response.statusCode,500);await assert.rejects(readFile(path),{code:'ENOENT'});assert.equal(response.body.includes(root),false)
  await writeFile(path,'broken-json');response=await patch({enabled:false});assert.equal(response.statusCode,500);assert.equal(await readFile(path,'utf8'),'broken-json')
  const document=JSON.stringify({safe_egress:{enabled:false,proxy_url:'',proxy_auth_secret:'gcm1:broken'}});await writeFile(path,document)
  response=await patch({clear_credentials:true});assert.equal(response.statusCode,500);assert.deepEqual(response.json(),{detail:'代理认证配置不可读取，请重新保存'});assert.equal(await readFile(path,'utf8'),document)
  for(const body of [{clear_credentials:null},{clear_credentials:['true']},{enabled:['true']},{proxy_username:12}])assert.equal((await patch(body)).statusCode,422)
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
})
