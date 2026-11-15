import assert from 'node:assert/strict'
import test from 'node:test'
import {CoreError} from '@gugu/core'
import Fastify from 'fastify'
import {createApp} from '../../src/app.js'
import {registerAdminUserDeleteRoute} from '../../src/modules/admin/user-delete.js'

test('管理员删除账号后才写用户审计并返回清理对象数',async()=>{
  const order:string[]=[]
  const app=createApp({
    appName:'synthetic-test',isReady:async()=>true,
    adminAuth:{
      registerRoutes(){},async verifyAdmin(){return true},
      async requireAdmin(request,reply){if(request.headers.authorization!=='synthetic-admin')return reply.code(401).send({detail:'管理员认证失败'})},
    },
    adminUserDelete:{
    adminUsername:()=> 'synthetic-admin',
    async deleteUser(id){order.push(`delete:${id}`);return {username:'synthetic-user',storageObjectsRemoved:-1}},
    async writeAuditLog(username,action,description){order.push(`audit:${username}:${action}:${description}`)},
    },
  })
  try{
    const denied=await app.inject({method:'DELETE',url:'/api/v1/admin/users/00000000-0000-4000-8000-000000000072'})
    assert.equal(denied.statusCode,401)
    assert.deepEqual(order,[])
    const response=await app.inject({method:'DELETE',url:'/api/v1/admin/users/00000000-0000-4000-8000-000000000072',headers:{authorization:'synthetic-admin'}})
    assert.equal(response.statusCode,200)
    assert.deepEqual(response.json(),{deleted:true,storage_objects_removed:-1})
    assert.deepEqual(order,[
      'delete:00000000-0000-4000-8000-000000000072',
      'audit:synthetic-admin:user:删除用户 synthetic-user（存储对象清除 -1 个）',
    ])
  }finally{await app.close()}
})

test('管理员删除不存在的账号时返回 404 且不写审计',async()=>{
  const app=Fastify();let audited=false
  registerAdminUserDeleteRoute(app,{
    requireAdmin:async()=>{},adminUsername:()=> 'synthetic-admin',
    async deleteUser(){throw new CoreError('not_found','用户不存在')},
    async writeAuditLog(){audited=true},
  })
  try{
    const response=await app.inject({method:'DELETE',url:'/api/v1/admin/users/00000000-0000-4000-8000-000000000073'})
    assert.equal(response.statusCode,404)
    assert.equal(audited,false)
  }finally{await app.close()}
})
