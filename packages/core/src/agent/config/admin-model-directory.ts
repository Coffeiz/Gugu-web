import {ensureLlmPresets} from './llm-strategy.js'
import type {createLlmModelDirectory,LlmModelDirectoryInput} from './llm-model-directory.js'

type Document=Record<string,unknown>
export class AdminModelDirectoryError extends Error {
 override name='AdminModelDirectoryError'
 constructor(readonly status:404|422|503,message:string){super(message)}
}
const record=(value:unknown):value is Document=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const text=(value:unknown,fallback='')=>value?value===true?'True':String(value):fallback
/** 共享用例负责选取凭据与目的地边界，Host只提供可信配置读取和受控HTTP出口。 */
export function createAdminModelDirectory(readDocument:()=>unknown|Promise<unknown>,readModels:ReturnType<typeof createLlmModelDirectory>){
 const document=async():Promise<Document>=>{
  try{const value=await readDocument();if(!record(value))throw new Error();return structuredClone(value)}catch{throw new AdminModelDirectoryError(503,'暂时无法读取模型配置')}
 }
 return {
  async saved(id:string){
   let presets:Document
   try{presets=ensureLlmPresets(await document());if(!Array.isArray(presets.items))throw new Error()}catch(error){if(error instanceof AdminModelDirectoryError)throw error;throw new AdminModelDirectoryError(503,'暂时无法读取模型配置')}
   const item=(presets.items as unknown[]).find(row=>record(row)&&row.id===id)
   if(!record(item))throw new AdminModelDirectoryError(404,'预设不存在')
   return readModels({provider:text(item.provider,'openai'),base_url:text(item.base_url),api_key:text(item.api_key),api_format:text(item.api_format)})
  },
  preview(input:LlmModelDirectoryInput){return readModels(input)},
  async voice(input:LlmModelDirectoryInput&{preset_id?:string}){
   const provider=input.provider??'openai',base=input.base_url??'';let key=input.api_key??''
   if(!key&&input.preset_id){
    const doc=await document(),raw=doc.voice_presets,items=record(raw)&&Array.isArray(raw.items)?raw.items:[]
    const item=items.find(row=>record(row)&&row.id===input.preset_id)
    if(!record(item))throw new AdminModelDirectoryError(404,'语音模型配置不存在')
    if(item.api_key&&(item.provider!==provider||text(item.base_url).replace(/\/+$/,'')!==base.replace(/\/+$/,'')))throw new AdminModelDirectoryError(422,'服务商或地址已变更，请重新填写 API Key')
    key=text(item.api_key)
   }
   if(!key&&provider!=='local')throw new AdminModelDirectoryError(422,'请先填写 API Key 或选择已保存的语音配置')
   return readModels({provider,api_key:key,base_url:base,api_format:input.api_format??''})
  },
 }
}
