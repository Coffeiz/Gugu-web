import { createHash } from 'node:crypto'
import type { Json } from '@gugu/core/agent'
import { applyOwnerReflectionOutput } from '@gugu/core/agent'
import { applyImMaintenanceOutput } from '@gugu/core/im-memory-maintenance-apply'
import {normalizeOwnerPeriodicItems,ownerPeriodicAttemptState,ownerPeriodicSuccessState,type OwnerPeriodicField} from '@gugu/core/owner-periodic'
import { createLocalImMemoryMaintenanceStorage, imMemoryMaintenanceScopeFileKey } from '../../admin/memory-apply.js'
import type { ImReflectionJob } from './reflection-contracts.js'

export interface ImReflectionFilePlan { version:1; files:readonly {key:string;beforeHash:string;afterHash:string;text:string}[];
  dailyRemainingEntries?:readonly (readonly [string,string])[] }
const fail=()=>new Error('反思记忆文件暂不可用')
const hash=(raw:string|null)=>createHash('sha256').update(raw===null?'missing:':`text:${raw}`).digest('hex')
const fields=(job:ImReflectionJob)=>job.scope.type==='owner'?['profile','pattern','summary','daily','stance','lens']
  :job.scope.type==='group'?['profile','summary','daily','memory','members']:['profile','pattern','summary','daily','memory']
