import {maskSecret} from '../../shared/secret-mask.js'
import {length,strip} from '../../shared/values.js'
type Document=Record<string,unknown>
export type VoicePresetMutator=<T>(work:(document:Document)=>T)=>Promise<T>
export class VoicePresetMutationError extends Error {constructor(readonly statusCode:404|422,message:string){super(message)}}
export class VoicePresetMutationUnavailable extends Error {readonly statusCode=503;constructor(){super('暂时无法保存语音模型配置')}}
const fields=['name','provider','api_key','base_url','model','api_format','dashscope_service'] as const
const choices:Record<string,readonly string[]>={provider:['openai','qwen','minimax','local'],api_format:['openai','dashscope','minimax-asr'],dashscope_service:['qwen3-asr','qwen-audio','fun-asr']}
const record=(value:unknown):value is Document=>value!==null && typeof value==='object' && !Array.isArray(value)
function invalid(message='语音模型参数无效'):never{throw new VoicePresetMutationError(422,message)}
function parse(value:unknown,partial:boolean):Record<string,string> {
 if(!record(value))invalid()
 const result:Record<string,string>=partial?{}:{api_key:'',base_url:'',api_format:'openai',dashscope_service:'qwen3-asr'}
 for(const field of fields){
  const raw=value[field]
  if(partial && (raw===undefined || raw===null))continue
  if(raw===undefined){if(['name','provider','model'].includes(field))invalid();continue}
  if(typeof raw!=='string')invalid()
  if((field==='name' && (length(raw)<1||length(raw)>80))||(field==='model' && (length(raw)<1||length(raw)>200)))invalid()
  if(choices[field]&&!choices[field]!.includes(raw))invalid()
  result[field]=raw
 }
 return result
}
function normalized(values:Document):Document {
 const item:Record<string,string>={id:String(values.id??''),...parse(values,false)}
 const expected=item.provider==='qwen'?['dashscope','openai']:item.provider==='minimax'?['minimax-asr']:['openai']
 if(!expected.includes(item.api_format!))invalid('语音服务商与 API 格式不匹配')
 if(item.api_format==='dashscope'){
  const model=strip(item.model!).toLowerCase(),service=['qwen3-asr','qwen-audio','fun-asr'].find(prefix=>model.startsWith(prefix))
  if(!service)invalid('百炼原生语音模型须属于 Qwen3 ASR、Qwen-Audio 或 Fun-ASR 产品线')
  item.dashscope_service=service
 }
 item.name=strip(item.name!);if(!item.name)invalid('语音模型名称不能为空')
 return item
}
function collection(document:Document):Document&{items:Document[]} {
 if(document.voice_presets===undefined)document.voice_presets={active_id:'',items:[]}
 const raw=document.voice_presets
 if(!record(raw)||!Array.isArray(raw.items)||!raw.items.every(record))invalid('语音模型集合格式无效')
 return raw as Document&{items:Document[]}
}
function itemResponse(item:Document,active:unknown){return {...item,api_key:maskSecret(String(item.api_key||'')),has_api_key:Boolean(item.api_key),active:String(item.id||'')===String(active||'')}}
export function createVoicePresetMutations(mutate:VoicePresetMutator,generateId:()=>string) {
 const commit=async<T>(work:(document:Document)=>T):Promise<T>=>{try{return await mutate(work)}catch(error){if(error instanceof VoicePresetMutationError)throw error;throw new VoicePresetMutationUnavailable()}}
 const find=(presets:Document&{items:Document[]},id:string)=>{const item=presets.items.find(row=>String(row.id)===id);if(!item)throw new VoicePresetMutationError(404,'语音模型配置不存在');return item}
 return {
  async create(body:unknown){const values=parse(body,false),item=normalized({id:generateId(),...values});return commit(document=>{const presets=collection(document);presets.items.push(item);if(!presets.active_id)presets.active_id=item.id;return {active_id:presets.active_id,item:itemResponse(item,presets.active_id)}})},
  async update(id:string,body:unknown){const patch=parse(body,true);return commit(document=>{
   const presets=collection(document),item=find(presets,id)
   if(item.api_key&&!patch.api_key && ((patch.provider||item.provider)!==item.provider || String(patch.base_url??item.base_url).replace(/\/+$/,'')!==String(item.base_url).replace(/\/+$/,'')))invalid('服务商或地址已变更，请重新填写 API Key')
   const next={...item,...Object.fromEntries(Object.entries(patch).filter(([key,value])=>key!=='api_key'||Boolean(value)))},checked=normalized(next)
   presets.items[presets.items.indexOf(item)]=checked
   return {active_id:presets.active_id??'',item:itemResponse(checked,presets.active_id)}
  })},
  delete(id:string){return commit(document=>{const presets=collection(document);find(presets,id);presets.items=presets.items.filter(row=>String(row.id)!==id);if(String(presets.active_id||'')===id)presets.active_id='';return {deleted:id,active_id:presets.active_id??''}})},
  activate(id:string){return commit(document=>{const presets=collection(document);find(presets,id);presets.active_id=id;return {active_id:id}})},
  deactivate(){return commit(document=>{collection(document).active_id='';return {active_id:''}})},
 }
}
