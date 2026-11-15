import {maskSecret} from '../../shared/secret-mask.js'
import {strip} from '../../shared/values.js'
import {ensureLlmPresets,LlmStrategyConfigurationError,type LlmStrategyMutator} from './llm-strategy.js'
import {llmAiSegment} from './llm-preset-selection.js'

type Input=Record<string,unknown>
export class LlmPresetMutationError extends Error {
 override name='LlmPresetMutationError'
 constructor(readonly status:404|422,message:string){super(message)}
}
const fields=['name','provider','base_url','model','max_tokens','context_tokens','thinking','reasoning_effort','reasoning_persistence','image','video','audio','web_search_enabled','image_detail','api_format','ollama_mode','ollama_api_mode','ollama_keep_alive','deployment_mode','local_runtime','in_pool'] as const
function normalized(value:unknown):string{return strip(String(value||'')).toLowerCase()}
/** 与Python配置策略一致；本判断不等于Provider网络探测或能力快照。 */
function supportsSearch(provider:unknown,format:unknown):boolean{
 const name=normalized(provider),apiFormat=normalized(format||'openai')
 return ['minimax','glm','deepseek','mimo','ollama'].includes(name)||(name==='qwen'&&['openai','responses'].includes(apiFormat))
}
function tokens(max:unknown,context:unknown):void{
 if(Number(max)>=Number(context))throw new LlmPresetMutationError(422,'最大输出 token 数必须小于模型总上下文窗口')
}
function imageDetail(value:unknown):unknown{return ['auto','low','high','original'].includes(String(value))?value:'auto'}
/** 配置写入完成后失效推理状态；DB失败不回滚已经提交的文件，符合Python顺序。 */
export function createLlmPresetMutations(mutate:LlmStrategyMutator,invalidate:()=>Promise<number>,newId:()=>string){
 const commit=async<T>(work:(doc:Input,presets:Input)=>T):Promise<T>=>{
  let result:T
  try{result=await mutate(doc=>work(doc,ensureLlmPresets(doc)))}catch(error){if(error instanceof LlmPresetMutationError)throw error;throw new LlmStrategyConfigurationError('暂时无法保存模型配置')}
  await invalidate();return result
 }
 return {
  create(input:Input){
   const item:Input={...llmAiSegment({provider:input.provider,api_key:'',base_url:'',model:''}),name:input.name}
   for(const key of [...fields.filter(field=>field!=='in_pool'),'api_key','capability_overrides','capability_checked_at','capability_fingerprint'])if(Object.hasOwn(input,key))item[key]=input[key]
   tokens(item.max_tokens,item.context_tokens)
   const supported=supportsSearch(item.provider,item.api_format)
   item.web_search_enabled=input.web_search_enabled==null?supported:input.web_search_enabled
   if(item.web_search_enabled&&!supported)throw new LlmPresetMutationError(422,'当前 Provider 或 API 格式不支持联网搜索')
   item.image_detail=imageDetail(item.image_detail);item.id=newId()
   return commit((doc,presets)=>{
    if(!Array.isArray(presets.items))throw new LlmStrategyConfigurationError()
    presets.items.push(item)
    if(!presets.active_id){presets.active_id=item.id;doc.ai=llmAiSegment(item)}
    return {...item,api_key:maskSecret(item.api_key as string)}
   })
  },
  update(id:string,input:Input){return commit((doc,presets)=>{
   if(!Array.isArray(presets.items))throw new LlmStrategyConfigurationError()
   const item=presets.items.find(value=>value&&typeof value==='object'&&(value as Input).id===id) as Input|undefined
   if(!item)throw new LlmPresetMutationError(404,'预设不存在')
   if(input.web_search_enabled===true&&!supportsSearch(input.provider??item.provider,input.api_format??item.api_format))throw new LlmPresetMutationError(422,'当前 Provider 或 API 格式不支持联网搜索')
   tokens(input.max_tokens??item.max_tokens??25600,input.context_tokens??item.context_tokens??128000)
   for(const key of fields)if(input[key]!=null)item[key]=key==='image_detail'?imageDetail(input[key]):input[key]
   if(!supportsSearch(item.provider,item.api_format))item.web_search_enabled=false
   if(input.api_key)item.api_key=input.api_key
   if(input.capability_overrides!=null){item.capability_overrides=input.capability_overrides;item.capability_checked_at='';item.capability_fingerprint=''}
   if(presets.active_id===id)doc.ai=llmAiSegment(item)
   return {...item,api_key:maskSecret(item.api_key as string)}
  })},
 }
}
