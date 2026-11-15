import {CoreError,dataContext} from '../contracts/index.js'
import {createPortabilityJobReader,type PortabilityJobQuery} from './read-jobs.js'
import type {PortabilityJobTransaction} from './cancel-export.js'

function truthy(value:unknown):boolean{
 if(value==null||value===false||value===0||value==='')return false
 if(Array.isArray(value))return value.length>0
 if(typeof value==='object')return Object.keys(value).length>0
 return true
}
/** 仅轮换预检确认能力；不读取、解密或修改已上传的归档对象。 */
export function createDataImportResumer(transaction:PortabilityJobTransaction,query:PortabilityJobQuery,platform:{token():string;hash(token:string):string}){
 const read=createPortabilityJobReader(query)
 return async(owner:string,job:string)=>{
  const ownerId=dataContext(owner).ownerId,jobId=dataContext(job).ownerId
  const token=await transaction(async tx=>{
   const row=(await tx('SELECT mode,status,staging_key,preview FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])).rows[0]
   if(!row)throw new CoreError('not_found','找不到此导入任务')
   const validExpiry=(await tx('SELECT expires_at IS NOT NULL AND expires_at>clock_timestamp() AS valid FROM data_import_jobs WHERE user_id=$1 AND id=$2',[ownerId,jobId])).rows[0]?.valid
   if(row.mode!=='preflight'||row.status!=='preview_ready'||!truthy(row.staging_key)||!truthy(row.preview)||!validExpiry)throw new CoreError('conflict','此预检任务已过期或不能继续')
   const next=platform.token()
   await tx('UPDATE data_import_jobs SET import_token_hash=$3,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[ownerId,jobId,platform.hash(next)])
   return next
  })
  try{return {...await read.getImport(ownerId,jobId),import_token:token}}catch(error){
   if(error instanceof CoreError&&error.code==='not_found')throw new CoreError('storage_error','确认能力已更新，但任务状态刷新失败')
   throw error
  }
 }
}
