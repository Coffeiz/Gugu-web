import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {embeddingDimensions,probeEmbedding,type EmbeddingProbeSettings,type EmbeddingProbeInput} from '@gugu/core/preferences/embedding-probe'
import {NodeProviderTransport} from '@gugu/core/providers/node'
import {readConfigOverride} from '../../adapters/config-override-file.js'
import {pythonQueryBoolean} from '../../http/python-query.js'
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function parse(body:unknown):EmbeddingProbeInput {
 if(!object(body))throw new Error('参数无效')
 const out:EmbeddingProbeInput={}
 for(const key of ['provider','base_url','api_key','model'] as const){if(body[key]!==undefined){if(typeof body[key]!=='string')throw new Error('参数无效');out[key]=body[key]}}
 if(body.multimodal!==undefined){const value=body.multimodal;if(Array.isArray(value)||value===null)throw new Error('参数无效');out.multimodal=value===0||value===1?Boolean(value):pythonQueryBoolean(value)}
 out.dimensions=embeddingDimensions(body.dimensions);return out
}
/** 只读动态配置；不触发向量生成、索引重建或配置保存。 */
export function createEmbeddingFileProbe(env:NodeJS.ProcessEnv,path:string) {
 return async(input:EmbeddingProbeInput)=>{
  const normalized=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toUpperCase(),value]))
  let base:unknown={};if(normalized.EMBEDDING!==undefined)base=JSON.parse(normalized.EMBEDDING)
  if(!object(base))throw new Error('向量模型环境配置无效')
  const values:Record<string,unknown>={provider:'',base_url:'',api_key:'',model:'',dimensions:0,...base}
  for(const key of ['provider','base_url','api_key','model','dimensions'])if(normalized[`EMBEDDING__${key.toUpperCase()}`]!==undefined)values[key]=normalized[`EMBEDDING__${key.toUpperCase()}`]
  const override=readConfigOverride(path).embedding
  if(override!==undefined){if(!object(override))throw new Error('向量模型配置无效');Object.assign(values,override)}
  for(const key of ['provider','base_url','api_key','model'])if(typeof values[key]!=='string')throw new Error('向量模型配置无效')
  const settings={...values,dimensions:embeddingDimensions(values.dimensions)} as unknown as EmbeddingProbeSettings
  const transport=new NodeProviderTransport({allowLocal:true,environment:()=>env})
  try{return await probeEmbedding(input,settings,transport)}finally{await transport.close()}
 }
}
export function registerEmbeddingProbeRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;probe:ReturnType<typeof createEmbeddingFileProbe>}):void {
 app.post('/api/v1/admin/config/test-embedding',{preHandler:options.requireAdmin},async(request,reply)=>{
  let body:EmbeddingProbeInput;try{body=parse(request.body)}catch{return reply.code(422).send({detail:'Embedding 测试参数无效'})}
  try{return await options.probe(body)}catch{return reply.code(503).send({detail:'Embedding 配置不可读取'})}
 })
}
