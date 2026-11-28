import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'
import {invalidateOwnerImSnapshots} from './user-bot-create.js'
export interface UserBotDeleteOptions {
 clearReach(ownerId:string,platform:string):Promise<unknown>
 publishChanged(ownerId:string):Promise<unknown>
}
/** 删除先提交；可达地址、IM快照和实时通知分别best-effort，失败不复活已删Bot。 */
export function createUserBotDeleter<DB>(db:Kysely<DB>,options:UserBotDeleteOptions) {
 return async(ownerId:string,botId:number):Promise<void>=>{
  const owner=dataContext(ownerId).ownerId
  const platform=await db.transaction().execute(async tx=>{
   const row=(await sql<{platform:string}>`DELETE FROM user_bots WHERE id=${botId} AND user_id=${owner} RETURNING platform`.execute(tx)).rows[0]
   if(!row)throw new CoreError('not_found','机器人不存在')
   return row.platform
  })
  try{await options.clearReach(owner,platform)}catch{/* Python clear_imreach的清理失败不影响删除。 */}
  try{await invalidateOwnerImSnapshots(db,owner)}catch{/* 与Python渠道失效的尽力语义一致。 */}
  try{await options.publishChanged(owner)}catch{/* 已提交删除不会因live故障回滚。 */}
 }
}
