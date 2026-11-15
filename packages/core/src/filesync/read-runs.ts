import {sql,type Kysely,type RawBuilder} from 'kysely'
import {CoreError} from '../contracts/index.js'
import {utc} from '../shared/timestamps.js'

interface RunRow {
 id:string;binding_id:number;action:string;allow_delete:boolean;status:string;stage:string|null;scanned_count:number
 result_counts:Record<string,unknown>|null;error_code:string|null;revision:number;cancel_requested:boolean
 created_at:string|null;started_at:string|null;finished_at:string|null
}
export interface FileSyncRunQuery {userId?:string;bindingId?:number;limit?:number}
const columns=sql`id,binding_id,action,allow_delete,status,stage,scanned_count,result_counts,error_code,revision,cancel_requested,CAST(created_at AS text) AS created_at,CAST(started_at AS text) AS started_at,CAST(finished_at AS text) AS finished_at`
function response(row:RunRow){
 const timestamp=(value:string|null)=>value===null?null:utc(value).replace(' ','T')
 return {id:row.id,bindingId:row.binding_id,action:row.action,allowDelete:row.allow_delete,status:row.status,stage:row.stage,scannedCount:row.scanned_count,resultCounts:row.result_counts??{},errorCode:row.error_code,revision:row.revision,cancelRequested:row.cancel_requested,createdAt:timestamp(row.created_at),startedAt:timestamp(row.started_at),finishedAt:timestamp(row.finished_at)}
}

/** 管理员跨用户只读任务快照；不读取路径、租约拥有者或原始异常，不触发文件扫描。 */
export function createFileSyncRunReader<DB>(db:Kysely<DB>){
 return {
  async list(query:FileSyncRunQuery={}){
   const predicates:RawBuilder<unknown>[]=[]
   if(query.userId!==undefined)predicates.push(sql`user_id=${query.userId}`)
   if(query.bindingId!==undefined)predicates.push(sql`binding_id=${query.bindingId}`)
   const where=predicates.length?sql`WHERE ${sql.join(predicates,sql` AND `)}`:sql``
   const rows=(await sql<RunRow>`SELECT ${columns} FROM file_sync_reconcile_runs ${where} ORDER BY created_at DESC LIMIT ${Math.max(1,Math.min(100,query.limit??50))}`.execute(db)).rows
   return rows.map(response)
  },
  async get(runId:string){
   const row=(await sql<RunRow>`SELECT ${columns} FROM file_sync_reconcile_runs WHERE id=${runId}`.execute(db)).rows[0]
   if(!row)throw new CoreError('not_found','对账任务不存在')
   return response(row)
  },
 }
}
