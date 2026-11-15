import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {writeRequestMetadata} from '../../http/request.js'
export interface TerminalDeleteOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 remove(ownerId:string,terminalId:string,origin:string|null):Promise<{deleted:boolean;terminalId:string}>
}
export function registerTerminalDeleteRoute(app:FastifyInstance,options:TerminalDeleteOptions):void{
 app.delete<{Params:{terminal_id:string}}>('/api/v1/terminals/:terminal_id',{preHandler:options.requireUser},request=>
  options.remove(options.ownerIdFromRequest(request),request.params.terminal_id,writeRequestMetadata(request).clientId))
}
