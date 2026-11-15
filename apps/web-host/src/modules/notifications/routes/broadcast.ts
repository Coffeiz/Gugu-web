import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'
import {NotificationBroadcastError,type NotificationBroadcastInput} from '@gugu/core/notifications/broadcast'
const boolean=z.preprocess(value=>{
 if(typeof value==='string'){if(['true','1','yes','y','on','t'].includes(value.toLowerCase()))return true;if(['false','0','no','n','off','f'].includes(value.toLowerCase()))return false}
 if(value===1)return true;if(value===0)return false;return value
},z.boolean())
const body=z.object({title:z.string().default(''),content:z.string().default(''),color:z.string().default('#7b7fb2'),target:z.string().default('all'),bubble:boolean.default(true),persist:boolean.default(true),bubble_ttl_hours:z.preprocess(value=>typeof value==='boolean'?Number(value):typeof value==='string'&&/^[+-]?\d+(?:\.0+)?$/.test(value.trim())?Number(value):value,z.number().int().safe().nullable()).optional().default(null)})
export function registerNotificationBroadcastRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;broadcast(input:NotificationBroadcastInput):Promise<{ok:true;id:number}>}):void{
 app.post('/api/v1/admin/notifications/broadcast',{preHandler:options.requireAdmin},async(request,reply)=>{
  const parsed=body.safeParse(request.body);if(!parsed.success)return reply.code(422).send({detail:'通知请求无效'})
  try{return await options.broadcast(parsed.data)}catch(error){if(error instanceof NotificationBroadcastError)return reply.code(400).send({detail:error.message});throw error}
 })
}
