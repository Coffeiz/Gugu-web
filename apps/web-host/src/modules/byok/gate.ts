import {readConfigOverride} from '../../adapters/config-override-file.js'

type RecordValue=Record<string,unknown>
function object(value:unknown):RecordValue{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('BYOK运行策略格式无效')
 return value as RecordValue
}
function boolean(value:unknown):boolean{
 if(typeof value==='boolean')return value
 if(value===0||value===1)return value===1
 if(typeof value==='string'){
  if(['1','true','t','yes','y','on'].includes(value.toLowerCase()))return true
  if(['0','false','f','no','n','off'].includes(value.toLowerCase()))return false
 }
 throw new Error('BYOK运行策略布尔值无效')
}
function truthy(value:unknown):boolean{
 if(Array.isArray(value))return value.length>0
 if(value&&typeof value==='object')return Object.keys(value).length>0
 return Boolean(value)
}

/** 只读可信配置：默认值 < 环境JSON < 嵌套环境 < override；每次读取确保后台改动立即生效。 */
export function createByokGateReader(overridePath:string,env:NodeJS.ProcessEnv):()=>boolean{
 return ()=>{
  const environment=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toUpperCase(),value]))
  const byok=environment.BYOK===undefined?{}:object(JSON.parse(environment.BYOK))
  const ai=environment.AI===undefined?{}:object(JSON.parse(environment.AI))
  let enabled=boolean(environment.BYOK__ENABLED!==undefined?environment.BYOK__ENABLED:Object.hasOwn(byok,'enabled')?byok.enabled:true)
  let mode:unknown=environment.AI__DEPLOYMENT_MODE!==undefined?environment.AI__DEPLOYMENT_MODE:Object.hasOwn(ai,'deployment_mode')?ai.deployment_mode:'cloud'
  if(typeof mode!=='string')throw new Error('BYOK部署模式无效')
  const override=readConfigOverride(overridePath)
  if(override.byok!==undefined&&override.byok!==null){
   const value=object(override.byok)
   // Python apply_override使用model_construct，已有配置的truthiness必须保持。
   if(Object.hasOwn(value,'enabled'))enabled=truthy(value.enabled)
  }
  if(override.ai!==undefined){
   const value=object(override.ai)
   if(Object.hasOwn(value,'deployment_mode'))mode=value.deployment_mode
  }
  return enabled||mode==='local'
 }
}
