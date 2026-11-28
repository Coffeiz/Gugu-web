import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { ProviderConfig } from '@gugu/core/providers'
import { adapterFor,dashscopeAsrServiceForModel,MINIMAX_ASR_MAX_DURATION_SECONDS,MINIMAX_ASR_MAX_FILE_BYTES,normalizedApiKey } from '@gugu/core/providers'
import { activeVoiceTestSettings } from '@gugu/core/agent/config/voice-test'
import { supportsConfiguredVoiceModel } from '@gugu/core/agent/config/voice-availability'
import { normalizeOwnerId } from '../../../../shared/owner-context.js'
import { readConfiguredByokMasterKeys, decryptByokCredential } from '../../../byok/crypto.js'

interface Envelope {encrypted_value:string;nonce:string;encrypted_data_key:string;key_version:number}
interface Credential extends Envelope {id:number;provider:string;api_format:string;base_url:string;model:string}
export interface ImVoiceRecognitionProfile {configured:boolean;maxFileBytes:number;maxDurationSeconds:number|null;providerLabel:string|null;resolved:true}
export interface ImVoiceSelection {
  readonly ownerId:string
  /** 内部冻结选择版本；不得作为公开配置输出。 */
  readonly version:string
  readonly configured:boolean
  readonly profile:ImVoiceRecognitionProfile
  /** 仅供内部ASR调用；不可序列化/日志输出。 */
  readonly config:Readonly<ProviderConfig>|null
  readonly usage:{provider:string;model:string;isByok:boolean;credentialId:number|null}
  authorizeCurrent():Promise<boolean>
}
const invalid=()=>new Error('语音识别配置暂不可用'),denied=()=>new Error('语音识别未授权')
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const string=(v:unknown,max:number)=>{if(typeof v!=='string'||v.length>max)throw invalid();return v}
function json(raw:string):unknown{try{return JSON.parse(raw) as unknown}catch{throw invalid()}}
function bool(value:unknown):boolean{
  if(typeof value==='boolean')return value;if(value===0||value===1)return!!value
  if(typeof value==='string'){if(['1','true','t','yes','y','on'].includes(value.toLowerCase()))return true;if(['0','false','f','no','n','off'].includes(value.toLowerCase()))return false}
  throw invalid()
}
/** 只解析独立voice_presets；VOICE/AI模型不是Settings.voice属性的配置来源。 */
export function resolveImVoiceSettings(document:unknown,environment:NodeJS.ProcessEnv){
  if(!object(document))throw invalid()
  const env=Object.fromEntries(Object.entries(environment).filter((entry):entry is[string,string]=>entry[1]!==undefined).map(([key,value])=>[key.toUpperCase(),value]))
  let presets:unknown=env.VOICE_PRESETS===undefined?{}:json(env.VOICE_PRESETS)
  if(!object(presets))throw invalid()
  presets={...presets,...(env.VOICE_PRESETS__ACTIVE_ID!==undefined?{active_id:env.VOICE_PRESETS__ACTIVE_ID}:{}),
    ...(env.VOICE_PRESETS__ITEMS!==undefined?{items:json(env.VOICE_PRESETS__ITEMS)}:{})}
  // Python override整段model_validate，不能把环境items混进覆盖后的空集合。
  if('voice_presets'in document)presets=document.voice_presets??{}
  if(!object(presets))throw invalid()
  const active=presets.active_id??'',items=presets.items??[]
  string(active,200);if(!Array.isArray(items)||items.length>1000)throw invalid()
  const normalized=items.map(raw=>{
    if(!object(raw))throw invalid()
    const provider=raw.provider??'openai',format=raw.api_format??'openai',service=raw.dashscope_service??'qwen3-asr'
    if(!['openai','qwen','minimax','local'].includes(String(provider))||!['openai','dashscope','minimax-asr'].includes(String(format))
      ||!['qwen3-asr','qwen-audio','fun-asr'].includes(String(service))||!string(raw.name,80)||!string(raw.model,200))throw invalid()
    return{id:string(raw.id??'',200),name:raw.name,provider,model:raw.model,api_key:string(raw.api_key??'',4096),base_url:string(raw.base_url??'',500),api_format:format,dashscope_service:service}
  })
  const rootByok=env.BYOK===undefined?{}:json(env.BYOK),rootAi=env.AI===undefined?{}:json(env.AI)
  if(!object(rootByok)||!object(rootAi))throw invalid()
  const overrideByok=document.byok??{},overrideAi=document.ai??{}
  if(!object(overrideByok)||!object(overrideAi))throw invalid()
  const enabled=bool(overrideByok.enabled??env.BYOK__ENABLED??rootByok.enabled??true)
  const deployment=overrideAi.deployment_mode??env.AI__DEPLOYMENT_MODE??rootAi.deployment_mode??'cloud'
  if(typeof deployment!=='string')throw invalid()
  return{settings:activeVoiceTestSettings({voice_presets:{active_id:active,items:normalized}}),byokEnabled:enabled||deployment==='local'}
}

