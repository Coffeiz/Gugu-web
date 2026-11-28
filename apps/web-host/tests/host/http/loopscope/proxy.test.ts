import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import test from 'node:test'
import Fastify from 'fastify'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import {registerLoopScopeProxyRoutes} from '../../../../src/modules/loopscope/proxy.js'

test('LoopScope只读代理先鉴权，保留重复query和安全响应头且不跟随重定向',async()=>{
 const calls:Array<{url:string|undefined;auth:string|undefined;cookie:string|undefined}>=[]
 const resolvedHosts:string[]=[]
 const upstream=createServer((request,response)=>{
  calls.push({url:request.url,auth:request.headers.authorization,cookie:request.headers.cookie})
  response.setHeader('x-private-header','synthetic-private')
  if(request.url?.startsWith('/api/health')){response.writeHead(302,{location:'/forbidden'});response.end('redirect');return}
  response.setHeader('content-type','application/json');response.setHeader('etag','synthetic-etag');response.end('{"ok":true}')
 })
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address!=='string')
 const transport=createNodeProviderTransport({allowLocal:true,resolve:async hostname=>{resolvedHosts.push(hostname);return [{address:'127.0.0.1',family:4}]},environment:()=>({})})
 const app=Fastify();registerLoopScopeProxyRoutes(app,{endpoint:`http://collector.test:${address.port}`,transport,requireUser:async(request,reply)=>{if(request.headers.authorization!=='synthetic-user')return reply.code(401).send({detail:'需要用户身份'})}})
 try{
  assert.equal((await app.inject({url:'/api/v1/dev/loopscope/sessions'})).statusCode,401);assert.equal(calls.length,0)
  const headers={authorization:'synthetic-user',cookie:'synthetic-cookie'}
  assert.equal((await app.inject({url:'/api/v1/dev/loopscope/private',headers})).statusCode,404);assert.equal(calls.length,0)
  const response=await app.inject({url:'/api/v1/dev/loopscope/sessions?tag=a&tag=b',headers});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{ok:true});assert.equal(response.headers.etag,'synthetic-etag');assert.equal(response.headers['x-private-header'],undefined)
  assert.equal(resolvedHosts[0],'collector.test')
  assert.deepEqual(calls[0],{url:'/api/sessions?tag=a&tag=b',auth:undefined,cookie:undefined})
  assert.equal((await app.inject({url:'/api/v1/dev/loopscope/health',headers})).statusCode,302);assert.equal(calls.length,2)
  assert.equal((await app.inject({url:'/api/v1/dev/loopscope/sessions?token=synthetic-secret',headers})).statusCode,503);assert.equal(calls.length,2)
 }finally{await app.close();await transport.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()))}
})
