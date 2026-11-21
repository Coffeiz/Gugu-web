import {sql,CompiledQuery,type Kysely,type Transaction} from 'kysely'
import {dataContext} from '../contracts/index.js'
import {strip} from '../shared/values.js'
import {createUserBotsReader,defaultUserBotGroupSettings,defaultUserBotPrivateStreamingEnabled} from './user-bots.js'

export interface QqBotInput {name?:string;app_id?:string;app_secret?:string;sandbox?:boolean;enabled?:boolean}
export class QqBotCreationError extends Error {
 override name='QqBotCreationError'
 constructor(readonly code:'platform_disabled'|'invalid_credentials'|'already_exists',message:string){super(message)}
}
export interface QqBotCreationOptions {
 encrypt(value:string):string|Promise<string>
 decrypt(value:string):string
 platforms():readonly string[]|Promise<readonly string[]>
 publishChanged(ownerId:string):Promise<unknown>
}
/** IM创建入口共用正式表的完整默认值；调用方持有owner锁并控制事务。 */
export async function insertUserBot<DB>(tx:Kysely<DB>|Transaction<DB>,owner:string,input:QqBotInput&{platform?:'qq'|'feishu'|'wechat'},encrypted:string):Promise<number>{
 const platform=input.platform??'qq'
   const group=defaultUserBotGroupSettings(platform)
   const row=(await sql<{id:number}>`INSERT INTO user_bots(user_id,platform,name,app_id,app_secret,sandbox,enabled,group_chat_enabled,feishu_group_chat_enabled,group_requires_at,group_read_enabled,group_attention_mode,group_attention_config_version,group_memory_enabled,member_memory_enabled,group_owner_memory_enabled,group_allowed_tools,group_message_format,private_message_format,private_streaming_enabled,owner_platform_user_id,owner_bound_at,bot_platform_user_id,created_at)
    VALUES(${owner},${platform},${input.name||(platform==='feishu'?'我的飞书机器人':'我的 QQ 机器人')},${input.app_id!},${encrypted},${input.sandbox??false},${input.enabled??true},${group.groupChatEnabled},${platform==='feishu'?group.groupChatEnabled:null},true,false,${group.groupAttentionMode},0,${group.groupMemoryEnabled},${group.memberMemoryEnabled},${group.groupOwnerMemoryEnabled},${JSON.stringify(group.groupAllowedTools)}::json,'compat','markdown',${defaultUserBotPrivateStreamingEnabled(platform)},NULL,NULL,NULL,clock_timestamp()) RETURNING id`.execute(tx)).rows[0]!
   return row.id
}
export function insertQqBot<DB>(tx:Kysely<DB>|Transaction<DB>,owner:string,input:QqBotInput,encrypted:string):Promise<number>{
 return insertUserBot(tx,owner,{...input,app_id:strip(input.app_id!)},encrypted)
}
/** 与 Python IM 渠道失效一致：独立提交，保留旧正文/hash，仅让下一轮重建。 */
export async function invalidateOwnerImSnapshots<DB>(db:Kysely<DB>,ownerId:string):Promise<number>{
 const owner=dataContext(ownerId).ownerId
 const result=await sql<{id:number}>`UPDATE conversation_sessions SET snapshot_expires_at=clock_timestamp(),context_epoch=COALESCE(context_epoch,0)+1 WHERE user_id=${owner} AND source IN ('feishu','qq','wechat','telegram') RETURNING id`.execute(db)
 return result.rows.length
}
/** 创建 QQ 凭据并在提交后失效 owner IM 快照、通知现有 live 消费者。 */
export function createQqBotCreator<DB>(db:Kysely<DB>,options:QqBotCreationOptions){
 const read=createUserBotsReader(async(text,params)=>({rows:(await db.executeQuery<Record<string,unknown>>(CompiledQuery.raw(text,params))).rows}),options.decrypt,options.platforms)
 return async(ownerId:string,input:QqBotInput)=>{
  const owner=dataContext(ownerId).ownerId
  if(!(await options.platforms()).includes('qq'))throw new QqBotCreationError('platform_disabled','该即时通讯平台暂未开放')
  if(!input.app_id||!input.app_secret)throw new QqBotCreationError('invalid_credentials','请填写 AppID 和 AppSecret')
  const id=await db.transaction().execute(async tx=>{
   // 正式表没有 owner/platform 唯一键；owner 行锁保护 Node 并发创建。
   await sql`SELECT id FROM users WHERE id=${owner} FOR UPDATE`.execute(tx)
   const existing=(await sql`SELECT id FROM user_bots WHERE user_id=${owner} AND platform='qq' LIMIT 1`.execute(tx)).rows
   if(existing.length)throw new QqBotCreationError('already_exists','每个咕咕账号只能绑定一个 QQ 机器人')
   const encrypted=await options.encrypt(strip(input.app_secret!))
   return insertQqBot(tx,owner,input,encrypted)
  })
  // 与 Python commit→refresh→publish→投影一致，发布失败不撤销已经持久化的凭据。
  const response=(await read(owner)).items.find(item=>item.id===id)!
  if(!response)throw new Error('机器人刷新失败')
  try{await invalidateOwnerImSnapshots(db,owner)}catch{/* Python 的渠道失效为 best-effort；后续仍发布资源变更。 */}
  try{await options.publishChanged(owner)}catch{/* live 不可用不撤销已提交创建。 */}
  return response
 }
}
