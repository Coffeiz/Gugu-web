import {sql,type Kysely} from 'kysely'

type Event=Record<string,unknown>
export interface PerceptionStatsQuery {hours:bigint;limit:bigint;minEvents:bigint;minN:bigint;rateHi:number;ambigHi:number;excludeDev:boolean}
const defaults:PerceptionStatsQuery={hours:168n,limit:20000n,minEvents:1n,minN:10n,rateHi:0.25,ambigHi:60,excludeDev:false}
function integer(value:bigint):number|bigint{return value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):value}
function key(value:unknown):unknown{
 if(value!==null&&typeof value==='object')throw new TypeError('遥测分组字段格式无效')
 return value??null
}
function count(values:unknown[]):Map<unknown,number>{
 const result=new Map<unknown,number>();for(const value of values){const k=key(value);result.set(k,(result.get(k)??0)+1)}return result
}
function inc(map:Map<unknown,number>,value:unknown):void{const k=key(value);map.set(k,(map.get(k)??0)+1)}
function common(map:Map<unknown,number>){return [...map].sort((a,b)=>b[1]-a[1])}
// 直接对 IEEE754 的精确比值做十进制偶数舍入，避免 toFixed/乘幂改变 Python round 的边界。
function round(value:number,digits:number):number{
 if(!Number.isFinite(value))throw new TypeError('遥测数值格式无效')
 if(value===0)return value
 const sign=value<0?-1:1,view=new DataView(new ArrayBuffer(8));view.setFloat64(0,Math.abs(value))
 const bits=view.getBigUint64(0),biased=Number((bits>>52n)&2047n),exponent=(biased?biased-1023:-1022)-52
 let numerator=((bits&((1n<<52n)-1n))|(biased?1n<<52n:0n))*10n**BigInt(digits),denominator=1n
 if(exponent>=0)numerator<<=BigInt(exponent);else denominator<<=BigInt(-exponent)
 let result=numerator/denominator;const remainder=numerator%denominator
 if(remainder*2n>denominator||remainder*2n===denominator&&result%2n===1n)result++
 return sign*Number(result)/10**digits
}
function mean(values:unknown[],digits=1):number|null{
 const nums=values.filter(value=>typeof value==='number'||typeof value==='boolean').map(Number)
 return nums.length?round(nums.reduce((a,b)=>a+b,0)/nums.length,digits):null
}
function timestamp(event:Event):number{
 const value=event.ts||0
 if(typeof value!=='number'&&typeof value!=='boolean')throw new TypeError('遥测时间格式无效')
 return Number(value)
}
function float(value:number):string{return Number.isInteger(value)?`${value}.0`:String(value)}
const pct=(value:number)=>`${round(value*100,0)}%`

