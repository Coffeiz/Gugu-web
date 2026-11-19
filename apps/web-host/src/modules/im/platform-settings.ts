import {readConfigOverride} from '../../adapters/config/config-override-file.js'
import {pythonQueryBoolean} from '../../http/python-query.js'
const platforms=['feishu','qq','wechat','telegram'] as const
function record(value:unknown):Record<string,unknown> {if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('IM平台配置无效');return value as Record<string,unknown>}
function boolean(value:unknown):boolean {
 if(value===0 || value===1)return Boolean(value)
 if(value===undefined || value===null)throw new Error('IM平台配置无效')
 return pythonQueryBoolean(value)
}
/** 与Python先构建环境配置、再合并override一致；每请求重读，不读取.env。 */
export function createImPlatformSettingsReader(env:NodeJS.ProcessEnv,overridePath:string):()=>string[] {
 return ()=>{
  const insensitive=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toLowerCase(),value]))
  const base:Record<string,boolean>=Object.fromEntries(platforms.map(platform=>[platform,true]))
  const raw=insensitive.im
  const whole=raw===undefined?{}:record(JSON.parse(raw))
  for(const platform of platforms) {
   const nested=insensitive[`im__${platform}`]
   if(nested!==undefined)base[platform]=boolean(nested)
   else if(Object.hasOwn(whole,platform))base[platform]=boolean(whole[platform])
  }
  const document=readConfigOverride(overridePath)
  let effective={...base}
  // Python apply_override在IM校验失败时放弃该override，保留有效环境配置。
  if(Object.hasOwn(document,'im'))try {
   const im=document.im===null?{}:record(document.im)
   for(const platform of platforms)if(Object.hasOwn(im,platform))effective[platform]=boolean(im[platform])
  }catch {effective=base}
  return platforms.filter(platform=>effective[platform])
 }
}
