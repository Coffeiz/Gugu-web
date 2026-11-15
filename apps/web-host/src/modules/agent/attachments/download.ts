import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {FileHandle} from 'node:fs/promises'
export interface AttachmentDownloadOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 download(ownerId:string,attachId:string):Promise<{
  handle:FileHandle;size:number;fileName:string;mimeType:string;ext?:string;kind?:string|null;qqFace?:boolean
 }>
}
export function registerAttachmentDownloadRoute(app:FastifyInstance,options:AttachmentDownloadOptions):void{
 app.get<{Params:{attach_id:string}}>('/api/v1/agent/attachment/:attach_id/download',{preHandler:options.requireUser},async(request,reply)=>{
  const source=await options.download(options.ownerIdFromRequest(request),request.params.attach_id)
  try{
   const encoded=encodeURIComponent(source.fileName).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)
   const mimeType=source.mimeType.startsWith('text/')&&!source.mimeType.toLowerCase().includes('charset=')?`${source.mimeType}; charset=utf-8`:source.mimeType
   reply.type(mimeType).header('Content-Disposition',`attachment; filename*=UTF-8''${encoded}`).header('Cache-Control','private, max-age=300').header('Content-Length',String(source.size))
   return reply.send(source.handle.createReadStream({autoClose:true}))
  }catch(error){await source.handle.close();throw error}
 })
}