/** 真实感知指标：先按用户平均，误判只配对到同用户时间线中的上一轮感知。 */
export function aggregatePerceptionStats(input:readonly unknown[],query:Partial<PerceptionStatsQuery>={},developerPrefixes:ReadonlySet<string>=new Set(),now=Date.now()/1000){
 const q={...defaults,...query}
 if(!Number.isFinite(q.rateHi)||!Number.isFinite(q.ambigHi))throw new TypeError('感知阈值超出范围')
 let events=input.map(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('遥测事件记录格式无效')
  return value as Event
 })
 if(q.hours){const seconds=Number(q.hours*3600n);if(!Number.isFinite(seconds))throw new RangeError('遥测时间窗口超出范围');events=events.filter(event=>timestamp(event)>=now-seconds)}
 if(q.excludeDev)events=events.filter(event=>!developerPrefixes.has(event.u as string))
 const byUser=new Map<unknown,Event[]>(),byUserPerc=new Map<unknown,Event[]>()
 for(const event of events){
  const owner=key(event.u),all=byUser.get(owner)
  if(all)all.push(event);else byUser.set(owner,[event])
  if(event.t==='perc'){const rows=byUserPerc.get(owner);if(rows)rows.push(event);else byUserPerc.set(owner,[event])}
 }
 const active=new Set([...byUserPerc].filter(([,rows])=>BigInt(rows.length)>=q.minEvents).map(([owner])=>owner))
 const perc=events.filter(event=>event.t==='perc'&&active.has(key(event.u))),misp=events.filter(event=>event.t==='misperc'&&active.has(key(event.u)))
 const headers={window_hours:integer(q.hours),min_events:integer(q.minEvents),thresholds:{rate_hi:q.rateHi,min_n:integer(q.minN),ambig_hi:q.ambigHi}}
 if(!active.size)return {...headers,active_users:0,perc_total:0,misperc_total:0,overall_misperc_rate:null,perception_misperc_rate:null,misperc_by_kind:[],avg_ambiguity:null,avg_emo_strength:null,intent_distribution:[] as {intent:unknown;pct:number;count:number;misperc:number;misperc_rate:number|null}[],by_model:[],emotion_distribution:[],feedback_distribution:[],feedback_total:0,flags:[],note:`暂无活跃用户（窗口内对话 ≥${q.minEvents} 轮的用户）—— 多聊几轮再看`}
 const perUserMis=new Map<unknown,number>(),perUserErr=new Map<unknown,number>(),byIntentMis=new Map<unknown,number>(),byModelMis=new Map<unknown,number>(),byKind=new Map<unknown,number>()
 for(const owner of active){
  let previous:Event|undefined
  for(const event of [...byUser.get(owner)!].sort((a,b)=>timestamp(a)-timestamp(b))){
   if(event.t==='perc')previous=event
   else if(event.t==='misperc'&&previous){inc(perUserMis,owner);const kind=event.kind||'未判';inc(byKind,kind);if(kind==='感知误读')inc(perUserErr,owner);inc(byIntentMis,previous.intent);inc(byModelMis,previous.model)}
  }
 }
 const intents=new Set(perc.map(event=>key(event.intent))),shares=new Map([...intents].map(intent=>[intent,[] as number[]]))
 const ambiguities:unknown[]=[],emos:unknown[]=[],rates:number[]=[],errorRates:number[]=[]
 for(const owner of active){
  const rows=byUserPerc.get(owner)!,total=rows.length,counts=count(rows.map(event=>event.intent))
  ambiguities.push(mean(rows.map(event=>event.ambiguity)));emos.push(mean(rows.map(event=>event.emo)))
  rates.push((perUserMis.get(owner)??0)/total);errorRates.push((perUserErr.get(owner)??0)/total)
  for(const intent of intents)shares.get(intent)!.push((counts.get(intent)??0)/total)
 }
 const avgAmbiguity=mean(ambiguities),overall=mean(rates,3),perceptionRate=mean(errorRates,3),pooledIntent=count(perc.map(event=>event.intent))
 const byIntent=[...intents].map(intent=>{
  const values=shares.get(intent)!,c=pooledIntent.get(intent)??0,m=byIntentMis.get(intent)??0
  return {intent,pct:round(values.reduce((a,b)=>a+b,0)/values.length*100,1),count:c,misperc:m,misperc_rate:c?round(m/c,3):null}
 }).sort((a,b)=>b.pct-a.pct)
 const byModel=common(count(perc.map(event=>event.model))).map(([model,c])=>{const m=byModelMis.get(model)??0;return {model:model||'(未知)',count:c,misperc:m,misperc_rate:c?round(m/c,3):null}})
 const feedback=events.filter(event=>event.t==='fb'&&active.has(key(event.u)))
 const flags:string[]=[],flagItems:Record<string,unknown>[]=[]
 for(const row of byIntent)if(BigInt(row.count)>=q.minN&&row.misperc_rate&&row.misperc_rate>q.rateHi){flags.push(`intent「${row.intent}」误判率偏高 ${pct(row.misperc_rate)}（n=${row.count}）`);flagItems.push({kind:'intent',intent:row.intent,rate:row.misperc_rate,count:row.count})}
 if(avgAmbiguity!==null&&avgAmbiguity>q.ambigHi){flags.push(`平均歧义度偏高 ${float(avgAmbiguity)}（模型普遍读不准 / 该多澄清）`);flagItems.push({kind:'ambiguity',value:avgAmbiguity})}
 if(perc.length>=50&&!byIntent.some(row=>['情绪','陪伴'].includes(row.intent as string)&&row.count)){flags.push('情绪/陪伴型占比为 0 —— 情绪需求可能被系统性误归类');flagItems.push({kind:'emotion_zero'})}
 if(overall!==null)for(const row of byModel)if(BigInt(row.count)>=q.minN&&row.misperc_rate&&row.misperc_rate>overall+0.1){flags.push(`模型「${row.model}」误判率 ${pct(row.misperc_rate)} 明显高于整体 ${pct(overall)}`);flagItems.push({kind:'model',model:row.model,rate:row.misperc_rate,overall_rate:overall})}
 return {...headers,active_users:active.size,perc_total:perc.length,misperc_total:misp.length,overall_misperc_rate:overall,perception_misperc_rate:perceptionRate,misperc_by_kind:common(byKind).map(([kind,c])=>({kind,count:c})),avg_ambiguity:avgAmbiguity,avg_emo_strength:mean(emos),intent_distribution:byIntent,by_model:byModel,emotion_distribution:common(count(perc.filter(event=>event.emotion&&event.emotion!=='无').map(event=>event.emotion))).map(([emotion,c])=>({emotion,count:c})),feedback_distribution:common(count(feedback.filter(event=>event.v).map(event=>event.v))).map(([feedback,c])=>({feedback,count:c})),feedback_total:feedback.length,flags,flag_items:flagItems,note:`口径：活跃用户（窗口内 ≥${q.minEvents} 轮）${active.size} 人；头部指标按用户宏平均（重度用户不主导）`}
}

export function createPerceptionStatsReader<DB>(db:Kysely<DB>,readList:(key:string,start:number,stop:number|bigint)=>Promise<readonly string[]>,now:()=>number=()=>Date.now()/1000){
 return async(query:Partial<PerceptionStatsQuery>={})=>{
  const q={...defaults,...query},raw=await readList('perc:events',0,q.limit-1n),events:unknown[]=[]
  for(const line of raw){try{events.push(JSON.parse(line))}catch{/* 与 Python 一致跳过损坏 JSON。 */}}
  const developers=q.excludeDev?new Set((await sql<{id:string}>`SELECT id FROM users WHERE is_developer = true`.execute(db)).rows.map(row=>String(row.id).slice(0,8))):new Set<string>()
  return aggregatePerceptionStats(events,q,developers,now())
 }
}
