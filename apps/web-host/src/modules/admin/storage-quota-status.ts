import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {readStorageQuotaStatus,StorageQuotaStatusUnavailable,type StorageQuotaStatusStore} from '@gugu/core/admin/storage-quota-status'
import {createRedisValueReader,createRedisScheduledTaskCommands} from '../../adapters/redis-events.js'
export const storageQuotaStateKey='storage:quota_reconcile:manual_state'
export const storageQuotaLockKey='storage:quota_reconcile:lock'
const ttl=7*24*60*60
/** 与Python共用真实状态和锁；CAS同时复核状态版本与锁，避免并发终态丢失。 */
export function createRedisStorageQuotaStatusStore(redisUrl:string):StorageQuotaStatusStore {
 const reads=createRedisValueReader(redisUrl),commands=createRedisScheduledTaskCommands(redisUrl)
 return {
  read:()=>reads(storageQuotaStateKey),
  lockExists:async()=>Number(await commands.exists(storageQuotaLockKey))>0,
  interruptIfUnchanged:async(expected,next)=>Number(await commands.eval("if redis.call('GET',KEYS[1])==ARGV[1] and redis.call('EXISTS',KEYS[2])==0 then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]);return 1 end;return 0",2,storageQuotaStateKey,storageQuotaLockKey,expected,next,String(ttl)))===1,
 }
}
export interface StorageQuotaStatusOptions {requireAdmin:preHandlerHookHandler;store:StorageQuotaStatusStore}
export function registerStorageQuotaStatusRoute(app:FastifyInstance,options:StorageQuotaStatusOptions):void {
 app.get('/api/v1/admin/storage-quota/reconcile',{preHandler:options.requireAdmin},async(_request,reply)=>{try{return await readStorageQuotaStatus(options.store)}catch(error){if(error instanceof StorageQuotaStatusUnavailable)return reply.code(503).send({detail:error.message});throw error}})
}
