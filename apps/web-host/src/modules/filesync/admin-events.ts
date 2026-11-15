import {Readable} from 'node:stream'
import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {serializeLiveMessage} from '@gugu/core/live-message'
import {RedisLiveSubscriptionError,type LiveSubscriptionFactory} from '../../adapters/redis-live-subscription.js'

export interface AdminFileSyncEventsOptions{
 requireAdmin:preHandlerHookHandler
 subscribe:LiveSubscriptionFactory
}
async function* streamEvents(options:AdminFileSyncEventsOptions,signal:AbortSignal){
 let subscription:Awaited<ReturnType<LiveSubscriptionFactory>>|null=null
 try{
  subscription=await options.subscribe(['events:filesync-admin'])
  yield ': connected\n\n'
  while(!signal.aborted){
   const message=await subscription.next(signal)
   if(message===null)return
   const frame=serializeLiveMessage(message.data)
   if(frame)yield frame
  }
 }catch(error){
  if(signal.aborted)return
  if(error instanceof RedisLiveSubscriptionError){yield ': live connection reset; client will reconnect\n\n';return}
  throw error
 }finally{
  try{await subscription?.close()}catch{/* 与Python一致：断连清理不向浏览器泄露Redis错误。 */}
 }
}
/** 管理员失效频道不订阅用户或广播频道，也不创建数据库会话。 */
export function registerAdminFileSyncEventsRoute(app:FastifyInstance,options:AdminFileSyncEventsOptions):void{
 app.get('/api/v1/admin/filesync/events',{preHandler:options.requireAdmin},(_request,reply)=>{
  const abort=new AbortController(),abortStream=()=>abort.abort()
  reply.raw.once('close',abortStream)
  const stream=Readable.from(streamEvents(options,abort.signal))
  stream.once('close',()=>reply.raw.off('close',abortStream))
  return reply.type('text/event-stream; charset=utf-8').header('Cache-Control','no-cache, no-transform').header('Connection','keep-alive').header('X-Accel-Buffering','no').send(stream)
 })
}
