export class BindingCodeUnavailable extends Error {readonly statusCode=503;constructor(){super('暂时无法生成绑定码');this.name='BindingCodeUnavailable'}}
import {dataContext} from '../contracts/index.js'
import type {UserBotsQuery} from './user-bots.js'
export interface BindingCodePorts {
 query:UserBotsQuery
 save(key:string,value:string,ttl:number):Promise<unknown>
 generateCode():string
 generateChallenge():string
 sign(message:string):string
}
/** 绑定码重发覆盖该Bot旧挑战；真实消费方仍须检查Bot/owner/空绑定及尝试预算。 */
export function createUserBotBindingCodeIssuer(ports:BindingCodePorts) {
 return async(ownerId:string,botId:number,platform:'qq'|'telegram')=>{
  const owner=dataContext(ownerId).ownerId
  const bot=(await ports.query('SELECT owner_platform_user_id FROM user_bots WHERE id=$1 AND user_id=$2 AND platform=$3',[botId,owner,platform])).rows[0]
  if(!bot)throw Object.assign(new Error(platform==='qq'?'机器人不存在':'Telegram 机器人不存在'),{statusCode:404})
  if(bot.owner_platform_user_id)throw Object.assign(new Error(platform==='qq'?'QQ 身份已经绑定':'Telegram owner 身份已经绑定'),{statusCode:409})
  const code=ports.generateCode(),challenge=ports.generateChallenge()
  if(!/^\d{6}$/.test(code)||!challenge)throw new Error('绑定挑战生成失败')
  const message=`${platform==='qq'?'':'telegram:'}${botId}:${owner}:${code}`
  try{await ports.save(`im:${platform}-binding:${botId}`,JSON.stringify({user_id:owner,code_hash:ports.sign(message),challenge_id:challenge}),600)}catch{throw new BindingCodeUnavailable()}
  return {code,expires_in:600}
 }
}
