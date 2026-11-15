import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {NodeProviderTransport} from '../../../../packages/core/src/agent/providers/transport/node.js'
import {createMcpSafeFetch} from '../../src/modules/mcp/safe-fetch.js'

test('MCP 请求经过固定目标传输，拒绝跳转并可取消响应流',async()=>{
 let reached=false, closed=false
 const server=createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{location:'/target'});res.end();return}
  if(req.url==='/target'){reached=true;res.end();return}
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: hello\n\n');res.on('close',()=>{closed=true})
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=server.address();if(!address||typeof address==='string')throw new Error('地址无效')
 const base=`http://127.0.0.1:${address.port}`
 const transport=new NodeProviderTransport({allowLocal:true,trustEnvironment:false})
 const fetcher=createMcpSafeFetch({request:(request,signal)=>transport.request({...request,allowLocal:true},signal)})
 try{
  await assert.rejects(fetcher(`${base}/redirect`));assert.equal(reached,false)
  const response=await fetcher(`${base}/stream`);assert.equal(response.status,200)
  const reader=response.body!.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/hello/);await reader.cancel()
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(closed,true)
 }finally{await transport.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

 test('MCP 长连接取消时关闭底层请求',{timeout:5000},async()=>{
 let closed=false
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: ready\n\n');res.on('close',()=>{closed=true})})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=server.address();if(!address||typeof address==='string')throw new Error('地址无效')
 const transport=new NodeProviderTransport({allowLocal:true,trustEnvironment:false})
 const fetcher=createMcpSafeFetch({request:(request,signal)=>transport.request({...request,allowLocal:true},signal)})
 try{
  const abort=new AbortController();const response=await fetcher(`http://127.0.0.1:${address.port}/`,{signal:abort.signal});const reader=response.body!.getReader();await reader.read();abort.abort();await assert.rejects(reader.read());
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(closed,true)
 }finally{await transport.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
