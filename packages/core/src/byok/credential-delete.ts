import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'

/** 删除不需要解密凭据；LLM配置变更与推理状态失效必须处于同一事务。 */
export function createCredentialDeletion<DB>(db:Kysely<DB>,enabled:()=>boolean){
 return async(ownerId:string,credentialId:number):Promise<void>=>{
  if(!enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  const owner=dataContext(ownerId).ownerId
  await db.transaction().execute(async tx=>{
   const result=await sql<{capability:string}>`DELETE FROM user_provider_credentials WHERE user_id=${owner} AND id=${credentialId} RETURNING capability`.execute(tx)
   const row=result.rows[0]
   if(!row)throw new CoreError('not_found','凭据不存在')
   if(row.capability==='llm')await sql`UPDATE provider_reasoning_states SET status='invalidated',invalidated_reason='config_changed',invalidated_at=CURRENT_TIMESTAMP,encrypted_payload='',payload_nonce='',encrypted_data_key='',payload_size=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${owner} AND status='active'`.execute(tx)
  })
 }
}
