import {sql,type Kysely,type Transaction} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'

export interface TaskConfirmationStore{
 revoke(ownerId:string,summary:string,identity:string):Promise<boolean>
 createPending(ownerId:string,summary:string,identity:string,ttlMinutes:number):Promise<string|null>
 redeem(ownerId:string,code:string):Promise<boolean>
 hasGrant(ownerId:string,summary:string,identity:string):Promise<boolean>
}
export interface TaskAuthorizationEffects{
 confirmations:TaskConfirmationStore
 enabled():boolean
 fingerprint(subjectId:string):string
 recordMetric?(outcome:'requested'|'granted'):Promise<unknown>
}
type Task={id:number;name:string;enabled:boolean;event_id:number|null;filesystem_authorization_grant_id:number|null}
function failure(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode})}
const instruction='确认后，该定时任务每次运行都可读写用户沙箱；不包含宿主机目录。'

/** 任务授权不执行任务；持久授权与安全审计同事务，Redis确认按用户/摘要/任务身份绑定。 */
export function createTaskFilesystemAuthorization<DB>(db:Kysely<DB>,effects:TaskAuthorizationEffects){
 const summary=(task:Task)=>`允许定时任务「${task.name}」读写整个用户沙箱（包含 /workspace、/personal、/project）`
 const identity=(id:number)=>`scheduled-task:filesystem:${id}`
 const ensureEnabled=()=>{if(!effects.enabled())throw failure(409,'完整用户沙箱授权功能当前未开启')}
 async function task(tx:Transaction<DB>,owner:string,id:number){
  const row=(await sql<Task>`SELECT id,name,enabled,event_id,filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=${id} AND user_id=${owner} FOR UPDATE`.execute(tx)).rows[0]
  if(!row)throw new CoreError('not_found','任务不存在')
  ensureEnabled()
  if(!row.enabled)throw failure(400,'停用任务不能授予完整用户沙箱权限')
  return row
 }
 async function audit(tx:Transaction<DB>,owner:string,id:number,outcome:'requested'|'granted',grantId?:number){
  const metadata=JSON.stringify({subject_type:'scheduled_task',subject_id:String(id),...(grantId===undefined?{}:{grant_id:String(grantId)}),scope:'user_sandbox',operation:'authorization',outcome,source:'user'})
  await sql`INSERT INTO security_events(user_id,event_type,resource_type,resource_fingerprint,owner_fingerprint,client_fingerprint,ip_fingerprint,user_agent_fingerprint,action,reason_code,metadata_json,occurred_at,expires_at) VALUES(${owner},'filesystem.authorization','filesystem:scheduled_task',${effects.fingerprint(String(id))},NULL,NULL,NULL,NULL,'logged',${outcome},${metadata}::json,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '90 days')`.execute(tx)
  try{await effects.recordMetric?.(outcome)}catch{/* 运维指标不覆盖授权事务结果。 */}
 }
 async function currentGrant(tx:Transaction<DB>,owner:string,id:number|null){
  if(id===null)return undefined
  return(await sql<{id:number}>`SELECT id FROM filesystem_authorization_grants WHERE id=${id} AND user_id=${owner} AND revoked_at IS NULL`.execute(tx)).rows[0]
 }
 return{
  async request(ownerId:string,id:number){
   const owner=dataContext(ownerId).ownerId
   return db.transaction().execute(async tx=>{
    const row=await task(tx,owner,id)
    if(await currentGrant(tx,owner,row.filesystem_authorization_grant_id))return {status:'authorized',task_id:id}
    await effects.confirmations.revoke(owner,summary(row),identity(id))
    if(await effects.confirmations.hasGrant(owner,summary(row),identity(id)))return {status:'authorized',task_id:id}
    const code=await effects.confirmations.createPending(owner,summary(row),identity(id),10)
    ensureEnabled()
    await audit(tx,owner,id,'requested')
    return{status:code?'waiting_confirmation':'confirmation_unavailable',needs_confirm:true,summary:summary(row),instruction,authorization_ttl_minutes:10,...(code?{confirm_code:code}:{error:'确认服务暂不可用，请稍后重试。'})}
   })
  },
  async confirm(ownerId:string,id:number,code:string){
   const owner=dataContext(ownerId).ownerId
   return db.transaction().execute(async tx=>{
    const row=await task(tx,owner,id)
    if(!await effects.confirmations.redeem(owner,code))throw failure(400,'授权确认已失效，请重新确认')
    if(!await effects.confirmations.hasGrant(owner,summary(row),identity(id))){
     await effects.confirmations.createPending(owner,summary(row),identity(id),10)
     throw failure(400,'授权确认不匹配，请重新确认')
    }
    ensureEnabled()
    if(row.event_id!==null)throw failure(409,'定时任务不存在')
    const pointed=await currentGrant(tx,owner,row.filesystem_authorization_grant_id)
    if(pointed)return{status:'authorized',task_id:id,grant_id:pointed.id}
    const active=(await sql<{id:number}>`SELECT id FROM filesystem_authorization_grants WHERE user_id=${owner} AND subject_type='scheduled_task' AND subject_id=${String(id)} AND scope='user_sandbox' AND permission='read_write' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP) ORDER BY id DESC LIMIT 1 FOR UPDATE`.execute(tx)).rows[0]
    let grantId=active?.id
    if(grantId===undefined){
     grantId=(await sql<{id:number}>`INSERT INTO filesystem_authorization_grants(user_id,subject_type,subject_id,scope,permission,granted_by,granted_at,expires_at,revoked_at,created_at,updated_at) VALUES(${owner},'scheduled_task',${String(id)},'user_sandbox','read_write','user',CURRENT_TIMESTAMP,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`.execute(tx)).rows[0]!.id
    }
    await sql`UPDATE scheduled_tasks SET filesystem_authorization_grant_id=${grantId},updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND user_id=${owner}`.execute(tx)
    if(!active)await audit(tx,owner,id,'granted',grantId)
    return{status:'authorized',task_id:id,grant_id:grantId}
   })
  },
 }
}
