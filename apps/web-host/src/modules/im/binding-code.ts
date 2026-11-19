import {createHmac,randomBytes,randomInt} from 'node:crypto'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {Pool} from 'pg'
import {createUserBotBindingCodeIssuer,BindingCodeUnavailable} from '@gugu/core/im/binding-code'
import {createRedisScheduledTaskCommands} from '../../adapters/cache/redis-events.js'
export function createPostgresRedisBindingCodeIssuer(pool:Pick<Pool,'query'>,redisUrl:string,secretKey:string) {
 const redis=createRedisScheduledTaskCommands(redisUrl)
 return createUserBotBindingCodeIssuer({query:(sql,params)=>pool.query(sql,params),
  save:async(key,value,ttl)=>{if(await redis.set(key,value,'EX',String(ttl))!=='OK')throw new Error('绑定挑战保存失败')},
  generateCode:()=>String(randomInt(1000000)).padStart(6,'0'),generateChallenge:()=>randomBytes(12).toString('base64url'),sign:message=>createHmac('sha256',secretKey).update(message).digest('hex')})
}
export interface UserBotBindingCodeOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;issue:ReturnType<typeof createPostgresRedisBindingCodeIssuer>}
export function registerUserBotBindingCodeRoutes(app:FastifyInstance,options:UserBotBindingCodeOptions):void {
 for(const [path,platform] of [['/api/v1/me/bots/:bot_id/qq-binding-code','qq'],['/api/v1/me/telegram/connect/:bot_id/binding-code','telegram']] as const) {
  app.post<{Params:{bot_id:number}}>(path,{preHandler:options.requireUser,schema:{params:{type:'object',required:['bot_id'],properties:{bot_id:{type:'integer'}}}}},async(request,reply)=>{try{return await options.issue(options.ownerIdFromRequest(request),request.params.bot_id,platform)}catch(error){if(error instanceof BindingCodeUnavailable)return reply.code(503).send({detail:error.message});throw error}})
 }
}
