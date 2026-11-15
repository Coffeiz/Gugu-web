import {sql,type Kysely} from 'kysely'
import {CoreError} from '../contracts/index.js'
import {createFileSyncRunReader} from './read-runs.js'
import type {FileSyncRunInvalidation} from './cancel-run.js'

const emptyCounts={created:0,updated:0,moved:0,deleted:0,skipped:0,conflicts:0,failed:0,foldersDeferred:0,foldersCreated:0,foldersUpdated:0,foldersDeleted:0,plannedCreated:0,plannedUpdated:0,plannedDeleted:0,exported:0,permissionSkipped:0}
/** 只入队无删除许可的真实dry-run任务；同绑定串行去重，交给现有Worker生成计划。 */
function createFileSyncRun<DB>(db:Kysely<DB>,uuid:()=>string,publish:(event:FileSyncRunInvalidation)=>Promise<unknown>,action: 'dry_run' | 'initialize'){
 return async(bindingId:number)=>{
  const snapshot=await db.transaction().execute(async tx=>{
   const binding=(await sql<{id:number;user_id:string;source:string;status:string;mode:string;revision:number;gap_revision:number;root_fingerprint:string}>`SELECT id,user_id,source,status,mode,revision,gap_revision,root_fingerprint FROM file_sync_bindings WHERE id=${bindingId} FOR UPDATE`.execute(tx)).rows[0]
   if(!binding||binding.source!=='local_directory'||binding.status!=='active')throw new CoreError('not_found','同步绑定不存在')
   if(binding.mode==='mirror_out')throw new CoreError('conflict','任务类型与同步方向不匹配')
   const active=(await sql<{id:string;status:string;action:string;allow_delete:boolean}>`SELECT id,status,action,allow_delete FROM file_sync_reconcile_runs WHERE binding_id=${bindingId} AND status IN ('queued','running','cancelling') ORDER BY created_at DESC LIMIT 1`.execute(tx)).rows[0]
   let id:string
   if(active){
    if(active.status!=='queued'||active.action!==action||active.allow_delete)throw new CoreError('conflict','该同步绑定已有未完成任务')
    id=active.id
   }else{
    id=uuid()
    await sql`INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,allow_delete,status,stage,binding_revision,gap_revision,root_fingerprint,result_counts,revision,cancel_requested,scanned_count,created_at,updated_at) VALUES(${id},${binding.user_id},${bindingId},${action},false,'queued',NULL,${binding.revision},${binding.gap_revision},${binding.root_fingerprint},${JSON.stringify(emptyCounts)}::json,0,false,0,clock_timestamp(),clock_timestamp())`.execute(tx)
   }
   return createFileSyncRunReader(tx).get(id)
  })
  try{await publish({runId:snapshot.id,bindingId:snapshot.bindingId,revision:snapshot.revision})}catch{/* 与Python提交后刷新通知一致；失败时以任务快照补读为准。 */}
  return snapshot
 }
}

export function createFileSyncDryRun<DB>(db:Kysely<DB>,uuid:()=>string,publish:(event:FileSyncRunInvalidation)=>Promise<unknown>){return createFileSyncRun(db,uuid,publish,'dry_run')}
export function createFileSyncInitialize<DB>(db:Kysely<DB>,uuid:()=>string,publish:(event:FileSyncRunInvalidation)=>Promise<unknown>){return createFileSyncRun(db,uuid,publish,'initialize')}
