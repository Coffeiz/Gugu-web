import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'

/** 仅删除终端持久视图与事件；不授予Shell权限，也不代替PTY终止生命周期。 */
export function createTerminalDeletion<DB>(db:Kysely<DB>,publishChanged:(ownerId:string,terminalId:string,origin:string|null)=>Promise<unknown>){
 return async(ownerId:string,terminalId:string,origin:string|null)=>{
  const owner=dataContext(ownerId).ownerId
  await db.transaction().execute(async tx=>{
   const terminal=(await sql<{session_id:number|null}>`SELECT session_id FROM terminal_sessions WHERE id=${terminalId} AND owner_id=${owner} FOR UPDATE`.execute(tx)).rows[0]
   if(!terminal)throw new CoreError('not_found','终端不存在')
   if(terminal.session_id!==null){
    const session=(await sql`SELECT id FROM conversation_sessions WHERE id=${terminal.session_id} AND user_id=${owner}`.execute(tx)).rows[0]
    if(!session)throw Object.assign(new Error('终端会话不存在'),{statusCode:403})
   }
   await sql`DELETE FROM terminal_events WHERE terminal_id=${terminalId}`.execute(tx)
   await sql`DELETE FROM terminal_sessions WHERE id=${terminalId} AND owner_id=${owner}`.execute(tx)
  })
  try{await publishChanged(owner,terminalId,origin)}catch{/* 与Python事件总线一致，通知故障不回滚已提交删除。 */}
  return {deleted:true,terminalId}
 }
}
