import {createHash} from 'node:crypto'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'
import {pydanticIntegerInput} from './dto.js'
import {listProviderModels} from '@gugu/core/providers'
import {createNodeProviderTransport} from '@gugu/core/providers/node'
import {stableJson} from '@gugu/core/agent'
import type {createCredentialModelsPreview} from '@gugu/core/byok/credential-models-preview'

const schema=z.object({provider:z.string().min(1).max(64),api_format:z.string().max(32).default(''),base_url:z.string().max(500).default(''),model:z.string().max(200).default(''),api_key:z.string().max(20000).default(''),credential_id:z.preprocess(pydanticIntegerInput,z.number().int().nullable().optional())})
export interface CredentialModelsPreviewOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;preview:ReturnType<typeof createCredentialModelsPreview>}

/** 查询真实 Provider 模型目录，沿用 Provider 的 DNS 固定、地址校验及禁止重定向传输。 */
export function createByokModelsPreviewFetcher(environment:NodeJS.ProcessEnv){
 return async(input:{provider:string;apiFormat:string;baseUrl:string;apiKey:string;model:string}):Promise<readonly string[]>=>{
  let provider=input.provider,apiFormat=input.apiFormat,baseUrl=input.baseUrl
  if(provider==='qwen'&&apiFormat==='dashscope'){
   if(baseUrl==='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1'
   apiFormat='openai'
  }
  const transport=createNodeProviderTransport({allowLocal:['local','ollama'].includes(provider.trim().toLowerCase()),connectTimeoutMs:8000,environment:()=>environment})
  try{
   const rows=await listProviderModels({provider,api_format:apiFormat,base_url:baseUrl,api_key:input.apiKey,model:input.model||'model-list',timeout_ms:8000},{transport,digest:value=>createHash('sha256').update(stableJson(value)).digest('hex')},AbortSignal.timeout(8000))
   return [...new Set(rows.flatMap(row=>row&&typeof row==='object'&&!Array.isArray(row)&&typeof (row as Record<string,unknown>).id==='string'&&(row as Record<string,unknown>).id?[(row as Record<string,unknown>).id as string]:[]))].sort()
  }finally{await transport.close()}
 }
}

export function registerCredentialModelsPreviewRoute(app:FastifyInstance,options:CredentialModelsPreviewOptions):void{
 app.post('/api/v1/byok/models-preview',{preHandler:options.requireUser},async(request,reply)=>{
  const body=schema.safeParse(request.body)
  if(!body.success)return reply.code(422).send({detail:'凭据参数无效'})
  return options.preview(options.ownerIdFromRequest(request),body.data)
 })
}
