import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerAccountDeleteRoute} from '../../src/modules/auth/account-delete.js'

const owner='00000000-0000-4000-8000-000000000071'

test('注销要求当前密码，错误密码不触发删除，正确密码返回 204',async()=>{
  let deleted=0
  const app=Fastify()
  registerAccountDeleteRoute(app,{
    requireUser:async()=>{},
    ownerIdFromRequest:()=>owner,
    verifyPassword:async(id,password)=>id===owner&&password==='synthetic-current-password',
    remove:async id=>{assert.equal(id,owner);deleted++;return 0},
  })
  try{
    const missing=await app.inject({method:'DELETE',url:'/api/v1/auth/me',payload:{}})
    assert.equal(missing.statusCode,422)
    const wrong=await app.inject({method:'DELETE',url:'/api/v1/auth/me',payload:{password:'wrong'}})
    assert.equal(wrong.statusCode,400)
    assert.deepEqual(wrong.json(),{detail:'密码错误'})
    assert.equal(deleted,0)
    const accepted=await app.inject({method:'DELETE',url:'/api/v1/auth/me',payload:{password:'synthetic-current-password'}})
    assert.equal(accepted.statusCode,204)
    assert.equal(deleted,1)
  }finally{await app.close()}
})
