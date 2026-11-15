import assert from 'node:assert/strict'
import test from 'node:test'
import {createServiceStatusReader} from '../../src/modules/admin/service-status.js'

test('服务状态使用真实心跳的边界与Host自身事实，Redis故障明确显示不可用',async()=>{
 const values=new Map([['health:worker',JSON.stringify({pid:10,host:'synthetic-worker',ts:84,extra:{ready:true}})],['health:gateway',JSON.stringify({pid:11,host:'synthetic-gateway',ts:85})]])
 const read=createServiceStatusReader({redis:{get:async key=>values.get(key)??null,eval:async()=>JSON.stringify({length:4,pending:2,lag:1,consumers:1}),ping:async()=>true},dbOk:async()=>true,web:()=>({pid:12,host:'synthetic-node',uptime_secs:50}),now:()=>100})
 const result=await read()
 assert.equal(result.services[0]!.pid,12);assert.equal(result.services[1]!.status,'online');assert.equal(result.services[2]!.status,'stale')
 assert.deepEqual(result.queue,{length:4,pending:2,lag:1,consumers:1});assert.deepEqual(result.deps,{redis:true,db:true})
 const unavailable=createServiceStatusReader({redis:{get:async()=>{throw new Error('合成断连')},eval:async()=>{throw new Error('合成断连')},ping:async()=>false},dbOk:async()=>false,web:()=>({pid:12,host:'synthetic-node',uptime_secs:50}),now:()=>100})
 const failed=await unavailable();assert.deepEqual(failed.deps,{redis:false,db:false});assert.equal(failed.services[1]!.status,'offline');assert.deepEqual(failed.queue,{length:null,pending:null,lag:null,consumers:null})
})
