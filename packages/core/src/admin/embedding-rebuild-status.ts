import {redactToolError} from '../agent/core.js'

/** 读取平台重建状态；正常进度完整保留，异常终态消息不可透出路径或密钥。 */
export function createAdminEmbeddingRebuildStatusReader(readRaw:()=>Promise<string|null>){
 return async():Promise<unknown>=>{
  const raw=await readRaw()
  if(!raw)return {status:'idle'}
  let value:unknown
  try{value=JSON.parse(raw)}catch{return {status:'idle'}}
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   const state=value as Record<string,unknown>
   if(state.status==='error'&&typeof state.message==='string')return {...state,message:redactToolError(state.message)}
  }
  return value
 }
}
