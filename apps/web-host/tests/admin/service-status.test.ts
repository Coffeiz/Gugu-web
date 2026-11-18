import assert from 'node:assert/strict'
import test from 'node:test'
import {createServiceStatusReader} from '../../src/modules/admin/service-status.js'

test('服务面板读取 Node 生命周期与依赖，网关没有可重启实例',async()=>{
 const read=createServiceStatusReader({redis:{eval:async()=>JSON.stringify({length:4,pending:2,lag:1,consumers:1}),ping:async()=>true},dbOk:async()=>true,web:()=>({pid:12,host:'synthetic-node',uptime_secs:50}),worker:()=>({online:true,restartable:true})})
 const result=await read()
 assert.equal(result.services[0]!.pid,12)
 assert.equal(result.services[1]!.status,'offline')
 assert.equal(result.services[1]!.restartable,false)
 assert.equal(result.services[2]!.status,'online')
 assert.equal(result.services[2]!.pid,12)
 assert.equal(result.services[2]!.restartable,true)
 assert.deepEqual(result.queue,{length:4,pending:2,lag:1,consumers:1});assert.deepEqual(result.deps,{redis:true,db:true})
 const unavailable=createServiceStatusReader({redis:{eval:async()=>{throw new Error('合成断连')},ping:async()=>false},dbOk:async()=>false,web:()=>({pid:12,host:'synthetic-node',uptime_secs:50})})
 const failed=await unavailable();assert.deepEqual(failed.deps,{redis:false,db:false});assert.equal(failed.services[2]!.status,'offline');assert.deepEqual(failed.queue,{length:null,pending:null,lag:null,consumers:null})
})
