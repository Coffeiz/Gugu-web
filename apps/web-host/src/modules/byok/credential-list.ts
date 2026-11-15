import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {createByokListService} from '@gugu/core/agent/config'

export interface CredentialListOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 list:ReturnType<typeof createByokListService>
}

export function registerCredentialListRoute(app:FastifyInstance,options:CredentialListOptions):void{
 app.get('/api/v1/byok',{preHandler:options.requireUser},async request=>options.list(options.ownerIdFromRequest(request)))
}
