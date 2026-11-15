import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {DataExportPreview} from '@gugu/core/data-portability/export-preview'
export interface DataExportPreviewOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 read(ownerId:string):Promise<DataExportPreview>
}
export function registerDataExportPreviewRoute(app:FastifyInstance,options:DataExportPreviewOptions):void {
 app.get('/api/v1/data-portability/export/preview',{preHandler:options.requireUser},request=>options.read(options.ownerIdFromRequest(request)))
}
