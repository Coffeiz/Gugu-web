import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { createSafeEgressUpdater,SafeEgressUpdateError,type SafeEgressPatch } from '@gugu/core/preferences/safe-egress-update'

import { createSafeEgressSettingsReader } from './network.js'

import { mutateConfigOverride } from '../../adapters/config/config-override-file.js'

import { createPosixConfigFileLock } from '../../adapters/config/posix-config-lock.js'

import { decryptEncryptedString,encryptEncryptedString } from '../../adapters/security/encrypted-string.js'

import { pythonQueryBoolean } from '../../http/python-query.js'

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
function parse(body:unknown):SafeEgressPatch {
 if(!object(body))throw new SafeEgressUpdateError(422,'安全出站配置参数无效')
 const patch:SafeEgressPatch={}
 for(const [key,value] of Object.entries(body)){
  if(!['enabled','proxy_url','proxy_username','proxy_password','clear_credentials'].includes(key))throw new SafeEgressUpdateError(422,'安全出站配置包含不支持的字段')
  if(key==='enabled'||key==='clear_credentials'){
   if(key==='enabled'&&value===null){patch.enabled=null;continue}
   if(typeof value!=='boolean'&&typeof value!=='string'&&value!==0&&value!==1)throw new SafeEgressUpdateError(422,'安全出站配置参数无效')
   try{patch[key]=value===0||value===1?Boolean(value):pythonQueryBoolean(value)}catch{throw new SafeEgressUpdateError(422,'安全出站配置参数无效')}
  }else{
   if(value!==null&&typeof value!=='string')throw new SafeEgressUpdateError(422,'安全出站配置参数无效')
   patch[key as 'proxy_url'|'proxy_username'|'proxy_password']=value
  }
 }
 return patch
}
export function createSafeEgressFileUpdater(env:NodeJS.ProcessEnv,path:string,secretKey:string){
 const read=createSafeEgressSettingsReader(env,path)
 return createSafeEgressUpdater({update:change=>mutateConfigOverride(path,document=>{
  const next=change(read());document.safe_egress={...(object(document.safe_egress)?document.safe_egress:{}),...next};return next
 },createPosixConfigFileLock())},{decrypt:value=>decryptEncryptedString(secretKey,value),encrypt:value=>encryptEncryptedString(secretKey,value)})
}
export interface SafeEgressUpdateOptions {requireAdmin:preHandlerHookHandler;update:ReturnType<typeof createSafeEgressFileUpdater>}
export function registerSafeEgressUpdateRoute(app:FastifyInstance,options:SafeEgressUpdateOptions):void {
 app.patch('/api/v1/admin/safe-egress',{preHandler:options.requireAdmin},async(request,reply)=>{
  try{return await options.update(parse(request.body))}catch(error){if(error instanceof SafeEgressUpdateError)return reply.code(error.statusCode).send({detail:error.message});throw error}
 })
}
