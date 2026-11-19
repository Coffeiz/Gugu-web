import {adapterFor} from '../agent/providers/registry.js'

export interface CredentialDestination {
 provider:string;api_format:string;base_url:string;model:string;capability:string
}
export const BYOK_DESTINATION_MISMATCH_MESSAGE='Provider 或自定义 Endpoint 已变更。请确认目标地址；如地址已更换，请重新填写 API Key'

function effectiveOrigin(value:Pick<CredentialDestination,'provider'|'api_format'|'base_url'|'model'>):string|null{
 try{
  if(value.provider==='minimax'&&value.api_format==='minimax-asr')return 'https://api.minimax.cn:443'
  const config={provider:value.provider,api_format:value.api_format||undefined,base_url:value.base_url||undefined,model:value.model||''}
  const parsed=new URL(adapterFor(config).baseUrl(config).trim())
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port||(parsed.protocol==='https:'?'443':'80')}`
 }catch{return null}
}
function defaultOrigin(provider:string,apiFormat:string,model:string):string|null{
 try{
  if(provider==='minimax'&&apiFormat==='minimax-asr')return 'https://api.minimax.cn:443'
  const config={provider,api_format:apiFormat||undefined,base_url:undefined,model:model||''}
  const policy=adapterFor(config)
  if(apiFormat&&!policy.supportedApiFormats(config).includes(apiFormat as never))return null
  const parsed=new URL(policy.baseUrl(config))
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port||(parsed.protocol==='https:'?'443':'80')}`
 }catch{return null}
}

/** BYOK 密钥只能复用于同 Provider、同 origin 的目的地。 */
export function canReuseByokKeyForDestination(stored:CredentialDestination,target:CredentialDestination):boolean{
 if(stored.provider!==target.provider)return false
 const storedOrigin=effectiveOrigin(stored),targetOrigin=effectiveOrigin(target)
 if(storedOrigin&&targetOrigin&&storedOrigin===targetOrigin)return true
 if(stored.capability!=='llm'||(stored.model||'')!==(target.model||''))return false
 const oldConfig={provider:stored.provider,api_format:stored.api_format||undefined,model:stored.model||''}
 let oldFormat:string
 try{oldFormat=stored.api_format||adapterFor(oldConfig).protocol({...oldConfig,api_format:undefined})}catch{return false}
 if(!target.api_format||oldFormat===target.api_format)return false
 const oldDefault=defaultOrigin(stored.provider,oldFormat,stored.model)
 const targetDefault=defaultOrigin(target.provider,target.api_format,target.model)
 return Boolean(oldDefault&&targetDefault&&oldDefault===storedOrigin&&targetDefault===targetOrigin)
}


export function allowsEmptyByokKey(capability: string, provider: string, url: string): boolean {
  return capability === 'embedding' && (provider === 'local' || (provider === 'ollama' && !url.includes('ollama.com')))
}

export function supportsByokWebSearch(provider: string, format: string): boolean {
  const name = provider.trim().toLowerCase()
  const protocol = (format || 'openai').trim().toLowerCase()
  return ['minimax', 'glm', 'deepseek', 'mimo', 'ollama'].includes(name)
    || (name === 'qwen' && ['openai', 'responses'].includes(protocol))
}
