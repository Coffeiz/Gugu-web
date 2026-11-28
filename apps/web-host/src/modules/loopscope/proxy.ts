import {Readable} from 'node:stream'
import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {ProviderTransport} from '@gugu/core/providers'
import {createLoopScopeClient} from '@gugu/loopscope'

export interface LoopScopeProxyOptions {requireUser:preHandlerHookHandler;endpoint:string;transport:ProviderTransport}
const responseHeaders=['content-type','cache-control','last-modified','etag']

/** 可信Host注入Collector地址；用户只能选择固定只读资源，不能传入上游URL。 */
export function registerLoopScopeProxyRoutes(app:FastifyInstance,options:LoopScopeProxyOptions):void{
 const client=createLoopScopeClient(options)
 const shutdown=new AbortController()
 app.addHook('preClose',async()=>{shutdown.abort()})
 app.get('/api/v1/dev/loopscope/*',{preHandler:options.requireUser},async(request,reply)=>{
  const path=(request.params as {'*':string})['*']
  const query=request.raw.url?.split('?').slice(1).join('?')??''
  const abort=new AbortController(),streaming=path==='events'
  const timer=setTimeout(()=>abort.abort(),streaming?5000:10000);timer.unref()
  let upstream:Awaited<ReturnType<typeof client.read>>
  try{
   upstream=await client.read(path,query,streaming?AbortSignal.any([abort.signal,shutdown.signal]):abort.signal)
  }catch{clearTimeout(timer);return reply.code(503).send({detail:'LoopScope Collector 暂不可用'})}
  if(!upstream){clearTimeout(timer);return reply.code(404).send({detail:'LoopScope 路径不存在'})}
  reply.code(upstream.status)
  for(const name of responseHeaders){const value=upstream.headers[name];if(value!==undefined)reply.header(name,value)}
  if(streaming&&upstream.status<400){
   clearTimeout(timer)
   reply.header('Cache-Control',upstream.headers['cache-control']??'no-cache, no-transform')
   if(!upstream.headers['content-type'])reply.header('Content-Type','text/event-stream; charset=utf-8')
   reply.header('X-Accel-Buffering','no')
   reply.raw.once('close',()=>{abort.abort();void upstream.cancel()})
   return reply.send(Readable.from(upstream.body))
  }
  try{
   const chunks:Buffer[]=[]
   for await(const chunk of upstream.body)chunks.push(Buffer.from(chunk))
   return reply.send(Buffer.concat(chunks))
  }
  catch{await Promise.resolve(upstream.cancel()).catch(()=>undefined);return reply.code(503).send({detail:'LoopScope Collector 暂不可用'})}
  finally{clearTimeout(timer)}
 })
}
