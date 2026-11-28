import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {createMcpServerListReader,registerMcpServerListRoute} from '../../src/modules/mcp/server-list.js'

test('MCP 设置列表从认证 owner 读取配置且不触发运行时发现',async()=>{
 const app=Fastify(),calls:string[]=[]
 registerMcpServerListRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='Bearer valid')return reply.code(401).send()},ownerIdFromRequest:()=> 'trusted-owner',read:async owner=>{calls.push(owner);return {enabled:true,max_servers:10,items:[{id:'s1',state:'unloaded',loaded_tool_count:0,loaded_tool_names:[]}]}}})
 try{
  assert.equal((await app.inject({method:'GET',url:'/api/v1/mcp/servers'})).statusCode,401)
  assert.deepEqual(calls,[])
  const response=await app.inject({method:'GET',url:'/api/v1/mcp/servers',headers:{authorization:'Bearer valid'}})
  assert.equal(response.statusCode,200,response.body)
  assert.deepEqual(response.json(),{enabled:true,max_servers:10,items:[{id:'s1',state:'unloaded',loaded_tool_count:0,loaded_tool_names:[]}]})
  assert.deepEqual(calls,['trusted-owner'])
 }finally{await app.close()}
})

test('MCP 配置编辑列表解密 owner 自己的 endpoint/凭据并保持未加载状态',async()=>{
 const owners:string[]=[],settings={enabled:true,max_servers_per_user:10}
 const read=createMcpServerListReader({
  async list(owner){owners.push(owner);return [{id:'s1',name:'weather',scope:'user',transport:'http',endpoint:'',encrypted_endpoint:'endpoint-cipher',endpoint_nonce:'n',encrypted_endpoint_key:'k',endpoint_key_version:1,command:'',credential_slots:[{id:'key',label:'Key',target:'header',name:'Authorization',prefix:'Bearer '}],encrypted_credentials:'credentials-cipher',credentials_nonce:'n',encrypted_credentials_key:'k',credentials_key_version:1,encrypted_headers:'',headers_nonce:'',encrypted_headers_key:'',headers_key_version:1,encrypted_query_params:'',query_params_nonce:'',encrypted_query_params_key:'',query_params_key_version:1,enabled:true,confirm_mode:'confirm_all',timeout_seconds:30,tool_allowlist:[],created_at:'2026-01-01T00:00:00Z'}] as never},
  decrypt:{async decrypt(input){return input.ciphertext==='endpoint-cipher'?'https://mcp.example/rpc':JSON.stringify({key:'synthetic-secret'})}},settings:()=>settings,
 })
 const result=await read('trusted-owner')
 assert.deepEqual(owners,['trusted-owner'])
 const item=(result.items as Array<Record<string,any>>)[0]!
 assert.equal(item.endpoint,'https://mcp.example/rpc')
 assert.deepEqual(item.credential_values,{key:'synthetic-secret'})
 assert.equal(item.has_credentials,true)
 assert.equal(item.state,'unloaded')
 assert.deepEqual(item.loaded_tool_names,[])
 settings.max_servers_per_user=3
 assert.equal((await read('trusted-owner')).max_servers,3)
})
