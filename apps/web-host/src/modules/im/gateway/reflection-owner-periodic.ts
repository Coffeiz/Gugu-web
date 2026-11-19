import type {Json} from '@gugu/core/agent'
import {parseStructuredJson} from '@gugu/core/providers'
import {checkOwnerPeriodicOutput,type OwnerPeriodicField} from '@gugu/core/owner-periodic'
import {strip} from '@gugu/core/shared/values'
import {reportedReflectionUsage} from './reflection-usage.js'
import type {createImReflectionFiles,ImReflectionFilePlan} from './reflection-files.js'
import type {ImReflectionJob,ImReflectionRuntime} from './reflection-contracts.js'

/** 只保留真实数值用量及是否已失去源授权，不携带模型正文或原始异常。 */
export class ImOwnerPeriodicError extends Error{
 readonly usages:readonly Json[]
 constructor(usages:readonly Json[]=[],readonly cancelled=false){super('个人长期记忆整理暂不可用');this.name='ImOwnerPeriodicError';this.usages=structuredClone(usages)}
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

/** 独立owner维护请求；沿Python把无效JSON投影为空对象后定向纠正一次，不重试Provider错误。 */
export async function prepareImOwnerPeriodicPlan(input:{
 job:ImReflectionJob;field:OwnerPeriodicField;runtime:ImReflectionRuntime
 files:Pick<ReturnType<typeof createImReflectionFiles>,'readPeriodic'|'planPeriodic'>
 prompt:string;authorize():Promise<void>;attemptAt:number;signal?:AbortSignal
}):Promise<{plan:ImReflectionFilePlan;usages:readonly Json[]}>{
 const usages:Json[]=[]
 const cancelled=()=>new ImOwnerPeriodicError(usages,true)
 const signal=input.signal??new AbortController().signal
 async function current(){try{signal.throwIfAborted();await input.authorize();signal.throwIfAborted()}catch{throw cancelled()}}
 try{
  const{job,runtime,files,field}=input
  if(job.scope.type!=='owner'||job.scope.id!==job.identity.sessionId||job.actor.ownerId!==job.identity.ownerId
   ||job.actor.role!=='owner'&&!job.actor.verifiedOwner||!['profile','pattern'].includes(field)
   ||runtime.selection.modelIdentity!==job.modelIdentity||runtime.selection.accessScopeHash!==job.accessScopeHash
   ||runtime.selection.contextWindow!==job.contextWindow||!Number.isFinite(input.attemptAt)||input.attemptAt<0)throw cancelled()
  if(typeof input.prompt!=='string'||!strip(input.prompt)||Buffer.byteLength(input.prompt)>1048576)throw new ImOwnerPeriodicError(usages)
  await current();const source=await files.readPeriodic(job,field);await current()
  if(source.items.length<100||source.state[`${field}_last_attempt_at`]!==input.attemptAt)throw cancelled()
  const delta=source.items.map((item,index)=>`[${index}] ${JSON.stringify(item)}`).join('\n')
  if(Buffer.byteLength(delta)>8*1024*1024)throw cancelled()
  let correction=''
  for(let attempt=0;attempt<2;attempt++){
   await current()
   const result=await runtime.provider.completeBranch({...job.identity,modelIdentity:job.modelIdentity,
    stableSystem:input.prompt+correction,delta,canonicalHistory:[],tools:[],scope:'owner-periodic-compaction',outputMode:'json',cacheSingleflight:false},signal)
   usages.push(reportedReflectionUsage(result.usage));await current()
   const latest=await files.readPeriodic(job,field)
   if(latest.raw!==source.raw||latest.stateRaw!==source.stateRaw)throw cancelled()
   const parsed=parseStructuredJson(result.output),checked=checkOwnerPeriodicOutput(field,object(parsed)?parsed[field]:undefined,source.items)
   if(checked.items!==null){
    await current()
    let plan:ImReflectionFilePlan
    // 冷却起点取模型完成后的成功计划时间；attemptAt只用于冻结本次尝试身份。
    try{plan=await files.planPeriodic(job,field,checked.items,Date.now()/1000,{sourceRaw:source.raw,stateRaw:source.stateRaw})}
    catch{const now=await files.readPeriodic(job,field);if(now.raw!==source.raw||now.stateRaw!==source.stateRaw)throw cancelled();throw new ImOwnerPeriodicError(usages)}
    await current();return{plan,usages}
   }
   if(attempt===1)throw new ImOwnerPeriodicError(usages)
   correction=`\n\n上一轮结果未通过结构校验。请重新基于输入生成完整结果，修正项：reason=${checked.reason}, item_index=${checked.index??'none'}。严格遵循本提示中的 JSON schema 和数量限制，只输出 JSON，不要解释。`
  }
  throw new ImOwnerPeriodicError(usages)
 }catch(error){if(error instanceof ImOwnerPeriodicError)throw error;await current();throw new ImOwnerPeriodicError(usages)}
}
