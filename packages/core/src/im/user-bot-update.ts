import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'
import {strip} from '../shared/values.js'
import {allowedUserBotTools,normalizeUserBotTools,userBotResponse} from './user-bots.js'
import {invalidateOwnerImSnapshots} from './user-bot-create.js'
export interface UserBotPatch {
 name?:string|null;app_id?:string|null;app_secret?:string|null
 sandbox?:boolean|null;enabled?:boolean|null;group_chat_enabled?:boolean|null;feishu_group_chat_enabled?:boolean|null
 group_requires_at?:boolean|null;group_read_enabled?:boolean|null;group_memory_enabled?:boolean|null;group_owner_memory_enabled?:boolean|null;member_memory_enabled?:boolean|null
 group_response_mode?:string|null;group_attention_mode?:string|null;group_allowed_tools?:string[]|null
 group_message_format?:string|null;private_message_format?:string|null;private_streaming_enabled?:boolean|null
}
export class UserBotUpdateError extends Error {override name='UserBotUpdateError'}
export interface UserBotUpdateOptions {encrypt(value:string):string|Promise<string>;decrypt(value:string):string;publishChanged(ownerId:string):Promise<unknown>}
function invalid(message:string):never {throw new UserBotUpdateError(message)}
/** owner行更新与所有设置校验同事务；只解密目标Bot，不受无关行密文损坏影响。 */
export function createUserBotUpdater<DB>(db:Kysely<DB>,options:UserBotUpdateOptions) {
 return async(ownerId:string,botId:number,input:UserBotPatch)=>{
  const owner=dataContext(ownerId).ownerId
  const row=await db.transaction().execute(async tx=>{
   const current=(await sql<Record<string,unknown>>`SELECT * FROM user_bots WHERE id=${botId} AND user_id=${owner} FOR UPDATE`.execute(tx)).rows[0]
   if(!current)throw new CoreError('not_found','机器人不存在')
   options.decrypt(String(current.app_secret??''))
   const patch:Record<string,unknown>={}
   if(input.group_chat_enabled!=null&&!['qq','telegram'].includes(String(current.platform)))invalid('该群聊开关仅适用于 QQ 或 Telegram 机器人')
   if(input.feishu_group_chat_enabled!=null&&current.platform!=='feishu')invalid('该群聊开关仅适用于飞书机器人')
   if(input.name!=null)patch.name=input.name
   if(input.app_id!=null)patch.app_id=strip(input.app_id)
   if(input.app_secret&&!input.app_secret.includes('•'))patch.app_secret=await options.encrypt(strip(input.app_secret))
   for(const key of ['group_chat_enabled','feishu_group_chat_enabled','sandbox','enabled','group_requires_at','group_read_enabled','group_memory_enabled','group_owner_memory_enabled','member_memory_enabled'] as const)if(input[key]!=null)patch[key]=input[key]
   if(input.group_response_mode!=null){
    if(!['reply_all','reply_mentions','record_only'].includes(input.group_response_mode))invalid('无效的群聊回应方式')
    patch.group_requires_at=input.group_response_mode!=='reply_all';patch.group_read_enabled=input.group_response_mode==='record_only'
   }
   if(input.group_attention_mode!=null){
    if(!['quiet','natural','active','autonomous'].includes(input.group_attention_mode))invalid('无效的群聊参与度')
    if(input.group_attention_mode!==current.group_attention_mode){patch.group_attention_mode=input.group_attention_mode;patch.group_attention_config_version=Number(current.group_attention_config_version)+1}
   }
   if((patch.group_requires_at??current.group_requires_at)===false&&input.group_response_mode==null)patch.group_read_enabled=false
   if(input.group_allowed_tools!=null){if(input.group_allowed_tools.some(tool=>!allowedUserBotTools.includes(tool)))invalid('包含不支持的群成员工具');patch.group_allowed_tools=normalizeUserBotTools(input.group_allowed_tools)}
   if(input.private_streaming_enabled===true&&(input.private_message_format||current.private_message_format)!=='markdown')invalid('QQ 私聊流式仅支持 Markdown 格式')
   for(const key of ['group_message_format','private_message_format'] as const)if(input[key]!=null){if(!['compat','markdown'].includes(input[key]))invalid('无效的 QQ 消息格式');patch[key]=input[key]}
   if(input.private_streaming_enabled!=null){if(current.platform!=='qq')invalid('私聊流式设置仅适用于 QQ 机器人');patch.private_streaming_enabled=input.private_streaming_enabled}
   if(input.private_message_format==='compat')patch.private_streaming_enabled=false
   const changed=Object.entries(patch).filter(([key,value])=>key==='group_allowed_tools'?JSON.stringify(value)!==JSON.stringify(current[key]):value!==current[key])
   if(!changed.length)return current
   const assignments=changed.map(([key,value])=>key==='group_allowed_tools'?sql`${sql.ref(key)}=${JSON.stringify(value)}::json`:sql`${sql.ref(key)}=${value}`)
   return (await sql<Record<string,unknown>>`UPDATE user_bots SET ${sql.join(assignments)} WHERE id=${botId} AND user_id=${owner} RETURNING *`.execute(tx)).rows[0]!
  })
  const response=userBotResponse(row,options.decrypt)
  try{await invalidateOwnerImSnapshots(db,owner)}catch{/* 提交后尽力失效，失败仍通知客户端。 */}
  try{await options.publishChanged(owner)}catch{/* 已提交设置不因live失败回滚。 */}
  return response
 }
}
