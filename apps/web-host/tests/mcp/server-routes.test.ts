import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerMcpServerRoutes} from '../../src/modules/mcp/servers.js'

test('MCP server 配置 API 保持认证、owner 参数与写后失效边界',async()=>{
 const app=Fastify(),calls:string[]=[]
 const operations={
  list:async(owner:string)=>{calls.push(`list:${owner}`);return {items:[]}},
  create:async(owner:string,input:Record<string,unknown>)=>{calls.push(`create:${owner}:${String(input.name)}`);return {id:'synthetic-id',...input}},
  update:async(owner:string,id:string,input:Record<string,unknown>)=>{calls.push(`update:${owner}:${id}`);return {id,...input}},
  remove:async(owner:string,id:string)=>{calls.push(`remove:${owner}:${id}`);return {deleted:true,id}},
 }
 registerMcpServerRoutes(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='Bearer valid')return reply.code(401).send()},ownerIdFromRequest:()=> 'owner-a',operations,
  invalidate:(owner,id)=>{calls.push(`invalidate:${owner}:${id}`)},refreshSnapshot:owner=>{calls.push(`refresh:${owner}`)}})
 try{
  assert.equal((await app.inject({method:'GET',url:'/api/v1/mcp/servers'})).statusCode,401)
  const created=await app.inject({method:'POST',url:'/api/v1/mcp/servers',headers:{authorization:'Bearer valid'},payload:{name:'weather',endpoint:'https://mcp.example/rpc'}})
  assert.equal(created.statusCode,201);assert.equal(created.json().name,'weather')
  assert.deepEqual(calls.slice(0,2),['create:owner-a:weather','refresh:owner-a'])
  const bad=await app.inject({method:'POST',url:'/api/v1/mcp/servers',headers:{authorization:'Bearer valid'},payload:{name:'bad name',endpoint:'https://mcp.example/rpc'}})
  assert.equal(bad.statusCode,400)
  await app.inject({method:'PATCH',url:'/api/v1/mcp/servers/synthetic-id',headers:{authorization:'Bearer valid'},payload:{enabled:false}})
  assert.deepEqual(calls.slice(-3),['update:owner-a:synthetic-id','invalidate:owner-a:synthetic-id','refresh:owner-a'])
 }finally{await app.close()}
})
