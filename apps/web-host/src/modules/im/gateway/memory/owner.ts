import {reportedReflectionUsage} from './usage.js'
import {stableJson,type Json} from '@gugu/core/agent'
import {parseStructuredJson} from '@gugu/core/providers'
import {strip} from '@gugu/core/shared/values'
import {prepareOwnerDailyCompactionBatch,ownerDailyDatesPreserved,buildOwnerDailyReferenceQuery,renderOwnerDailyEventReferences} from '@gugu/core/owner-daily-compaction'
import {normalizeGroupEventMemory,deduplicateGroupEventMemory} from '@gugu/core/im-group-daily-compaction'
import {createImReflectionFiles,type ImReflectionFilePlan} from './files.js'
import type {ImReflectionJob,ImReflectionRuntime} from './contracts.js'

/** 只携带真实数值用量；不携带Provider错误、正文或参考原文。 */
export class ImOwnerDailyCompactionError extends Error{
 readonly usages:readonly Json[]
 constructor(usages:readonly Json[]=[]){super('个人每日记忆沉淀暂不可用');this.name='ImOwnerDailyCompactionError';this.usages=structuredClone(usages)}
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const denied=(error:unknown)=>object(error)&&['forbidden','unauthorized','permission_denied','access_denied','lease_lost','cancelled'].includes(String(error.code))
/** Python owner daily独立JSON请求；仅把新增章节追加到既有主档，不发送整份memory或聊天快照。 */
export async function prepareImOwnerDailyPlan(input:{
 job:ImReflectionJob;runtime:ImReflectionRuntime;files:Pick<ReturnType<typeof createImReflectionFiles>,'readDaily'|'planOwnerDaily'>
 entries:readonly (readonly [string,string])[];prompt:string;authorize():Promise<void>
 readReferences(query:string,signal:AbortSignal):Promise<readonly unknown[]>;signal?:AbortSignal
}):Promise<{plan:ImReflectionFilePlan&{dailyRemainingEntries:readonly (readonly [string,string])[]};usages:readonly Json[];remainingEntries:readonly (readonly [string,string])[]}>{
 const usages:Json[]=[]
 try{
  const{job,runtime,files}=input,signal=input.signal??new AbortController().signal
  async function current(){signal.throwIfAborted();await input.authorize();signal.throwIfAborted()}
  if(job.scope.type!=='owner'||job.scope.id!==job.identity.sessionId||(job.actor.role!=='owner'&&!job.actor.verifiedOwner)||job.actor.ownerId!==job.identity.ownerId
   ||typeof input.prompt!=='string'||!strip(input.prompt)||Buffer.byteLength(input.prompt)>1048576||typeof input.readReferences!=='function'
   ||runtime.selection.modelIdentity!==job.modelIdentity||runtime.selection.accessScopeHash!==job.accessScopeHash||runtime.selection.contextWindow!==job.contextWindow)throw new ImOwnerDailyCompactionError()
  await current()
  const initial=await files.readDaily(job),entries=input.entries.map(([date,text])=>[date,text] as [string,string])
  const prepared=prepareOwnerDailyCompactionBatch(initial.daily??'',entries)
  if(!prepared?.batch.length)throw new ImOwnerDailyCompactionError()
  let references:readonly unknown[]=[]
  try{references=await input.readReferences(buildOwnerDailyReferenceQuery(prepared.batch),signal)}
  catch(error){await current();if(denied(error))throw error}
  await current()
  if(!Array.isArray(references))throw new ImOwnerDailyCompactionError()
  const delta=`相关历史事件参考：\n${renderOwnerDailyEventReferences(references.filter(object))}\n\n要追加的近期记录（只从这里提取新增事件，不要丢掉日期）：\n${prepared.batch.map(([date,text])=>`- ${date} ${text}`).join('\n')}\n\n请只输出本批次要追加的事件章节。`
  if(Buffer.byteLength(delta)>8*1024*1024)throw new ImOwnerDailyCompactionError()
  let output:Record<string,unknown>|null=null
  for(let attempt=0;attempt<2;attempt++){
   await current()
   let result:Awaited<ReturnType<typeof runtime.provider.completeBranch>>
   try{result=await runtime.provider.completeBranch({...job.identity,modelIdentity:job.modelIdentity,stableSystem:input.prompt,delta,canonicalHistory:[],tools:[],scope:'owner-daily-compaction',
    outputMode:'json',maxOutputTokens:null,cacheSingleflight:false},signal)}
   catch(error){await current();if(denied(error))throw error;continue}
   usages.push(reportedReflectionUsage(result.usage))
   await current()
   // HTTP成功返回后先保留用量；JSON解析失败不能把这次已发生响应当成无响应。
   let parsed:Json
   try{parsed=parseStructuredJson(result.output)}catch{await current();continue}
   if(object(parsed)&&Object.keys(parsed).length){output=parsed;break}
  }
  if(!output||typeof output.entries!=='string')throw new ImOwnerDailyCompactionError(usages)
  const date=/20\d{2}-\d{1,2}-\d{1,2}/u.exec(prepared.batch[0]!.join(' '))?.[0]
  const additions=deduplicateGroupEventMemory(normalizeGroupEventMemory(strip(output.entries),date?`${date} 事件记录`:'事件记录'))
  if(!additions||!ownerDailyDatesPreserved(prepared.batch,additions))throw new ImOwnerDailyCompactionError(usages)
  const latest=await files.readDaily(job)
  if(latest.memory!==initial.memory)throw new ImOwnerDailyCompactionError(usages)
  const remaining=prepareOwnerDailyCompactionBatch(latest.daily??'',entries)
  if(!remaining||stableJson(remaining.batch)!==stableJson(prepared.batch))throw new ImOwnerDailyCompactionError(usages)
  const old=latest.memory??''
  const separator=!old||old.endsWith('\n\n')?'':old.endsWith('\n')?'\n':'\n\n'
  const memory=`${old}${separator}${additions}\n`
  await current()
  const plan=await files.planOwnerDaily(job,memory,remaining.dailyAfter,latest)
  await current()
  return{plan:{...plan,dailyRemainingEntries:remaining.remainingEntries},usages,remainingEntries:remaining.remainingEntries}
 }catch(error){if(error instanceof ImOwnerDailyCompactionError&&error.usages.length>=usages.length)throw error;throw new ImOwnerDailyCompactionError(usages)}
}
