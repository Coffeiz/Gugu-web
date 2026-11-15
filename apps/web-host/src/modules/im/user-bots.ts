import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {Pool} from 'pg'
import {createUserBotsReader} from '@gugu/core/im/user-bots'
import {decryptEncryptedString} from '../../adapters/encrypted-string.js'
export function createPostgresUserBotsReader(pool:Pick<Pool,'query'>,secretKey:string,supportedPlatforms:()=>readonly string[]|Promise<readonly string[]>) {
 return createUserBotsReader((sql,params)=>pool.query(sql,params),value=>decryptEncryptedString(secretKey,value),supportedPlatforms)
}
export interface UserBotsListOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;readBots:ReturnType<typeof createPostgresUserBotsReader>}
export function registerUserBotsListRoute(app:FastifyInstance,options:UserBotsListOptions):void {
 app.get('/api/v1/me/bots',{preHandler:options.requireUser},request=>options.readBots(options.ownerIdFromRequest(request)))
}
