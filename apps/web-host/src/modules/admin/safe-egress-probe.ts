import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { isPublicAddress } from '@gugu/core/providers/node'
import { createSafeEgressProbe, SafeEgressProbeError } from '@gugu/core/preferences/safe-egress-probe'
import { validateSafeEgressProxyUrl, SafeEgressUpdateError } from '@gugu/core/preferences/safe-egress-update'
import { decryptEncryptedString } from '../../adapters/encrypted-string.js'
import { safeEgressRequest } from '../../adapters/safe-egress-proxy.js'
import { createSafeEgressSettingsReader } from './safe-egress-settings.js'
import { environmentCa } from '@gugu/core/providers/node'
import { pythonQueryBoolean } from '../../http/python-query.js'

type Input = { proxy_url?:string|null; proxy_username?:string|null; proxy_password?:string|null; clear_credentials?:boolean }
function parse(value:unknown): Input | null {
 if(!value || typeof value!=='object' || Array.isArray(value)) return null
 const result:Input={}
 for(const [key,raw] of Object.entries(value)) {
  if(!['enabled','proxy_url','proxy_username','proxy_password','clear_credentials'].includes(key))return null
  if(['enabled','clear_credentials'].includes(key)) {
   try { const bool=raw===0||raw===1?Boolean(raw):pythonQueryBoolean(raw);if(key==='clear_credentials')result.clear_credentials=bool } catch { return null }
  } else {
   if(raw!==null && typeof raw!=='string')return null
   result[key as 'proxy_url'|'proxy_username'|'proxy_password']=raw
  }
 }
 return result
}
export function createSafeEgressFileProbe(env:NodeJS.ProcessEnv,path:string,secretKey:string) {
 const read=createSafeEgressSettingsReader(env,path)
 return async(input:Input)=>{
  const settings=read(), url=validateSafeEgressProxyUrl(input.proxy_url??settings.proxy_url)
  let username='',password=''
  if(settings.proxy_auth_secret) {
   let value:unknown
   try {value=JSON.parse(decryptEncryptedString(secretKey,settings.proxy_auth_secret))} catch {throw Object.assign(new Error('代理认证配置不可读取，请重新保存'),{statusCode:500})}
   if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('代理认证配置无效，请重新保存'),{statusCode:500})
   const auth=value as Record<string,unknown>;username=String(auth.username||'');password=String(auth.password||'')
  }
  if(input.clear_credentials){username='';password=''}else{username=input.proxy_username??username;password=input.proxy_password??password}
  const ca=environmentCa(env)
  const proxy={url,...(username||password?{authorization:`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`} : {}), ...(ca?{ca}:{})}
  const probe=createSafeEgressProbe({
   isAddress:address=>isIP(address)!==0, isPublicAddress, now:()=>performance.now(),
   async queryDns(host,type){
    const query=new URL('https://cloudflare-dns.com/dns-query');query.searchParams.set('name',host);query.searchParams.set('type',type)
    let response:{status:number;body:string}
    try{response=await safeEgressRequest(proxy,query,'cloudflare-dns.com',10000)}catch(error){if(error instanceof SafeEgressProbeError && error.stage==='proxy_unavailable')throw error;throw new SafeEgressProbeError('resolver_unavailable','安全 DNS 查询失败（经代理）')}
    if(response.status===407)throw new SafeEgressProbeError('proxy_unavailable','代理认证失败（HTTP 407）')
    if(response.status<200||response.status>=300)throw new SafeEgressProbeError('resolver_unavailable','安全 DNS 服务返回错误状态')
    let data:unknown;try{data=JSON.parse(response.body)}catch{throw new SafeEgressProbeError('resolver_unavailable','安全 DNS 查询失败（经代理）')}
    if(!data||typeof data!=='object'||Array.isArray(data))return []
    const record=data as Record<string,unknown>;return record.Status===0&&Array.isArray(record.Answer)?record.Answer:[]
   },
   async requestTarget(target,address){const host=isIP(address)===6?`[${address}]`:address;return (await safeEgressRequest(proxy,new URL(target),host,15000)).status},
  })
  return probe()
 }
}
export function registerSafeEgressProbeRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;probe:ReturnType<typeof createSafeEgressFileProbe>}):void {
 app.post('/api/v1/admin/safe-egress/test',{preHandler:options.requireAdmin},async(request,reply)=>{
  const body=parse(request.body);if(!body)return reply.code(422).send({detail:'安全出站测试参数无效'})
  try{return await options.probe(body)}catch(error){if(error instanceof SafeEgressUpdateError)return reply.code(error.statusCode).send({detail:error.message});if(error instanceof Error&&(error as Error&{statusCode?:number}).statusCode===500)return reply.code(500).send({detail:error.message});return reply.code(500).send({detail:'安全出站配置不可读取'})}
 })
}
