import {maskSecret} from '../../shared/secret-mask.js'
function record(value:unknown):value is Record<string,unknown>{return value!==null && typeof value==='object' && !Array.isArray(value)}
/** 仅投影保存的预设，不选取/验证Provider，也不写回或迁移旧配置。 */
export function createVoicePresetsReader(readDocument:()=>unknown|Promise<unknown>) {
 return async()=>{
  const document=await readDocument(),raw=record(document)?document.voice_presets:undefined
  const presets=record(raw)&&Array.isArray(raw.items)?raw:{active_id:'',items:[]}
  const active=String(presets.active_id||'')
  return {active_id:active,items:(presets.items as unknown[]).filter(record).map(item=>({...item,api_key:maskSecret(String(item.api_key||'')),has_api_key:Boolean(item.api_key),active:String(item.id||'')===active}))}
 }
}
