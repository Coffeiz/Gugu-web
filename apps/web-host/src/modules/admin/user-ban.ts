import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {createAdminUserBanToggle} from '@gugu/core/admin-user-ban'

export interface AdminUserBanOptions{
 requireAdmin:preHandlerHookHandler
 adminUsername(request:FastifyRequest):string
 toggle:ReturnType<typeof createAdminUserBanToggle>
}
export function registerAdminUserBanRoute(app:FastifyInstance,options:AdminUserBanOptions):void{
 app.patch<{Params:{user_id:string}}>('/api/v1/admin/users/:user_id/ban',{preHandler:options.requireAdmin},request=>{
  const forwarded=request.headers['x-forwarded-for']
  const ip=typeof forwarded==='string'?forwarded.split(',')[0]!.trim():request.ip||null
  return options.toggle(request.params.user_id,{operator:options.adminUsername(request),ip:ip===null?null:Array.from(ip).slice(0,60).join('')})
 })
}
