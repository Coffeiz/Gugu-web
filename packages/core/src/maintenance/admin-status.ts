export interface AdminMaintenanceStore {
 get(key:string):Promise<string|null>
 compareAndSet(key:string,expected:string,value:string,ttlSeconds:number):Promise<boolean>
}
const indexKey='rag:index-rebuild',memoryKey='mem_cleanup:plan'
const idle=()=>({status:'idle'})
function parse(raw:string|null):unknown{
 if(!raw)return idle()
 try{return JSON.parse(raw) as unknown}catch{return idle()}
}
function memoryState(raw:string|null):Record<string,unknown>{
 const value=parse(raw)
 return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:idle()
}

/** 维护结果保持权威快照；超时标记使用CAS，不能覆盖并行Worker的新进度或终态。 */
export function createAdminMaintenanceStatus(store:AdminMaintenanceStore,now:()=>number=()=>Date.now()/1000){
 return {
  async imMemoryModelPreview():Promise<unknown>{
   const raw=await store.get('im_memory:maintenance:model_preview')
   return raw?JSON.parse(raw) as unknown:{status:'idle',done:0,total:0,needs_review:0,failed:0,plan_ready:false}
  },
  async indexRebuild():Promise<unknown>{return parse(await store.get(indexKey))},
  async memoryCleanup():Promise<Record<string,unknown>>{
   const raw=await store.get(memoryKey),data=memoryState(raw)
   if(data.status!=='running')return data
   const timestamp=data.ts||0
   if(typeof timestamp==='string'&&!timestamp.trim())return idle()
   if((typeof timestamp!=='number'&&typeof timestamp!=='string'&&typeof timestamp!=='boolean')||Number.isNaN(Number(timestamp)))return idle()
   if(now()-Number(timestamp)<600)return data
   const stale={status:'stale',done:Object.hasOwn(data,'done')?data.done:0,total:Object.hasOwn(data,'total')?data.total:0,message:'上次预览已超时，请重新生成'}
   if(raw!==null&&await store.compareAndSet(memoryKey,raw,JSON.stringify(stale),3600))return stale
   return memoryState(await store.get(memoryKey))
  },
 }
}
