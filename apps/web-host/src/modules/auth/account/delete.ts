import {CoreError} from '@gugu/core'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'

const bodySchema=z.object({password:z.string()})
export interface AccountDeleteOptions {
  requireUser:preHandlerHookHandler
  ownerIdFromRequest(request:FastifyRequest):string
  verifyPassword(ownerId:string,password:string):Promise<boolean>
  remove(ownerId:string):Promise<number>
}

export function registerAccountDeleteRoute(app:FastifyInstance,options:AccountDeleteOptions):void{
  app.delete('/api/v1/auth/me',{preHandler:options.requireUser},async(request,reply)=>{
    const body=bodySchema.safeParse(request.body)
    if(!body.success)return reply.code(422).send({detail:'账户注销参数无效'})
    const ownerId=options.ownerIdFromRequest(request)
    if(!await options.verifyPassword(ownerId,body.data.password))return reply.code(400).send({detail:'密码错误'})
    try{
      await options.remove(ownerId)
      return reply.code(204).send()
    }catch(error){
      if(error instanceof CoreError){
        const status=error.code==='not_found'?404:error.code==='conflict'?409:400
        return reply.code(status).send({detail:error.message})
      }
      throw error
    }
  })
}
