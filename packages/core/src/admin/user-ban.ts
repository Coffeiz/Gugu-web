import {sql,type Kysely} from 'kysely'
import {CoreError} from '../contracts/index.js'

export interface AdminBanAudit {operator:string;ip:string|null}
/** 兼容管理员封禁开关；账户提交与后续审计保持Python两次提交语义。 */
export function createAdminUserBanToggle<DB>(db:Kysely<DB>,publishAuthStateChanged:(userId:string)=>Promise<unknown>){
 return async(userId:string,audit:AdminBanAudit)=>{
  const changed=await db.transaction().execute(async tx=>{
   const user=(await sql<{id:string;username:string;is_active:boolean}>`SELECT id,username,is_active FROM users WHERE id=${userId} FOR UPDATE`.execute(tx)).rows[0]
   if(!user)throw new CoreError('not_found','用户不存在')
   const active=!user.is_active
   if(active)await sql`UPDATE users SET account_status='active',is_active=true,suspended_until=NULL,suspended_reason=NULL,security_version=COALESCE(security_version,0)+1 WHERE id=${user.id}`.execute(tx)
   else await sql`UPDATE users SET account_status='suspended',is_active=false,suspended_until=clock_timestamp()+interval '2592000 seconds',suspended_reason='admin_ban_compat',security_version=COALESCE(security_version,0)+1 WHERE id=${user.id}`.execute(tx)
   return {id:user.id,username:user.username,active}
  })
  try{await publishAuthStateChanged(changed.id)}catch{/* 与Python一致：撤销通知失败不回滚已生效账户状态。 */}
  const description=`${changed.active?'解封':'封禁'}用户 ${changed.username}`
  // 审计失败向上抛出；不能据此恢复已封禁账户或旧安全版本。
  await sql`INSERT INTO audit_logs(username,action,description,ip,created_at) VALUES(${audit.operator},'user',${description},${audit.ip},clock_timestamp())`.execute(db)
  return {id:userId,is_active:changed.active}
 }
}
