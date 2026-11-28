import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import test from 'node:test'
import {NodeProviderTransport} from '../../../../packages/core/src/agent/providers/transport/node.js'
import {createMcpHttpClient} from '@gugu/core/mcp/sdk-client'
import {createMcpSafeFetch} from '@gugu/core/mcp/safe-fetch'

test('官方 MCP SDK 经注入的受控 fetch 完成握手、工具发现和调用',async()=>{
 const requests:string[]=[],server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk))
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}') as {id?:number;method?:string}
  requests.push(String(body.method))
  if(body.method==='notifications/initialized'){res.writeHead(202);res.end();return}
  const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}
   :body.method==='tools/list'?{tools:[{name:'ping',description:'ping tool',inputSchema:{type:'object',properties:{}}}]}
   :body.method==='tools/call'?{content:[{type:'text',text:'pong'}]}
   :undefined
  if(result===undefined){res.writeHead(404);res.end();return}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}))
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=server.address();assert.ok(address&&typeof address!=='string')
 const transport=new NodeProviderTransport({allowLocal:true,trustEnvironment:false})
 const client=createMcpHttpClient({endpoint:`http://127.0.0.1:${address.port}/mcp`,fetch:createMcpSafeFetch({request:(request,signal)=>transport.request({...request,allowLocal:true},signal)})})
 try{
  await client.connect()
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['ping'])
  assert.deepEqual((await client.callTool('ping',{})).content,[{type:'text',text:'pong'}])
  assert.ok(requests.includes('initialize'));assert.ok(requests.includes('tools/list'));assert.ok(requests.includes('tools/call'))
 }finally{await client.close();await transport.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('MCP SDK 工具发现遵守 Python 的八页防御上限',async()=>{
 let pages=0
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk))
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}') as {id?:number;method?:string;params?:{cursor?:string}}
  if(body.method==='notifications/initialized'){res.writeHead(202);res.end();return}
  const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}
   :body.method==='tools/list'?{tools:[{name:`tool-${++pages}`,inputSchema:{type:'object',properties:{}}}],nextCursor:String(pages)}
   :undefined
  if(result===undefined){res.writeHead(404);res.end();return}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}))
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=server.address();assert.ok(address&&typeof address!=='string')
 const transport=new NodeProviderTransport({allowLocal:true,trustEnvironment:false})
 const client=createMcpHttpClient({endpoint:`http://127.0.0.1:${address.port}/mcp`,fetch:createMcpSafeFetch({request:(request,signal)=>transport.request({...request,allowLocal:true},signal)})})
 try{
  await client.connect()
  await assert.rejects(client.listTools())
  assert.equal(pages,8)
 }finally{await client.close();await transport.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
