import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
import {registerWatcherCapacityRoute} from '../../src/modules/filesync/watcher-capacity.js'
import {createWatcherCapacityRequester} from '../../src/adapters/inotify-limit-client.js'
test('容量扩展认证优先，仅发送固定命令，拒绝超长或拒绝响应且不泄漏socket路径',async()=>{
 const root=await mkdtemp(join(tmpdir(),'watch-main-')),path=join(root,'helper.sock');const requests:string[]=[];let mode='ok'
 const server=createServer(socket=>socket.once('data',data=>{requests.push(data.toString());if(mode==='silent')return;socket.end(mode==='ok'?'{"ok":true,"expanded":true,"limit":131072}\n':mode==='eof'?'{"ok":true,"expanded":true}':mode==='cap'?'{"ok":true,"expanded":false}\n':mode==='long'?'x'.repeat(4097)+'\n':'{"ok":false,"error":"synthetic-secret"}\n')}));await new Promise<void>(r=>server.listen(path,r));const app=Fastify()
 registerWatcherCapacityRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(401).send({detail:'未登录'})},request:createWatcherCapacityRequester({FILESYNC__WATCH_LIMIT_SOCKET:path})})
 const call=(auth='admin')=>app.inject({method:'POST',url:'/api/v1/admin/filesync/watcher-capacity/expand',headers:{authorization:auth},payload:{operation:'other',hardLimit:99999999}})
 try{
  assert.equal((await call('')).statusCode,401);assert.equal(requests.length,0)
  assert.deepEqual((await call()).json(),{ok:true,expanded:true,limit:131072});assert.deepEqual(JSON.parse(requests[0]!),{operation:'expand'})
  mode='eof';assert.equal((await call()).statusCode,200)
  mode='cap';assert.equal((await call()).statusCode,409)
  for(const value of ['long','rejected']){mode=value;const response=await call();assert.equal(response.statusCode,503);assert.equal(response.body.includes('synthetic-secret'),false);assert.equal(response.body.includes(root),false)}
  mode='silent';assert.equal((await call()).statusCode,503)
 }finally{await app.close();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}
})

test('显式空socket配置返回脱敏503',async()=>{const app=Fastify();registerWatcherCapacityRoute(app,{requireAdmin:async()=>{},request:createWatcherCapacityRequester({FILESYNC__WATCH_LIMIT_SOCKET:''})});try{const result=await app.inject({method:'POST',url:'/api/v1/admin/filesync/watcher-capacity/expand'});assert.equal(result.statusCode,503)}finally{await app.close()}})
