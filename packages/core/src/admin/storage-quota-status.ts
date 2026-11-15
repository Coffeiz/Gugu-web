export class StorageQuotaStatusUnavailable extends Error {readonly statusCode=503;constructor(){super('暂时无法读取对账状态');this.name='StorageQuotaStatusUnavailable'}}
export interface StorageQuotaStatusStore {
 read():Promise<string|null>
 lockExists():Promise<boolean>
 interruptIfUnchanged(expected:string,next:string):Promise<boolean>
}
function parse(raw:string|null):Record<string,unknown> {
 if(raw)try{const value:unknown=JSON.parse(raw);if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>}catch{/* Python损坏状态按idle处理。 */}
 return {status:'idle'}
}
/** 状态查询不会启动扫描；旧执行器的锁消失时才标记中断。 */
export async function readStorageQuotaStatus(store:StorageQuotaStatusStore,now:()=>string=()=>new Date().toISOString().replace(/\.000Z$/,'+00:00').replace(/(\.\d{3})Z$/,'$1000+00:00')):Promise<Record<string,unknown>> {
 try {
  const raw=await store.read(),state=parse(raw)
  if(raw && ['queued','running'].includes(String(state.status)) && !await store.lockExists()) {
   const interrupted={...state,status:'interrupted',finished_at:now()}
   if(await store.interruptIfUnchanged(raw,JSON.stringify(interrupted)))return interrupted
   // 并发完成或新执行获得锁时保留最新权威状态，避免读接口覆盖运行结果。
   return parse(await store.read())
  }
  return state
 }catch{throw new StorageQuotaStatusUnavailable()}
}
