import {sql,type Kysely,type Transaction} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'

export interface TaskFilesystemRevokeEffects{
 revokeConfirmation(ownerId:string,summary:string,identity:string):Promise<unknown>
 fingerprint(subjectId:string):string
 recordMetric?():Promise<unknown>
}
type TaskGrantRow = { name: string; filesystem_authorization_grant_id: number | null }

/** 为已由调用方锁定并校验归属的任务撤权，沿用同一数据库事务。 */
export async function revokeLockedTaskFilesystemAccess<DB>(
  tx: Transaction<DB>, owner: string, taskId: number, row: TaskGrantRow, effects: TaskFilesystemRevokeEffects,
) {
   try{await effects.revokeConfirmation(owner,`允许定时任务「${row.name}」读写整个用户沙箱（包含 /workspace、/personal、/project）`,`scheduled-task:filesystem:${taskId}`)}catch{/* 确认存储故障不能阻止持久授权撤销。 */}
   const grantId=row.filesystem_authorization_grant_id
   if(grantId===null)return {status:'revoked',task_id:taskId,revoked:false}
   await sql`UPDATE scheduled_tasks SET filesystem_authorization_grant_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=${taskId} AND user_id=${owner}`.execute(tx)
   const grant=(await sql<{id:number}>`UPDATE filesystem_authorization_grants SET revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=${grantId} AND user_id=${owner} AND revoked_at IS NULL RETURNING id`.execute(tx)).rows[0]
   if(!grant)return {status:'revoked',task_id:taskId,revoked:false}
   const metadata=JSON.stringify({subject_type:'scheduled_task',subject_id:String(taskId),grant_id:String(grantId),scope:'user_sandbox',operation:'authorization',outcome:'revoked',source:'system'})
   await sql`INSERT INTO security_events(user_id,event_type,resource_type,resource_fingerprint,owner_fingerprint,client_fingerprint,ip_fingerprint,user_agent_fingerprint,action,reason_code,metadata_json,occurred_at,expires_at) VALUES(${owner},'filesystem.authorization','filesystem:scheduled_task',${effects.fingerprint(String(taskId))},NULL,NULL,NULL,NULL,'logged','revoked',${metadata}::json,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '90 days')`.execute(tx)
   try{await effects.recordMetric?.()}catch{/* 指标best-effort，不覆盖事务结果。 */}
   return {status:'revoked',task_id:taskId,revoked:true}
}

/** 通过调用方的事务锁定独立任务，供 REST 与 Agent 共用撤权规则。 */
export async function revokeTaskFilesystemAccessInTransaction<DB>(
  tx: Transaction<DB>, owner: string, taskId: number, effects: TaskFilesystemRevokeEffects,
) {
  const { rows: [row] } = await sql<TaskGrantRow>`SELECT name,filesystem_authorization_grant_id
    FROM scheduled_tasks WHERE id=${taskId} AND user_id=${owner} AND event_id IS NULL FOR UPDATE`.execute(tx)
  if (!row) throw new CoreError('not_found', '定时任务不存在')
  return revokeLockedTaskFilesystemAccess(tx, owner, taskId, row, effects)
}

/** 撤销任务权限和审计共用事务。确认码撤销沿用 Python 的尽力语义。 */
export function createTaskFilesystemRevoker<DB>(db: Kysely<DB>, effects: TaskFilesystemRevokeEffects) {
  return async (ownerId: string, taskId: number) => {
    const owner = dataContext(ownerId).ownerId
    return db.transaction().execute(tx => revokeTaskFilesystemAccessInTransaction(tx, owner, taskId, effects))
  }
}
