import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Fastify from 'fastify'
import {createMcpStatusReader} from '@gugu/core/mcp/status'
import {createMcpEnabledReader,createMcpSettingsReader,registerMcpStatusRoute} from '../../src/modules/mcp/status.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('MCP状态按默认/环境JSON/嵌套环境/override优先级热读，不连接server',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-mcp-status-')),path=join(root,'config.json')
 try{
  await writeFile(path,'{}')
  assert.deepEqual(await createMcpStatusReader(createMcpEnabledReader(path,{}))(),{enabled:true})
  assert.equal(createMcpEnabledReader(path,{MCP:'{"enabled":false}'})(),false)
  assert.equal(createMcpEnabledReader(path,{MCP:'{"enabled":false}',MCP__ENABLED:'true'})(),true)
  const read=createMcpStatusReader(createMcpEnabledReader(path,{MCP__ENABLED:'true'}))
  await writeFile(path,'{"mcp":{"enabled":false}}')
  assert.deepEqual(await read(),{enabled:false})
  await writeFile(path,'{"mcp":{"enabled":true}}')
  assert.deepEqual(await read(),{enabled:true})
  await writeFile(path,'{')
  await assert.rejects(read())
 }finally{await rm(root,{recursive:true,force:true})}
})

test('MCP limits follow Python env and override precedence and hot reload',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-mcp-settings-')),path=join(root,'config.json')
 try{
  await writeFile(path,'{}')
  const read=createMcpSettingsReader(path,{MCP:'{"enabled":false,"max_servers_per_user":7,"max_tools_per_server":21}'})
  assert.deepEqual(read(),{enabled:false,max_servers_per_user:7,max_tools_per_server:21})
  const explicit=createMcpSettingsReader(path,{MCP:'{"max_servers_per_user":7}',MCP__MAX_SERVERS_PER_USER:'5',MCP__MAX_TOOLS_PER_SERVER:'12'})
  assert.deepEqual(explicit(),{enabled:true,max_servers_per_user:5,max_tools_per_server:12})
  await writeFile(path,'{"mcp":{"max_servers_per_user":3,"max_tools_per_server":9}}')
  assert.deepEqual(explicit(),{enabled:true,max_servers_per_user:3,max_tools_per_server:9})
  await writeFile(path,'{')
  assert.throws(()=>explicit())
 }finally{await rm(root,{recursive:true,force:true})}
})

test('MCP状态HTTP未认证拒绝且状态读取异常脱敏',async()=>{
 const app=Fastify();installHttpErrorHandler(app)
 let fail=false,calls=0
 registerMcpStatusRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},read:async()=>{calls++;if(fail)throw new Error('synthetic-private-config');return {enabled:false}}})
 try{
  assert.equal((await app.inject('/api/v1/mcp/status')).statusCode,401);assert.equal(calls,0)
  const result=await app.inject({url:'/api/v1/mcp/status',headers:{authorization:'user'}})
  assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{enabled:false})
  fail=true
  const error=await app.inject({url:'/api/v1/mcp/status',headers:{authorization:'user'}})
  assert.equal(error.statusCode,500);assert.equal(error.body.includes('synthetic-private-config'),false)
 }finally{await app.close()}
})
