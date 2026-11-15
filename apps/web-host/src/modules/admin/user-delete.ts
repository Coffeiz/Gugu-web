import {CoreError} from '@gugu/core'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'

export interface AdminUserDeleteOptions {
  requireAdmin:preHandlerHookHandler
  adminUsername(request:FastifyRequest):string
  deleteUser(userId:string):Promise<{username:string;storageObjectsRemoved:number}>
  writeAuditLog(username:string,action:'user',description:string,request:FastifyRequest):Promise<void>
}

const userIdSchema=z.string().uuid()
export function registerAdminUserDeleteRoute(app:FastifyInstance,options:AdminUserDeleteOptions):void{
  app.delete<{Params:{user_id:string}}>('/api/v1/admin/users/:user_id',{preHandler:options.requireAdmin},async(request,reply)=>{
    const id=userIdSchema.safeParse(request.params.user_id)
    if(!id.success)return reply.code(422).send({detail:'用户 ID 无效'})
    try{
      const result=await options.deleteUser(id.data)
      await options.writeAuditLog(options.adminUsername(request),'user',
        `删除用户 ${result.username}（存储对象清除 ${result.storageObjectsRemoved} 个）`,request)
      return {deleted:true,storage_objects_removed:result.storageObjectsRemoved}
    }catch(error){
      if(error instanceof CoreError){
        const status=error.code==='not_found'?404:error.code==='conflict'?409:400
        return reply.code(status).send({detail:error.message})
      }
      throw error
    }
  })
}
