import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
export interface TaskFilesystemRevokeOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 revoke(ownerId:string,taskId:number):Promise<{status:string;task_id:number;revoked:boolean}>
}
export function registerTaskFilesystemRevokeRoute(app:FastifyInstance,options:TaskFilesystemRevokeOptions):void{
 app.delete<{Params:{task_id:number}}>('/api/v1/scheduled-tasks/:task_id/filesystem-authorization',{
  preHandler:options.requireUser,schema:{params:{type:'object',required:['task_id'],properties:{task_id:{type:'integer'}}}},
 },request=>options.revoke(options.ownerIdFromRequest(request),request.params.task_id))
}
