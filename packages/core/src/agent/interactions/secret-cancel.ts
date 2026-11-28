import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../../contracts/index.js'

function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function truthy(value:unknown):boolean{
 if(value==null||value===false||value===0||value==='')return false
 if(Array.isArray(value))return value.length>0
 if(record(value))return Object.keys(value).length>0
 return true
}
/** 仅取消已有owner凭据交互；不解密临时密文，不创建新恢复任务。 */
export function createSecretPromptCancellation<DB>(db:Kysely<DB>){
 return async(ownerId:string,promptId:number)=>{
  const owner=dataContext(ownerId).ownerId
  return db.transaction().execute(async tx=>{
   const prompt=(await sql<{kind:string;status:string;schema_json:unknown}>`SELECT kind,status,schema_json FROM interaction_prompts WHERE id=${promptId} AND user_id=${owner} FOR UPDATE`.execute(tx)).rows[0]
   if(!prompt)throw new CoreError('not_found','凭据输入不存在')
   const schema=record(prompt.schema_json)?prompt.schema_json:{},context=record(schema.context)?schema.context:{},target=context.secret_target
   if(!truthy(schema.secret_fields)||!record(target)||target.kind!=='mcp_credentials')throw Object.assign(new Error('当前交互不支持凭据取消'),{statusCode:400})
   // 锁等待可能跨过expires_at；取锁后按实时数据库时钟复核，不能用事务开始时间。
   const expired=(await sql<{expired:boolean}>`SELECT expires_at<=clock_timestamp() AS expired FROM interaction_prompts WHERE id=${promptId} AND user_id=${owner}`.execute(tx)).rows[0]!.expired
   if(prompt.status!=='active'||expired)throw new CoreError('conflict','凭据输入已结束')
   const stage=(await sql<{id:number;status:string}>`SELECT id,status FROM mcp_secret_inputs WHERE prompt_id=${promptId} AND user_id=${owner} FOR UPDATE`.execute(tx)).rows[0]
   if(stage&&['pending_choice','awaiting_secret'].includes(stage.status))await sql`UPDATE mcp_secret_inputs SET status='cancelled',encrypted_payload='',payload_nonce='',encrypted_data_key='',updated_at=clock_timestamp() WHERE id=${stage.id} AND user_id=${owner}`.execute(tx)
   const resolved={...schema,resolved_result:{kind:prompt.kind,status:'cancelled',prompt_id:promptId,option_id:'cancel',value:null,text:'已取消凭据输入'}}
   await sql`UPDATE interaction_prompts SET status='resolved',resolved_at=clock_timestamp(),schema_json=${JSON.stringify(resolved)}::json WHERE id=${promptId} AND user_id=${owner}`.execute(tx)
   return {ok:true,prompt_id:promptId,status:'cancelled'}
  })
 }
}
