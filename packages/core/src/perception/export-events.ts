import type {PerceptionListReader} from './recent-misread.js'

function timestamp(value:unknown):unknown{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('遥测事件记录格式无效')
 const ts=(value as Record<string,unknown>).ts
 if(!ts||(Array.isArray(ts)&&!ts.length)||(typeof ts==='object'&&Object.keys(ts).length===0))return 0
 return ts
}
function numeric(value:unknown):number{
 if(typeof value==='boolean')return Number(value)
 if(typeof value==='number')return value
 throw new TypeError('遥测时间格式无效')
}
function compare(left:unknown,right:unknown):number{
 if(typeof left==='string'&&typeof right==='string'){
  const a=Array.from(left),b=Array.from(right)
  for(let i=0;i<Math.min(a.length,b.length);i++){
   const diff=a[i]!.codePointAt(0)!-b[i]!.codePointAt(0)!
   if(diff)return diff
  }
  return a.length-b.length
 }
 return numeric(left)-numeric(right)
}
/** 导出实际反思遥测快照，不修改 Redis，不访问记忆文件或执行模型。 */
export function createPerceptionEventExporter(readList:PerceptionListReader,now:()=>number=()=>Date.now()/1000){
 return async(hours=0n):Promise<{events:unknown[];filename:string}>=>{
  const raw=await readList('perc:events',0,-1),events:unknown[]=[]
  for(const line of raw){try{events.push(JSON.parse(line))}catch{/* 跳过参考 handler 同样忽略的损坏 JSON。 */}}
  let timed=events.map(event=>({event,ts:timestamp(event)}))
  if(hours){
   const seconds=Number(hours*3600n)
   if(!Number.isFinite(seconds))throw new RangeError('遥测时间窗口超出范围')
   const cutoff=now()-seconds
   timed=timed.filter(item=>numeric(item.ts)>=cutoff)
  }
  timed.sort((left,right)=>compare(left.ts,right.ts))
  return {events:timed.map(item=>item.event),filename:`perception_events_${hours||'all'}h.json`}
 }
}
