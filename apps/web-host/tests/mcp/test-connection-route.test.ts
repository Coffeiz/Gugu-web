import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerMcpConnectionTestRoute} from '../../src/modules/mcp/test-connection.js'

test('MCP 连接测试要求认证并将 owner/server 交给真实探测器',async()=>{
 const app=Fastify(),calls:string[][]=[]
 registerMcpConnectionTestRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='Bearer valid')return reply.code(401).send()},ownerIdFromRequest:()=> 'trusted-owner',test:async(owner,id)=>{calls.push([owner,id]);return {ok:true,tool_count:1,tools:['echo']}}})
 try{
  const url='/api/v1/mcp/servers/00000000-0000-4000-8000-000000000001/test_connection'
  assert.equal((await app.inject({method:'POST',url})).statusCode,401)
  assert.deepEqual(calls,[])
  const response=await app.inject({method:'POST',url,headers:{authorization:'Bearer valid'}})
  assert.equal(response.statusCode,200)
  assert.deepEqual(response.json(),{ok:true,tool_count:1,tools:['echo']})
  assert.deepEqual(calls,[['trusted-owner','00000000-0000-4000-8000-000000000001']])
 }finally{await app.close()}
})

test('MCP 连接失败保留 Python 的 ok/error/tools 结果，不伪装成成功',async()=>{
 const app=Fastify()
 registerMcpConnectionTestRoute(app,{requireUser:async()=>{},ownerIdFromRequest:()=> 'owner',test:async()=>({ok:false,error:'无法连接 MCP server，请检查地址与网络',tools:[],error_kind:'network',retryable:true})})
 try{
  const response=await app.inject({method:'POST',url:'/api/v1/mcp/servers/server/test_connection'})
  assert.equal(response.statusCode,200)
  assert.equal(response.json().ok,false)
  assert.deepEqual(response.json().tools,[])
  assert.equal(response.json().retryable,true)
 }finally{await app.close()}
})
