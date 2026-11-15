import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'

export interface TaskFilesystemRevokeEffects{
 revokeConfirmation(ownerId:string,summary:string,identity:string):Promise<unknown>
 fingerprint(subjectId:string):string
 recordMetric?():Promise<unknown>
}
/** 撤销任务权限与安全审计同事务；确认码撤销保持Python的best-effort且先于提交。 */
export function createTaskFilesystemRevoker<DB>(db:Kysely<DB>,effects:TaskFilesystemRevokeEffects){
 return async(ownerId:string,taskId:number)=>{
  const owner=dataContext(ownerId).ownerId
  return db.transaction().execute(async tx=>{
   const row=(await sql<{name:string;filesystem_authorization_grant_id:number|null}>`SELECT name,filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=${taskId} AND user_id=${owner} AND event_id IS NULL FOR UPDATE`.execute(tx)).rows[0]
   if(!row)throw new CoreError('not_found','定时任务不存在')
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
  })
 }
}
