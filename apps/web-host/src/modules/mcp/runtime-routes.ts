import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'

export interface McpRuntimeOperations {
 load(owner:string,serverId:string):Promise<{ok:boolean;state:string;tool_count:number;tool_names:string[];error:string|null}>
 reconnect(owner:string,serverId:string):Promise<{ok:boolean;state:string;tool_count:number;tool_names:string[];error:string|null}>
 tools(owner:string,serverId:string):Promise<{server_id:string;state:string;loaded_tool_count:number;last_error:string|null}>
 close?():Promise<void>
}
export interface McpRuntimeRouteOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 runtime:McpRuntimeOperations
}
function missing(reply:any,error:unknown){if(Number((error as {statusCode?:unknown})?.statusCode)===404)return reply.code(404).send({detail:'MCP server 不存在'});throw error}
/** MCP 运行时操作维持 Python 管理 API 的 owner 限定及状态 DTO。 */
export function registerMcpRuntimeRoutes(app:FastifyInstance,options:McpRuntimeRouteOptions):void{
 app.post<{Params:{server_id:string}}>('/api/v1/mcp/servers/:server_id/load_status',{preHandler:options.requireUser},async(request,reply)=>{
  try{return await options.runtime.load(options.ownerIdFromRequest(request),request.params.server_id)}catch(error){return missing(reply,error)}
 })
 app.post<{Params:{server_id:string}}>('/api/v1/mcp/servers/:server_id/reconnect',{preHandler:options.requireUser},async(request,reply)=>{
  try{return await options.runtime.reconnect(options.ownerIdFromRequest(request),request.params.server_id)}catch(error){return missing(reply,error)}
 })
 app.get<{Params:{server_id:string}}>('/api/v1/mcp/servers/:server_id/tools',{preHandler:options.requireUser},async(request,reply)=>{
  try{return await options.runtime.tools(options.ownerIdFromRequest(request),request.params.server_id)}catch(error){return missing(reply,error)}
 })
}
