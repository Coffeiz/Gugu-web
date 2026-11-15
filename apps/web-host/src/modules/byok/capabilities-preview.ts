import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'

const previewSchema=z.object({provider:z.string().min(1).max(64),api_format:z.string().max(32).default(''),base_url:z.string().max(500).default(''),model:z.string().max(200).default(''),ollama_api_mode:z.string().default('openai'),ollama_mode:z.string().default('local'),local_runtime:z.string().default('other')})
type PreviewInput=z.infer<typeof previewSchema>
export interface ProviderCapabilityPreviewOptions{
 requireUser:preHandlerHookHandler
 preview(input:PreviewInput):unknown
}
export function registerProviderCapabilityPreviewRoute(app:FastifyInstance,options:ProviderCapabilityPreviewOptions):void{
 app.post('/api/v1/byok/capabilities',{preHandler:options.requireUser},(request,reply)=>{
  const parsed=previewSchema.safeParse(request.body)
  if(!parsed.success)return reply.code(422).send({detail:'能力预览参数无效'})
  return options.preview(parsed.data)
 })
}
