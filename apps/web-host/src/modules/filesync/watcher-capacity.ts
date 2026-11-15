import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {createWatcherCapacityExpander,WatcherCapacityAtLimit,WatcherCapacityUnavailable} from '@gugu/core/filesync/watcher-capacity'
export function registerWatcherCapacityRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;request:()=>Promise<Record<string,unknown>>}):void {
 const expand=createWatcherCapacityExpander(options.request)
 app.post('/api/v1/admin/filesync/watcher-capacity/expand',{preHandler:options.requireAdmin},async(_request,reply)=>{
  try{return await expand()}catch(error){if(error instanceof WatcherCapacityAtLimit)return reply.code(409).send({detail:error.message});if(error instanceof WatcherCapacityUnavailable)return reply.code(503).send({detail:error.message});throw error}
 })
}
