import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AdminNotificationHistoryRow } from '@gugu/core/notifications/admin-history'
import { z } from 'zod'
import { NotificationBroadcastError, type NotificationBroadcastInput } from '@gugu/core/notifications/broadcast'

export interface NotificationAdminHistoryOptions {
  requireAdmin: preHandlerHookHandler
  history(limit: number): Promise<AdminNotificationHistoryRow[]>
  deleteRecord(id: number): Promise<{ ok: true }>
}

/** HTTP 参数和管理员身份留在 Host；通知范围和删除语义由 Core 执行。 */
export function registerNotificationAdminHistoryRoutes(app: FastifyInstance, options: NotificationAdminHistoryOptions): void {
  app.get('/api/v1/admin/notifications/history', { preHandler: options.requireAdmin }, async (request, reply) => {
    const { limit = '50' } = request.query as Record<string, unknown>
    if (typeof limit !== 'string' || !/^[+-]?\d+$/.test(limit.trim()))
      return reply.code(422).send({ detail: 'limit 必须是整数' })
    const value = BigInt(limit.trim())
    return options.history(Number(value < 1n ? 1n : value > 100n ? 100n : value))
  })
  app.delete('/api/v1/admin/notifications/history/:nid', { preHandler: options.requireAdmin }, async (request, reply) => {
    const { nid } = request.params as { nid: string }
    if (!/^[+-]?\d+$/.test(nid.trim()) || !Number.isSafeInteger(Number(nid)))
      return reply.code(422).send({ detail: 'nid 必须是整数' })
    return options.deleteRecord(Number(nid))
  })
}

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
