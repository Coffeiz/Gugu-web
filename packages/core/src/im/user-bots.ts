import {dataContext} from '../contracts/index.js'
export const allowedUserBotTools:readonly string[]=Object.freeze(['web_search','http_get','similar_image_search','read_file','send_file','group_context_search'])
export function normalizeUserBotTools(configured:unknown):string[] {
 if(!Array.isArray(configured))return [...allowedUserBotTools]
 const allowed=[...new Set(configured.filter((name):name is string=>typeof name==='string' && allowedUserBotTools.includes(name)))]
 for(const [parent,child] of [['web_search','http_get'],['similar_image_search','read_file']] as const)if(allowed.includes(parent)&&!allowed.includes(child))allowed.splice(allowed.indexOf(parent)+1,0,child)
 return allowed
}
function mask(value:string):string {const chars=Array.from(value);return chars.length?chars.length>6?chars.slice(0,3).join('')+'••••••'+chars.slice(-2).join(''):'••••••':''}
/** 列表与单Bot变更共同使用；只解密正在返回的这一行。 */
export function userBotResponse(row:Record<string,unknown>,decrypt:(value:string)=>string) {
 return {
   id:row.id,platform:row.platform,name:row.name,app_id:row.app_id,app_secret:mask(decrypt(String(row.app_secret??''))),sandbox:row.sandbox,enabled:row.enabled,
   group_chat_enabled:row.group_chat_enabled,feishu_group_chat_enabled:row.feishu_group_chat_enabled,group_requires_at:row.group_requires_at,group_read_enabled:row.group_read_enabled,group_memory_enabled:row.group_memory_enabled,group_owner_memory_enabled:row.group_owner_memory_enabled,member_memory_enabled:row.member_memory_enabled,
   group_response_mode:row.group_read_enabled&&row.group_requires_at?'record_only':row.group_requires_at?'reply_mentions':'reply_all',
   group_attention_mode:['quiet','natural','active','autonomous'].includes(String(row.group_attention_mode))?row.group_attention_mode:'autonomous',group_allowed_tools:normalizeUserBotTools(row.group_allowed_tools),
   group_message_format:['compat','markdown'].includes(String(row.group_message_format))?row.group_message_format:'compat',private_message_format:['compat','markdown'].includes(String(row.private_message_format))?row.private_message_format:'markdown',private_streaming_enabled:Boolean(row.private_streaming_enabled),owner_bound:Boolean(row.owner_platform_user_id),
 }
}
export type UserBotsQuery=(sql:string,params:unknown[])=>Promise<{rows:Record<string,unknown>[]}>
/** 跨用户隔离在读取SQL落实；凭据在投影前解密但始终仅输出掩码。 */
export function createUserBotsReader(query:UserBotsQuery,decrypt:(value:string)=>string,supportedPlatforms:()=>readonly string[]|Promise<readonly string[]>) {
 return async(ownerId:string)=>{
  const owner=dataContext(ownerId).ownerId
  const rows=(await query('SELECT id,platform,name,app_id,app_secret,sandbox,enabled,group_chat_enabled,feishu_group_chat_enabled,group_requires_at,group_read_enabled,group_memory_enabled,group_owner_memory_enabled,member_memory_enabled,group_attention_mode,group_allowed_tools,group_message_format,private_message_format,private_streaming_enabled,owner_platform_user_id FROM user_bots WHERE user_id=$1 ORDER BY id',[owner])).rows
  return {supported_platforms:[...await supportedPlatforms()],items:rows.map(row=>userBotResponse(row,decrypt))}
 }
}

/** 单条更新原子提交后发布失效事件；已解绑记录重复操作仍成功。 */
export function createUserBotUnbinder(query:UserBotsQuery,publishChanged:(ownerId:string)=>Promise<unknown>) {
 return async(ownerId:string,botId:number):Promise<void>=>{
  const owner=dataContext(ownerId).ownerId
  const result=await query("UPDATE user_bots SET owner_platform_user_id=NULL,owner_bound_at=NULL WHERE id=$1 AND user_id=$2 AND platform='qq' RETURNING id",[botId,owner])
  if(!result.rows.length)throw Object.assign(new Error('机器人不存在'),{statusCode:404})
  try{await publishChanged(owner)}catch{ /* Python事件发布best-effort；不回滚已经提交的解绑。 */ }
 }
}
