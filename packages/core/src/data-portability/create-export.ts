import {CoreError,dataContext} from '../contracts/index.js'
import {length} from '../shared/values.js'
import {createPortabilityJobReader,type PortabilityJobQuery} from './read-jobs.js'
import type {PortabilityJobTransaction} from './cancel-export.js'
const categories=new Set(['account','preferences','projects','clients','files','calendar','mind','skills','feedback','workspaces','scheduled_tasks','conversations','drafts','connections','owner_memory','im_memory'])

/** 与现有Python消费者共享持久任务：用户行锁覆盖幂等检查和跨类型互斥。 */
export function createDataExportCreator(transaction:PortabilityJobTransaction,query:PortabilityJobQuery,platform:{now():Date;uuid():string}){
 const read=createPortabilityJobReader(query)
 return async(owner:string,selected:readonly string[],idempotencyKey:string)=>{
  const ownerId=dataContext(owner).ownerId,selectedSet=new Set(selected)
  if(!selectedSet.size||[...selectedSet].some(value=>!categories.has(value)))throw new CoreError('invalid_request','导出类别无效')
  if(typeof idempotencyKey!=='string'||length(idempotencyKey)<8||length(idempotencyKey)>128)throw new CoreError('invalid_request','幂等键长度必须为8至128个字符')
  const id=await transaction(async tx=>{
   await tx('SELECT id FROM users WHERE id=$1 FOR UPDATE',[ownerId])
   const existing=(await tx('SELECT id::text,options FROM data_export_jobs WHERE user_id=$1 AND idempotency_key=$2',[ownerId,idempotencyKey])).rows[0]
   if(existing){
    const previous=new Set<string>(existing.options?.categories??[])
    if(previous.size!==selectedSet.size||[...selectedSet].some(value=>!previous.has(value)))throw new CoreError('conflict','此幂等键已用于不同的导出范围')
    return existing.id as string
   }
   const active=await tx("SELECT id FROM data_export_jobs WHERE user_id=$1 AND status IN ('queued','running','canceling') UNION ALL SELECT id FROM data_import_jobs WHERE user_id=$1 AND status IN ('uploading','queued','running','applying','rolling_back','needs_recovery') LIMIT 1",[ownerId])
   if(active.rows.length)throw new CoreError('conflict','已有数据迁移任务正在处理')
   const jobId=dataContext(platform.uuid()).ownerId,now=platform.now(),expires=new Date(now.getTime()+24*3600000)
   await tx(`INSERT INTO data_export_jobs(id,user_id,status,stage,options,idempotency_key,progress_current,created_at,expires_at,updated_at)
    VALUES($1,$2,'queued','queued',$3::json,$4,0,$5,$6,$5)`,[jobId,ownerId,JSON.stringify({categories:[...selectedSet].sort()}),idempotencyKey,now.toISOString(),expires.toISOString()])
   return jobId
  })
  try{return await read.getExport(ownerId,id)}catch(error){if(error instanceof CoreError&&error.code==='not_found')throw new CoreError('storage_error','导出已创建，但任务状态刷新失败');throw error}
 }
}
