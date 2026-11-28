import {strip} from '../shared/values.js'
import {publicSafeEgressSettings,type SafeEgressReadSettings} from './safe-egress.js'
export interface SafeEgressPatch {enabled?:boolean|null;proxy_url?:string|null;proxy_username?:string|null;proxy_password?:string|null;clear_credentials?:boolean}
export interface SafeEgressUpdateStore {update(change:(current:SafeEgressReadSettings)=>SafeEgressReadSettings):Promise<SafeEgressReadSettings>}
export class SafeEgressUpdateError extends Error {constructor(readonly statusCode:422|500,message:string){super(message)}}
function invalid(message:string):never {throw new SafeEgressUpdateError(422,message)}
/** 保存代理配置不发起请求；禁止userinfo，路径与认证槽保持分离。 */
export function validateSafeEgressProxyUrl(value:string):string {
 const raw=strip(value),prefix=/^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)
 if(!prefix || !['http','https'].includes(prefix[1]!.toLowerCase()))invalid('代理地址必须是 HTTP 或 HTTPS URL')
 const authority=raw.slice(prefix[0].length).split(/[/?#]/,1)[0]!
 if(!authority)invalid('代理地址必须是 HTTP 或 HTTPS URL')
 if(authority.includes('@'))invalid('代理地址不能包含账号密码，请使用独立认证字段')
 if(/[\x00-\x20\x7f]/.test(authority))invalid('代理主机名无效')
 if(raw.includes('\\'))invalid('代理地址格式无效')
 const path=raw.slice(prefix[0].length+authority.length).split(/[?#]/,1)[0]
 if(path!=='' && path!=='/')invalid('代理地址不能包含路径、查询参数或片段')
 let parsed:URL
 try{parsed=new URL(raw)}catch{invalid('代理地址格式无效')}
 if(!parsed.hostname)invalid('代理地址必须是 HTTP 或 HTTPS URL')
 if(parsed.search||parsed.hash)invalid('代理地址不能包含路径、查询参数或片段')
 if(parsed.port && (Number(parsed.port)<1||Number(parsed.port)>65535))invalid('代理端口无效')
 return raw.replace(/\/+$/,'')
}
export function createSafeEgressUpdater(store:SafeEgressUpdateStore,crypto:{decrypt(value:string):string;encrypt(value:string):string}) {
 return async(patch:SafeEgressPatch)=>{
  try{
   const saved=await store.update(current=>{
    const enabled=patch.enabled??current.enabled,rawUrl=patch.proxy_url??current.proxy_url
    const proxy_url=enabled||rawUrl?validateSafeEgressProxyUrl(rawUrl):rawUrl
    let username='',password=''
    if(current.proxy_auth_secret){
     let value:unknown
     try{value=JSON.parse(crypto.decrypt(current.proxy_auth_secret))}catch{throw new SafeEgressUpdateError(500,'代理认证配置不可读取，请重新保存')}
     if(!value||typeof value!=='object'||Array.isArray(value))throw new SafeEgressUpdateError(500,'代理认证配置无效，请重新保存')
     const fields=value as Record<string,unknown>;username=String(fields.username||'');password=String(fields.password||'')
    }
    if(patch.clear_credentials){username='';password=''}else{username=patch.proxy_username??username;password=patch.proxy_password??password}
    return {enabled,proxy_url,proxy_auth_secret:username||password?crypto.encrypt(JSON.stringify({username,password})):''}
   })
   return publicSafeEgressSettings(saved)
  }catch(error){if(error instanceof SafeEgressUpdateError)throw error;throw new SafeEgressUpdateError(500,'代理配置保存失败')}
 }
}
