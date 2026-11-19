import {strip} from '../shared/values.js'
import {prepareGroupDailyCompactionBatch,renderGroupDailyEntries} from './im-group-daily-compaction.js'

export const OWNER_DAILY_COMPACTION_TRIGGER=50
export const OWNER_DAILY_REFERENCE_LIMIT=10
export const OWNER_DAILY_REFERENCE_MAX_CHARS=6000
export const OWNER_DAILY_QUERY_MAX_CHARS=2000
const invalid=()=>new Error('个人每日记忆数据无效或已变更')
type Entry=readonly [string,string]
function entries(value:readonly Entry[]):void{
 if(!Array.isArray(value)||value.some(item=>!Array.isArray(item)||item.length!==2||item.some(part=>typeof part!=='string')))throw invalid()
}

/** 只读当前分组格式；旧单行日期格式留给显式迁移，不混入生产沉淀。 */
export function parseOwnerDailyEntries(currentDaily:string):Array<[string,string]>{
 if(typeof currentDaily!=='string')throw invalid()
 const result:Array<[string,string]>=[]
 let date=''
 for(const raw of currentDaily.split(/\r\n|[\n\v\f\r\u001c-\u001e\u0085\u2028\u2029]/u)){
  const line=strip(raw)
  if(line.startsWith('##')&&line.length>2&&strip(line[2]!)===''){
   const value=strip(line.slice(2));if(/^\d{4}-\d{2}-\d{2}$/u.test(value)){date=value;continue}
  }
  if(date&&line.startsWith('-')&&line.length>1&&strip(line[1]!)===''){
   const note=strip(line.slice(1));if(note)result.push([date,note])
  }
 }
 return result
}

/** owner初始50条启动，其余冻结尾部、最旧100条和并发新头保护复用共享daily规则。 */
export function prepareOwnerDailyCompactionBatch(currentDaily:string,frozenEntries?:readonly Entry[]):{
 batch:Array<[string,string]>;remainingEntries:Array<[string,string]>;dailyAfter:string
}|null{
 try{
  const current=parseOwnerDailyEntries(currentDaily)
  if(frozenEntries!==undefined)entries(frozenEntries)
  if(frozenEntries===undefined&&current.length<OWNER_DAILY_COMPACTION_TRIGGER)return null
  return prepareGroupDailyCompactionBatch(renderGroupDailyEntries(current),frozenEntries??current)
 }catch{throw invalid()}
}

/** owner允许跳过不值得沉淀的闲聊，只要求保留批次内任一可靠日期；群每日规则要求全部。 */
export function ownerDailyDatesPreserved(batch:readonly Entry[],memory:string):boolean{
 entries(batch);if(typeof memory!=='string')throw invalid()
 const pattern=/20\d{2}-\d{1,2}-\d{1,2}/gu
 const incoming=new Set(batch.map(([date,note])=>`${date}\n${note}`).join('\n').match(pattern)??[])
 const retained=new Set(memory.match(pattern)??[])
 return incoming.size===0||[...incoming].some(date=>retained.has(date))
}

/** Python按Unicode码点截断；只用本批日期与正文，不携带profile/pattern。 */
export function buildOwnerDailyReferenceQuery(batch:readonly Entry[]):string{
 entries(batch)
 const lines=batch.flatMap(([date,note])=>strip(note)?[`- ${strip(date)} ${strip(note)}`]:[])
 return Array.from(lines.join('\n')).slice(0,OWNER_DAILY_QUERY_MAX_CHARS).join('')
}

export interface OwnerDailyEventReference{readonly title?:unknown;readonly text?:unknown;readonly content_hash?:unknown}
/** 只投影历史标题/正文；不输出scope/chunk/score，也不把召回材料当作本批新事实。 */
export function renderOwnerDailyEventReferences(references:readonly OwnerDailyEventReference[]):string{
 if(!Array.isArray(references))throw invalid()
 const rows:string[]=[],seen=new Set<string>();let used=0
 for(const item of references){
  if(!item||typeof item!=='object'||Array.isArray(item))continue
  const text=typeof item.text==='string'?strip(item.text):''
  if(!text)continue
  const title=typeof item.title==='string'?strip(item.title):'历史事件'
  const rendered=`## ${title}\n${text}`
  const key=typeof item.content_hash==='string'&&strip(item.content_hash)?strip(item.content_hash):rendered
  if(seen.has(key))continue
  const bounded=strip(Array.from(rendered).slice(0,OWNER_DAILY_REFERENCE_MAX_CHARS-used).join(''))
  if(!bounded)continue
  rows.push(bounded);seen.add(key);used+=Array.from(bounded).length
  if(rows.length>=OWNER_DAILY_REFERENCE_LIMIT||used>=OWNER_DAILY_REFERENCE_MAX_CHARS)break
 }
 return rows.length?['【历史事件参考，仅用于去重和背景核对】',...rows].join('\n\n'):'（暂无相关历史事件参考）'
}