const writableFields=(job:ImReflectionJob)=>job.scope.type==='owner'?[...fields(job),'memory','pattern_maintenance']:fields(job)
export function reflectionFileKey(job:ImReflectionJob,field:string):string{
  if(!writableFields(job).includes(field))throw fail()
  const filename=field==='daily'||field==='memory'?`${field}.md`:`${field}.json`
  if(job.scope.type==='owner')return `${job.identity.ownerId}/.agent/${filename}`
  return imMemoryMaintenanceScopeFileKey({owner_user_id:job.identity.ownerId,platform:job.actor.platform,bot_id:job.actor.botId,
    scope_type:job.scope.type,scope_id:job.scope.id},filename)
}
export function createImReflectionFiles(root:string){
  const storage=createLocalImMemoryMaintenanceStorage(root)
  function buildPlan(job:ImReflectionJob,raw:Record<string,string|null>,changes:Record<string,unknown>,allowed=fields(job)):ImReflectionFilePlan{
    const files=Object.entries(changes).filter(([field])=>allowed.includes(field)).map(([field,value])=>{
      const text=field==='daily'||field==='memory'?String(value):`${JSON.stringify(value,null,2)}\n`
      if(Buffer.byteLength(text)>2*1024*1024)throw fail()
      return{key:reflectionFileKey(job,field),beforeHash:hash(raw[field]??null),afterHash:hash(text),text}
    }).filter(file=>file.beforeHash!==file.afterHash)
    return{version:1,files}
  }
  async function read(job:ImReflectionJob){
    const current:Record<string,Json>={},raw:Record<string,string|null>={}
    for(const field of fields(job)){
      const key=reflectionFileKey(job,field),value=await storage.read(key);raw[field]=value
      if(field==='daily'||field==='memory')current[field]=value??''
      else if(value===null)current[field]=['profile','pattern'].includes(field)?[]:{}
      else{try{const parsed:unknown=JSON.parse(value);if(!parsed||typeof parsed!=='object'
        ||(['profile','pattern'].includes(field)?!Array.isArray(parsed):Array.isArray(parsed)))throw fail();current[field]=parsed as Json}catch{throw fail()}}
    }
    return{current,raw}
  }
  async function readDaily(job:ImReflectionJob):Promise<{memory:string|null;daily:string|null}>{
    if(job.scope.type!=='owner'&&job.scope.type!=='group')throw fail()
    return{memory:await storage.read(reflectionFileKey(job,'memory')),daily:await storage.read(reflectionFileKey(job,'daily'))}
  }
  async function readPeriodic(job:ImReflectionJob,field:OwnerPeriodicField){
    if(job.scope.type!=='owner'||!['profile','pattern'].includes(field))throw fail()
    const raw=await storage.read(reflectionFileKey(job,field)),stateRaw=await storage.read(reflectionFileKey(job,'pattern_maintenance'))
    try{
      const source:unknown=raw===null?[]:JSON.parse(raw),state:unknown=stateRaw===null?{}:JSON.parse(stateRaw)
      if(!Array.isArray(source)||!state||typeof state!=='object'||Array.isArray(state))throw fail()
      return{items:normalizeOwnerPeriodicItems(field,source),raw,state:state as Record<string,Json>,stateRaw}
    }catch{throw fail()}
  }
  return{read,readDaily,readPeriodic,
    /** 调用方持owner维护锁；单文件原子替换，重启同attempt幂等，旧attempt不得回退时钟。 */
    async beginPeriodicAttempt(job:ImReflectionJob,field:OwnerPeriodicField,at:number,authorize:()=>Promise<void>):Promise<void>{
      if(!Number.isFinite(at)||at<0)throw fail()
      await authorize();const before=await readPeriodic(job,field),previous=before.state[`${field}_last_attempt_at`]
      if(previous!==undefined&&previous!==null&&(!Number.isFinite(Number(previous))||Number(previous)>at))throw fail()
      const state=ownerPeriodicAttemptState(field,before.state,at)
      await authorize()
      const latest=await storage.read(reflectionFileKey(job,'pattern_maintenance'))
      if(latest!==before.stateRaw)throw fail()
      const text=`${JSON.stringify(state,null,2)}\n`
      if(Buffer.byteLength(text)>2*1024*1024)throw fail()
      if(latest!==text)await storage.write(reflectionFileKey(job,'pattern_maintenance'),text)
      await authorize()
    },
    async planPeriodic(job:ImReflectionJob,field:OwnerPeriodicField,items:readonly Json[],at:number,expected:{sourceRaw:string|null;stateRaw:string|null}):Promise<ImReflectionFilePlan>{
      const current=await readPeriodic(job,field)
      if(current.raw!==expected.sourceRaw||current.stateRaw!==expected.stateRaw||!Number.isFinite(at)||at<0)throw fail()
      const state=ownerPeriodicSuccessState(field,current.state,at,items.length)
      return buildPlan(job,{[field]:current.raw,pattern_maintenance:current.stateRaw},{[field]:items,pattern_maintenance:state},[field,'pattern_maintenance'])
    },
    async plan(job:ImReflectionJob,output:Json,now:number,nextId:()=>string):Promise<ImReflectionFilePlan>{
      const{current,raw}=await read(job),date=new Date(now*1000).toISOString().slice(0,10)
      const changes=job.scope.type==='owner'?applyOwnerReflectionOutput({current,output,now,date,nextId})
        :applyImMaintenanceOutput({scopeType:job.scope.type,current,output,now,date})
      return buildPlan(job,raw,{...changes})
    },
    /** 独立群daily沉淀只替换memory/daily；expected围栏Provider后的复读与计划构造间的并发修改。 */
    async planGroupDaily(job:ImReflectionJob,memory:string,daily:string,expected?:{memory:string|null;daily:string|null}):Promise<ImReflectionFilePlan>{
      if(job.scope.type!=='group'||typeof memory!=='string'||typeof daily!=='string')throw fail()
      const{raw}=await read(job)
      if(expected&&(raw.memory!==expected.memory||raw.daily!==expected.daily))throw fail()
      return buildPlan(job,raw,{memory,daily})
    },
    /** owner沉淀只维护长期事件与daily；普通反思read/plan仍保持原六个字段。 */
    async planOwnerDaily(job:ImReflectionJob,memory:string,daily:string,expected?:{memory:string|null;daily:string|null}):Promise<ImReflectionFilePlan>{
      if(job.scope.type!=='owner'||typeof memory!=='string'||typeof daily!=='string')throw fail()
      const raw=await readDaily(job)
      if(expected&&(raw.memory!==expected.memory||raw.daily!==expected.daily))throw fail()
      return buildPlan(job,raw,{memory,daily},['memory','daily'])
    },
    async apply(job:ImReflectionJob,plan:ImReflectionFilePlan,authorize:()=>Promise<void>):Promise<void>{
      if(plan.version!==1||!Array.isArray(plan.files)||plan.files.length>6)throw fail()
      const allowed=new Set(writableFields(job).map(field=>reflectionFileKey(job,field)))
      if(new Set(plan.files.map(file=>file.key)).size!==plan.files.length||plan.files.some(file=>!allowed.has(file.key)
        ||typeof file.text!=='string'||Buffer.byteLength(file.text)>2*1024*1024||hash(file.text)!==file.afterHash))throw fail()
      // 重启后只补未完成的同一正向计划；任何其他写入/清除导致hash漂移都拒绝覆盖。
      for(const file of plan.files){await authorize();const current=hash(await storage.read(file.key))
        if(current!==file.beforeHash&&current!==file.afterHash)throw fail()}
      for(const file of plan.files){await authorize();const current=hash(await storage.read(file.key))
        if(current===file.afterHash)continue;if(current!==file.beforeHash)throw fail();await storage.write(file.key,file.text);await authorize()}
    },
  }
}
