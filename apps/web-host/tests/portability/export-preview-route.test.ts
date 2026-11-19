import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerDataExportPreviewRoute } from '../../src/modules/data-portability/exports.js'
test('导出预览认证优先且只使用可信owner，查询失败不伪造零统计',async()=>{
 const app=Fastify(),calls:string[]=[]
 registerDataExportPreviewRoute(app,{requireUser:async(req,reply)=>{if(req.headers.authorization!=='user')await reply.code(401).send({detail:'需要认证'})},ownerIdFromRequest:()=> 'trusted-owner',read:async owner=>{calls.push(owner);throw Error('synthetic-storage-failure')}})
 try{assert.equal((await app.inject('/api/v1/data-portability/export/preview')).statusCode,401);assert.deepEqual(calls,[]);assert.equal((await app.inject({method:'GET',url:'/api/v1/data-portability/export/preview?owner=untrusted',headers:{authorization:'user'}})).statusCode,500);assert.deepEqual(calls,['trusted-owner'])}finally{await app.close()}
})
