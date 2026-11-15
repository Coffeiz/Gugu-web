import {Readable} from 'node:stream'
import type {FastifyInstance,preHandlerHookHandler} from 'fastify'

export interface LoopScopeProxyOptions {requireUser:preHandlerHookHandler;endpoint:string}
const allowed=(path:string)=>['health','sessions','reflections','events'].includes(path)
 || /^sessions\/[A-Za-z0-9:_-]+\/runs$/.test(path)
 || /^runs\/[A-Za-z0-9_.:-]+(?:\/(?:spans|context|usage))?$/.test(path)
const responseHeaders=['content-type','cache-control','last-modified','etag']

/** 可信Host注入Collector地址；用户只能选择固定只读资源，不能传入上游URL。 */
export function registerLoopScopeProxyRoutes(app:FastifyInstance,options:LoopScopeProxyOptions):void{
 const base=options.endpoint.replace(/\/+$/,'')
 const parsed=new URL(base)
 if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('LoopScope Collector地址配置无效')
 app.get('/api/v1/dev/loopscope/*',{preHandler:options.requireUser},async(request,reply)=>{
  const path=(request.params as {'*':string})['*']
  if(!allowed(path))return reply.code(404).send({detail:'LoopScope 路径不存在'})
  const query=request.raw.url?.split('?').slice(1).join('?')??''
  const url=`${base}${base.endsWith('/api')?'':'/api'}/${path}${query?`?${query}`:''}`
  const abort=new AbortController(),streaming=path==='events'
  const timer=setTimeout(()=>abort.abort(),streaming?5000:10000);timer.unref()
  let upstream:Response
  try{
   upstream=await fetch(url,{redirect:'manual',signal:abort.signal,headers:streaming?{Accept:'text/event-stream'}:{}})
  }catch{clearTimeout(timer);return reply.code(503).send({detail:'LoopScope Collector 暂不可用'})}
  reply.code(upstream.status)
  for(const name of responseHeaders){const value=upstream.headers.get(name);if(value!==null)reply.header(name,value)}
  if(streaming&&upstream.status<400&&upstream.body){
   clearTimeout(timer)
   reply.header('Cache-Control',upstream.headers.get('cache-control')??'no-cache, no-transform')
   if(!upstream.headers.has('content-type'))reply.header('Content-Type','text/event-stream; charset=utf-8')
   reply.header('X-Accel-Buffering','no')
   reply.raw.once('close',()=>abort.abort())
   return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream))
  }
  try{return reply.send(Buffer.from(await upstream.arrayBuffer()))}
  catch{return reply.code(503).send({detail:'LoopScope Collector 暂不可用'})}
  finally{clearTimeout(timer)}
 })
}
