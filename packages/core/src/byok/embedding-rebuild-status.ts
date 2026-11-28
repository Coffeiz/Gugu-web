import {dataContext} from '../contracts/index.js'
import {redactToolError} from '../agent/core.js'

/** 只读旧Worker状态；Redis故障向上抛出，不把基础设施故障伪装成idle。 */
export function createEmbeddingRebuildStatusReader(readRawForOwner:(ownerId:string)=>Promise<string|null>){
 return async(ownerId:string):Promise<unknown>=>{
  const raw=await readRawForOwner(dataContext(ownerId).ownerId)
  if(!raw)return {status:'idle'}
  let value:unknown
  try{value=JSON.parse(raw)}catch{return {status:'idle'}}
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   const status=value as Record<string,unknown>
   // Worker错误终态可能保存原始异常；正常进度和完成文案不能按错误串删改。
   if(status.status==='error'&&typeof status.message==='string')return {...status,message:redactToolError(status.message)}
  }
  return value
 }
}
