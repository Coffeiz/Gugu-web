import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerAdminFileSyncInitializeRoute} from '../../src/modules/filesync/admin-initialize.js'

test('初始化需要管理员明确确认且拒绝删除许可',async()=>{
 const app=Fastify();let calls=0
 registerAdminFileSyncInitializeRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(401).send()},create:async id=>{calls++;assert.equal(id,7);return {action:'initialize',allowDelete:false} as never}})
 try{
  const url='/api/v1/admin/filesync/bindings/7/initialize',headers={authorization:'admin'}
  assert.equal((await app.inject({method:'POST',url})).statusCode,401)
  assert.equal((await app.inject({method:'POST',url,headers,payload:{confirm:false}})).statusCode,400)
  assert.equal((await app.inject({method:'POST',url,headers,payload:{confirm:true,allow_delete:true}})).statusCode,400)
  assert.deepEqual((await app.inject({method:'POST',url,headers,payload:{confirm:true}})).json(),{action:'initialize',allowDelete:false});assert.equal(calls,1)
 }finally{await app.close()}
})
