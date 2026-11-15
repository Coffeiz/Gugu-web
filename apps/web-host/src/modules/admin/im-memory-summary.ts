import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createImMemorySummaryReader} from '@gugu/core/im-memory-summary'

export interface ImMemorySummaryOptions {
 requireAdmin:preHandlerHookHandler
 read:ReturnType<typeof createImMemorySummaryReader>
}

/** 维护预览和汇总使用同一只读用例，不触发模型或维护任务。 */
export function registerImMemorySummaryRoutes(app:FastifyInstance,options:ImMemorySummaryOptions):void {
 app.get('/api/v1/admin/agent/memory/im-scopes',{preHandler:options.requireAdmin},()=>options.read())
 app.post('/api/v1/admin/agent/memory/im-scopes/maintenance/preview',{preHandler:options.requireAdmin},()=>options.read())
}
