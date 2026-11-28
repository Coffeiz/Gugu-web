import {CoreError,dataContext} from '../contracts/index.js'
import {length} from '../shared/values.js'
import {createPortabilityJobReader,type PortabilityJobQuery} from './read-jobs.js'
import type {PortabilityJobTransaction} from './cancel-export.js'
export class InvalidImportConfirmation extends Error {constructor(){super('导入确认令牌无效或已过期')}}
/** 用户锁覆盖跨导出/导入互斥；确认能力只消费一次，重试使用同任务/模式/幂等键。 */
export function createDataImportApplier(transaction:PortabilityJobTransaction,query:PortabilityJobQuery,platform:{verify(token:string,expectedHash:string):boolean}) {
 const read=createPortabilityJobReader(query)
 return async(owner:string,job:string,mode:string,token:string,idempotencyKey:string)=>{
  if(!['incremental','replace'].includes(mode)||typeof token!=='string'||length(token)<32||length(token)>128||typeof idempotencyKey!=='string'||length(idempotencyKey)<8||length(idempotencyKey)>128)throw new CoreError('invalid_request','导入确认请求无效')
  const ownerId=dataContext(owner).ownerId,jobId=dataContext(job).ownerId
  await transaction(async tx=>{
   await tx('SELECT id FROM users WHERE id=$1 FOR UPDATE',[ownerId])
   const row=(await tx('SELECT mode,status,idempotency_key,preview,import_token_hash,expires_at<=clock_timestamp() AS expired FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])).rows[0]
   if(!row)throw new CoreError('not_found','找不到此导入任务')
   if(row.status==='queued'&&row.idempotency_key===idempotencyKey&&row.mode===mode)return
   if(row.status!=='preview_ready'||row.mode!=='preflight'||row.expired)throw new CoreError('conflict','导入预检尚未完成或任务已提交')
   if(typeof row.import_token_hash!=='string'||!row.import_token_hash||!platform.verify(token,row.import_token_hash))throw new InvalidImportConfirmation()
   if(mode==='replace'&&!row.preview?.complete)throw new CoreError('invalid_request','全量替换需要完整归档')
   const conflicts=Number(row.preview?.conflicts?.total??0)
   if(!Number.isSafeInteger(conflicts))throw new CoreError('storage_error','导入预检冲突计数无效')
   if(mode==='incremental'&&conflicts!==0)throw new CoreError('conflict','归档中存在唯一键冲突，请先处理预检列出的冲突')
   const active=await tx("SELECT id FROM data_export_jobs WHERE user_id=$1 AND status IN ('queued','running','canceling') UNION ALL SELECT id FROM data_import_jobs WHERE user_id=$1 AND id<>$2 AND status IN ('uploading','queued','running','applying','rolling_back','needs_recovery') LIMIT 1",[ownerId,jobId])
   if(active.rows.length)throw new CoreError('conflict','已有数据迁移任务正在处理')
   await tx("UPDATE data_import_jobs SET mode=$3,status='queued',stage='queued',idempotency_key=$4,import_token_hash=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",[ownerId,jobId,mode,idempotencyKey])
  })
  try{return await read.getImport(ownerId,jobId)}catch(error){if(error instanceof CoreError&&error.code==='not_found')throw new CoreError('storage_error','导入已确认，但任务状态刷新失败');throw error}
 }
}

/** 已完成替换的快照成为新的受控任务；不直接修改或删除用户数据。 */
export function createDataImportRollbackCreator(transaction:PortabilityJobTransaction,query:PortabilityJobQuery,platform:{uuid():string}) {
 const read=createPortabilityJobReader(query)
 return async(owner:string,source:string,idempotencyKey:string)=>{
  if(typeof idempotencyKey!=='string'||length(idempotencyKey)<8||length(idempotencyKey)>128)throw new CoreError('invalid_request','幂等键长度必须为8至128个字符')
  const ownerId=dataContext(owner).ownerId,sourceId=dataContext(source).ownerId
  const id=await transaction(async tx=>{
   await tx('SELECT id FROM users WHERE id=$1 FOR UPDATE',[ownerId])
   const row=(await tx('SELECT mode,status,rollback_key,rollback_expires_at>clock_timestamp() AS valid,archive_origin_id,archive_export_id FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,sourceId])).rows[0]
   if(!row)throw new CoreError('not_found','找不到此导入任务')
   const existing=(await tx('SELECT id::text,mode,source_job_id::text FROM data_import_jobs WHERE user_id=$1 AND idempotency_key=$2',[ownerId,idempotencyKey])).rows[0]
   if(existing){if(existing.mode!=='rollback'||existing.source_job_id!==sourceId)throw new CoreError('conflict','此幂等键已用于其他操作');return existing.id as string}
   if(row.mode!=='replace'||row.status!=='completed'||!row.rollback_key||!row.valid)throw new CoreError('conflict','替换快照不存在或已过期')
   const active=await tx("SELECT id FROM data_export_jobs WHERE user_id=$1 AND status IN ('queued','running','canceling') UNION ALL SELECT id FROM data_import_jobs WHERE user_id=$1 AND status IN ('uploading','queued','running','applying','rolling_back','needs_recovery') LIMIT 1",[ownerId])
   if(active.rows.length)throw new CoreError('conflict','已有数据迁移任务正在处理')
   const jobId=dataContext(platform.uuid()).ownerId
   await tx(`INSERT INTO data_import_jobs(id,user_id,mode,status,stage,source_job_id,idempotency_key,archive_origin_id,archive_export_id,preview,progress_current,created_at,expires_at,updated_at)
    SELECT $1,$2,'rollback','queued','queued',id,$4,archive_origin_id,archive_export_id,$5::json,0,clock_timestamp(),rollback_expires_at,clock_timestamp() FROM data_import_jobs WHERE id=$3 AND user_id=$2`,[jobId,ownerId,sourceId,idempotencyKey,JSON.stringify({complete:true,rollback_of:sourceId})])
   return jobId
  })
  try{return await read.getImport(ownerId,id)}catch(error){if(error instanceof CoreError&&error.code==='not_found')throw new CoreError('storage_error','回滚已排队，但任务状态刷新失败');throw error}
 }
}

/** 显式重试所属的替换恢复任务，保留归档与快照，原子释放旧租约。 */
export function createDataImportRecoverer(transaction:PortabilityJobTransaction,query:PortabilityJobQuery) {
 const read=createPortabilityJobReader(query)
 return async(owner:string,job:string)=>{
  const ownerId=dataContext(owner).ownerId,jobId=dataContext(job).ownerId
  await transaction(async tx=>{
   await tx('SELECT id FROM users WHERE id=$1 FOR UPDATE',[ownerId])
   const row=(await tx('SELECT mode,status,staging_key,rollback_key FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])).rows[0]
   if(!row)throw new CoreError('not_found','找不到此导入任务')
   if(!['replace','rollback'].includes(row.mode)||row.status!=='needs_recovery'||!row.staging_key||!row.rollback_key)throw new CoreError('conflict','此任务当前不需要恢复或恢复数据不完整')
   await tx("UPDATE data_import_jobs SET status='queued',stage='needs_recovery',lease_owner=NULL,lease_until=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",[ownerId,jobId])
  })
  try{return await read.getImport(ownerId,jobId)}catch(error){if(error instanceof CoreError&&error.code==='not_found')throw new CoreError('storage_error','恢复已排队，但任务状态刷新失败');throw error}
 }
}