/** 当前账户与Bot授权由Host分别提供；只选择该owner独立speech_to_text凭据。 */
export function createImVoiceSelection(options:{pool:Pick<Pool,'query'>;document():unknown|Promise<unknown>;environment:NodeJS.ProcessEnv;
  authorize(ownerId:string):Promise<boolean>;decryptCredential?(envelope:Envelope):Promise<string>}){
  if(typeof options.document!=='function'||typeof options.authorize!=='function')throw invalid()
  let masterKeys:Readonly<Record<string,string>>|null=null
  async function allowed(ownerId:string){try{return await options.authorize(ownerId)===true}catch{throw invalid()}}
  async function resolve(ownerId:string,signal:AbortSignal){
    signal.throwIfAborted();if(!await allowed(ownerId))throw denied()
    let settings:ReturnType<typeof resolveImVoiceSettings>,row:Credential|undefined
    try{settings=resolveImVoiceSettings(await options.document(),options.environment)
      if(settings.byokEnabled){const result=await options.pool.query<Credential>(`SELECT c.id,c.provider,c.api_format,c.base_url,c.model,c.encrypted_value,c.nonce,c.encrypted_data_key,c.key_version
        FROM user_provider_credentials c JOIN users u ON u.id=c.user_id
        WHERE c.user_id=$1 AND c.capability='speech_to_text' AND c.enabled IS TRUE AND u.is_active IS TRUE
          AND COALESCE(u.account_status,'active')='active' ORDER BY c.id LIMIT 1`,[ownerId]);row=result.rows[0]}
    }catch{throw invalid()}
    let config:ProviderConfig={model:settings.settings.model??'',api_key:normalizedApiKey(settings.settings.api_key??''),base_url:settings.settings.base_url??'',
      api_format:settings.settings.api_format??'openai',dashscope_service:settings.settings.dashscope_service??'qwen3-asr'}
    // 本地请求豁免只来自可信预设的显式身份和目的地，不根据URL猜测。
    // 其他全局provider仍沿用Python Settings.voice的目的地选择，避免空base改变路由。
    if(settings.settings.provider==='local'&&config.base_url?.trim())config={...config,provider:'local'}
    let isByok=false,credentialId:number|null=null,supported=supportsConfiguredVoiceModel(config)
    if(row){
      let key:string;try{
        if(options.decryptCredential)key=await options.decryptCredential(row)
        else{masterKeys=await readConfiguredByokMasterKeys(options.environment);key=decryptByokCredential(row,version=>masterKeys?.[String(version)]??'')}
      }catch{throw invalid()}
      // key和目的地只来自此用户凭据。坏信封不得回落，也不继承平台ASR base_url。
      const provider=string(row.provider,100).trim(),format=string(row.api_format,32).trim().toLowerCase()||'openai',model=string(row.model,200).trim()
      let base=string(row.base_url,500).trim().replace(/\/+$/u,'')
      if(!base){try{base=adapterFor({provider,model,base_url:''}).baseUrl({provider,model,base_url:''}).trim().replace(/\/+$/u,'')}catch{base=''}}
      if(base){
        let service=config.dashscope_service
        if(format==='dashscope'){try{service=dashscopeAsrServiceForModel(model)}catch{throw invalid()}}
        config={provider,model:model||config.model,api_key:normalizedApiKey(key),base_url:base,api_format:format,dashscope_service:service}
        supported=supportsConfiguredVoiceModel({...config,model});isByok=true;credentialId=row.id
      }
    }
    signal.throwIfAborted();if(!await allowed(ownerId))throw denied()
    const minimax=supported&&config.api_format==='minimax-asr'&&(!isByok||config.provider==='minimax')
    const profile:ImVoiceRecognitionProfile={configured:supported,maxFileBytes:minimax?MINIMAX_ASR_MAX_FILE_BYTES:36*1024*1024,
      maxDurationSeconds:minimax?MINIMAX_ASR_MAX_DURATION_SECONDS:null,providerLabel:supported?(minimax?'MiniMax ASR':'语音识别服务'):null,resolved:true}
    const usage={provider:config.api_format==='minimax-asr'?'minimax':config.api_format==='dashscope'?'qwen':adapterFor(config).name,model:config.model,isByok,credentialId}
    return{config:supported?config:null,profile,usage,revision:createHash('sha256').update(JSON.stringify([settings,row??null,config])).digest('hex')}
  }
  return{async select(rawOwner:string,signal=new AbortController().signal):Promise<ImVoiceSelection>{
    const ownerId=normalizeOwnerId(rawOwner),selected=await resolve(ownerId,signal)
    const result={configured:selected.profile.configured,profile:Object.freeze(selected.profile),usage:Object.freeze(selected.usage),async authorizeCurrent(){
      try{return(await resolve(ownerId,signal)).revision===selected.revision}catch{return false}}}
    return Object.defineProperties(result,{config:{value:selected.config?Object.freeze(selected.config):null,enumerable:false},
      ownerId:{value:ownerId,enumerable:false},version:{value:selected.revision,enumerable:false}}) as ImVoiceSelection
  }}
}
