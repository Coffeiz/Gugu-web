import {createHash,randomUUID} from 'node:crypto'
import {runContextBranch,stableJson,type Json} from '@gugu/core/agent'
import {prepareGroupDailyCompactionBatch,renderGroupDailyEntries,normalizeGroupEventMemory,deduplicateGroupEventMemory,groupDailyDatesPreserved} from '@gugu/core/im-group-daily-compaction'
import {createImReflectionFiles,type ImReflectionFilePlan} from './files.js'
import type {ImReflectionJob,ImReflectionRuntime} from './contracts.js'

export class ImGroupDailyCompactionError extends Error{constructor(){super('群每日记忆沉淀暂不可用');this.name='ImGroupDailyCompactionError'}}
/** Python同义独立ContextBranch；不加载主对话wire、工具或历史，也不自行写文件/记录用量。 */
export async function prepareImGroupDailyPlan(input:{
 job:ImReflectionJob;runtime:ImReflectionRuntime;files:Pick<ReturnType<typeof createImReflectionFiles>,'read'|'planGroupDaily'>
 entries:readonly (readonly [string,string])[];prompt:string;authorize():Promise<void>;signal?:AbortSignal
}):Promise<{plan:ImReflectionFilePlan&{dailyRemainingEntries:readonly (readonly [string,string])[]};usage:Json;remainingEntries:readonly (readonly [string,string])[]}>{
 try{
  const{job,runtime,files,signal}=input
  async function current(){signal?.throwIfAborted();await input.authorize();signal?.throwIfAborted()}
  if(job.scope.type!=='group'||typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>1048576
   ||runtime.selection.modelIdentity!==job.modelIdentity||runtime.selection.accessScopeHash!==job.accessScopeHash)throw new ImGroupDailyCompactionError()
  await current()
  const initial=await files.read(job),initialDaily=initial.raw.daily??'',entries=input.entries.map(([date,text])=>[date,text] as [string,string])
  const prepared=prepareGroupDailyCompactionBatch(initialDaily,entries)
  if(!prepared?.batch.length)throw new ImGroupDailyCompactionError()
  const delta=`已有长期记忆：\n${initial.raw.memory??''}\n\n近期群聊记录：\n${renderGroupDailyEntries(prepared.batch)}`
  if(Buffer.byteLength(delta)>8*1024*1024)throw new ImGroupDailyCompactionError()
  await current()
  const result=await runContextBranch({...job.identity,
   stableSystem:input.prompt,delta,canonicalHistory:[],tools:[],scope:'group-daily-compaction'},
   {name:'compaction',outputMode:'json',maxOutputTokens:15000,maxRetries:0},
   {digest:value=>createHash('sha256').update(stableJson(value)).digest('hex'),nextId:randomUUID,
    provider:runtime.provider.branchProvider(job.modelIdentity),async pauseBeforeRetry(){throw new ImGroupDailyCompactionError()},diagnostic(){}},signal)
  await current()
  if(!result.ok||!result.output||typeof result.output!=='object'||Array.isArray(result.output)||typeof result.output.memory!=='string')throw new ImGroupDailyCompactionError()
  const memory=deduplicateGroupEventMemory(normalizeGroupEventMemory(result.output.memory,'群组事件记录'))
  if(!memory||!groupDailyDatesPreserved(prepared.batch,memory))throw new ImGroupDailyCompactionError()
  // Provider期间只允许追加新的daily头部；已冻结范围或既有memory有变化都不能覆盖。
  const latest=await files.read(job)
  if(latest.raw.memory!==initial.raw.memory)throw new ImGroupDailyCompactionError()
  const remaining=prepareGroupDailyCompactionBatch(latest.raw.daily??'',entries)
  if(!remaining||stableJson(remaining.batch)!==stableJson(prepared.batch))throw new ImGroupDailyCompactionError()
  await current()
  const plan=await files.planGroupDaily(job,`${memory}\n`,remaining.dailyAfter,{memory:latest.raw.memory??null,daily:latest.raw.daily??null})
  await current()
  return{plan:{...plan,dailyRemainingEntries:remaining.remainingEntries},usage:result.usage,remainingEntries:remaining.remainingEntries}
 }catch{throw new ImGroupDailyCompactionError()}
}
