import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerMcpRuntimeRoutes} from '../../src/modules/mcp/runtime-routes.js'
import {createApp} from '../../src/app.js'
import {createUserToken} from '../../src/modules/auth/session/token.js'

test('MCP runtime API requires auth, derives owner and forwards load/reconnect/tools',async()=>{
 const app=Fastify(),calls:string[]=[]
 registerMcpRuntimeRoutes(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='Bearer valid')return reply.code(401).send()},ownerIdFromRequest:()=> 'trusted-owner',runtime:{
  load:async(owner,id)=>{calls.push(`load:${owner}:${id}`);return {ok:true,state:'ok',tool_count:1,tool_names:['mcp_weather_lookup'],error:null}},
  reconnect:async(owner,id)=>{calls.push(`reconnect:${owner}:${id}`);return {ok:true,state:'ok',tool_count:1,total_loaded:1,tool_names:['mcp_weather_lookup'],error:null}},
  tools:async(owner,id)=>{calls.push(`tools:${owner}:${id}`);return {server_id:id,state:'ok',loaded_tool_count:1,last_error:null}},
 }})
 try{
  assert.equal((await app.inject({method:'POST',url:'/api/v1/mcp/servers/server-a/load_status'})).statusCode,401)
  assert.deepEqual(calls,[])
  const loaded=await app.inject({method:'POST',url:'/api/v1/mcp/servers/server-a/load_status',headers:{authorization:'Bearer valid'}})
  assert.equal(loaded.statusCode,200);assert.equal(loaded.json().tool_count,1)
  const reconnected=await app.inject({method:'POST',url:'/api/v1/mcp/servers/server-a/reconnect',headers:{authorization:'Bearer valid'}})
  assert.equal(reconnected.statusCode,200);assert.deepEqual(reconnected.json(),{ok:true,state:'ok',tool_count:1,total_loaded:1,tool_names:['mcp_weather_lookup'],error:null})
  const tools=await app.inject({method:'GET',url:'/api/v1/mcp/servers/server-a/tools',headers:{authorization:'Bearer valid'}})
  assert.equal(tools.statusCode,200);assert.equal(tools.json().loaded_tool_count,1)
  assert.deepEqual(calls,['load:trusted-owner:server-a','reconnect:trusted-owner:server-a','tools:trusted-owner:server-a'])
 }finally{await app.close()}
})

test('MCP runtime API keeps missing owner resources as 404',async()=>{
 const app=Fastify()
 registerMcpRuntimeRoutes(app,{requireUser:async()=>{},ownerIdFromRequest:()=> 'owner',runtime:{
  load:async()=>{throw Object.assign(new Error('not found'),{statusCode:404})},reconnect:async()=>{throw Object.assign(new Error('not found'),{statusCode:404})},tools:async()=>{throw Object.assign(new Error('not found'),{statusCode:404})},
 }})
 try{const response=await app.inject({method:'GET',url:'/api/v1/mcp/servers/private/tools'});assert.equal(response.statusCode,404);assert.deepEqual(response.json(),{detail:'MCP server 不存在'})}finally{await app.close()}
})

test('MCP runtime routes are mounted behind the production user-auth domain and use its owner',async()=>{
 const owner='00000000-0000-4000-8000-000000000081',secret='synthetic-auth-secret',calls:string[]=[]
 const app=createApp({appName:'MCP runtime integration',isReady:async()=>true,userAuth:{secret,async lookupUser(id){return id===owner?{id,username:'sample',displayName:'示例',email:null,avatarUrl:null,createdAt:null,timezone:null,emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1}:null}},mcpRuntime:{runtime:{
  load:async(user,id)=>{calls.push(`${user}:${id}`);return {ok:true,state:'ok',tool_count:0,tool_names:[],error:null}},
  reconnect:async()=>({ok:true,state:'ok',tool_count:0,total_loaded:0,tool_names:[],error:null}),tools:async(user,id)=>({server_id:id,state:user===owner?'unloaded':'error',loaded_tool_count:0,last_error:null}),
 }}})
 try{
  const denied=await app.inject({method:'POST',url:'/api/v1/mcp/servers/s1/load_status'})
  assert.equal(denied.statusCode,401);assert.deepEqual(calls,[])
  const allowed=await app.inject({method:'POST',url:'/api/v1/mcp/servers/s1/load_status',headers:{authorization:`Bearer ${createUserToken(owner,1,secret)}`}})
  assert.equal(allowed.statusCode,200);assert.deepEqual(calls,[`${owner}:s1`])
 }finally{await app.close()}
})
