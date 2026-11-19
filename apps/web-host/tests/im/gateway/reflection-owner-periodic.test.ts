import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {test} from 'node:test'
import {stableJson} from '@gugu/core/agent'
import {ProviderRuntime,type ProviderHttpRequest} from '@gugu/core/providers'
import {prepareImOwnerPeriodicPlan,ImOwnerPeriodicError} from '../../../src/modules/im/gateway/reflection-owner-periodic.js'
import {createImReflectionFiles,reflectionFileKey} from '../../../src/modules/im/gateway/reflection-files.js'
import type {ImReflectionJob,ImReflectionRuntime} from '../../../src/modules/im/gateway/reflection-contracts.js'
import {context} from './run-sender.fixtures.js'

const entries=(count:number):[string,string][]=>Array.from({length:count},(_,n)=>[`2026-11-${String(18-Math.floor(n/40)).padStart(2,'0')}`,`合成owner事件${n}`])
const oldMemory='## 记录长期记忆：旧事件\n\n2020-01-02 旧资料仅存本地，不送整份Provider'
const addition='## 合成新事件\n2026-11-18 完成公开展览\n\n## 合成新事件\n2026-11-18 完成公开展览'
async function fixture(){
 const source=context(),root=await mkdtemp(join(tmpdir(),'gugu-owner-daily-'))
 const job:ImReflectionJob={id:randomUUID(),identity:source.identity,actor:source.actor,scope:{type:'owner',id:source.identity.sessionId},messageIds:['31'],
  modelIdentity:'synthetic-owner-daily',accessScopeHash:'synthetic-owner-access',contextWindow:32000,ownerMessage:'',assistantEvidence:'',hadTools:false}
 const files=createImReflectionFiles(root),memoryPath=join(root,reflectionFileKey(job,'memory')),dailyPath=join(root,reflectionFileKey(job,'daily')),requests:ProviderHttpRequest[]=[]
 let queue:{output:unknown;rawContent?:string;status?:number;usage?:unknown}[]=[{output:{entries:addition}}],allowed=true,referenceCalls=0
 let referenceFailure:unknown=null,onResponse:(()=>Promise<void>)|null=null,referenceHook:(()=>void)|null=null
 const references=[{title:'合成历史事件',text:'历史参考仅供去重',content_hash:'synthetic-hash',chunk_id:'synthetic-private-chunk',score:999},
  {title:'重复历史事件',text:'历史参考仅供去重',content_hash:'synthetic-hash'}]
 const provider=new ProviderRuntime({digest:value=>createHash('sha256').update(stableJson(value)).digest('hex'),nextId:randomUUID,
  references:{dehydrate:async entry=>entry.message,hydrate:async entry=>entry.message},prepareRequest:async()=>assert.fail('owner沉淀不能准备主请求'),
  async resolve(){return{modelIdentity:job.modelIdentity,accessScopeHash:job.accessScopeHash,config:{provider:'openai',api_format:'openai',model:'synthetic',api_key:'synthetic-owner-key',base_url:'https://provider.example.test/v1',context_window:32000},systemPrompt:'合成主聊天私有system'}},
  transport:{async request(request){requests.push(request);await onResponse?.();const next=queue.shift()??{output:{entries:addition}}
   const status=next.status??200,value=status===200?{choices:[{message:{content:next.rawContent??JSON.stringify(next.output)},finish_reason:'stop'}],
    ...(next.usage===null?{}:{usage:next.usage??{prompt_tokens:9,completion_tokens:4}})}:{error:{message:'synthetic-private-owner-provider'}}
   return{status,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify(value))})(),cancel(){}}}}
 })
 const runtime:ImReflectionRuntime={provider,selection:{modelIdentity:job.modelIdentity,accessScopeHash:job.accessScopeHash,contextWindow:job.contextWindow},usageConfig:{defaultLimit6h:null,byokEnabled:false,localDeployment:true,model:'synthetic',provider:'openai',isByok:false},release:()=>provider.close()}
 const prompt=await readFile(new URL('../../../../../backend/agent/prompts/memory_compress.md',import.meta.url),'utf8')
 return{job,files,runtime,requests,memoryPath,dailyPath,prompt,async authorize(){if(!allowed)throw Error('synthetic-private-revocation')},
  async readReferences(query:string,signal:AbortSignal){signal.throwIfAborted();referenceCalls++;assert.ok(Array.from(query).length<=2000);referenceHook?.();if(referenceFailure)throw referenceFailure;return references},
  async write(daily:string,memory=oldMemory){await mkdir(dirname(memoryPath),{recursive:true});await writeFile(memoryPath,memory);await writeFile(dailyPath,daily)},
  queue(value:typeof queue){queue=value},failReferences(error:unknown){referenceFailure=error},onReference(value:()=>void){referenceHook=value},referenceCalls:()=>referenceCalls,
  revoke(){allowed=false},onResponse(value:()=>Promise<void>){onResponse=value},async close(){await provider.close();await rm(root,{recursive:true,force:true})}}
}

const profile=Array.from({length:100},(_,index)=>({type:'note',text:`合成档案${index}`,ts:1}))
const patterns=Array.from({length:100},(_,index)=>({id:`p${index}`,text:`合成行为${index}`,kind:'observed',conf:0.8,imp:3,ts:1}))
async function begin(f:Awaited<ReturnType<typeof fixture>>,field:'profile'|'pattern'='profile'){
 const path=join(dirname(f.memoryPath),`${field}.json`),statePath=join(dirname(f.memoryPath),'pattern_maintenance.json')
 await f.write('')
 await writeFile(path,JSON.stringify(field==='profile'?profile:patterns))
 await writeFile(statePath,JSON.stringify({extra:'保留扩展',pattern_last_attempt_at:2,reviewed_count:7}))
 await f.files.beginPeriodicAttempt(f.job,field,100,f.authorize)
 const prompt=await readFile(new URL(`../../../../../backend/agent/prompts/${field}_compact.md`,import.meta.url),'utf8')
 return{path,statePath,prompt,field,attemptAt:100}
}

test('实际私聊owner独立请求：一次结构纠正、两份真实用量、成功列表与独立水位CAS',async()=>{
 const f=await fixture();try{
  const input=await begin(f);assert.equal(f.job.actor.role,'owner')
  f.queue([{output:{profile:[]},usage:{prompt_tokens:3,completion_tokens:1}},{output:{profile:[profile[0]]},usage:{prompt_tokens:5,completion_tokens:2}}])
  const before=Date.now()/1000,result=await prepareImOwnerPeriodicPlan({...f,...input}),after=Date.now()/1000
  assert.equal(f.requests.length,2);assert.deepEqual(result.usages.map(value=>(value as {input:number}).input),[3,5])
  const first=f.requests[0]!.body as Record<string,unknown>,second=f.requests[1]!.body as Record<string,unknown>
  assert.doesNotMatch(JSON.stringify(first),/合成主聊天私有system|相关历史事件参考/)
  assert.match(JSON.stringify(first),/\[99\]/);assert.ok(!Array.isArray(first.tools)||first.tools.length===0)
  assert.match(JSON.stringify(second),/reason=profile_result_empty/);assert.match(JSON.stringify(second),/item_index=none/)
  await f.files.apply(f.job,result.plan,f.authorize);await f.files.apply(f.job,result.plan,f.authorize)
  assert.equal(JSON.parse(await readFile(input.path,'utf8')).length,1)
  const state=JSON.parse(await readFile(input.statePath,'utf8'))
  assert.ok(state.profile_last_compact_at>=before&&state.profile_last_compact_at<=after);assert.equal(state.profile_compacted_count,1)
  assert.equal(state.reviewed_count,7);assert.equal(state.pattern_last_attempt_at,2);assert.equal(state.extra,'保留扩展')
  assert.equal(Object.hasOwn((await f.files.read(f.job)).current,'pattern_maintenance'),false)
 }finally{await f.close()}
})

test('Provider错误不重试；坏JSON按Python空对象纠正一次，二次失败不写列表且保留费用',async()=>{
 for(const mode of['provider','json','schema'] as const){const f=await fixture();try{
  const input=await begin(f),before=await readFile(input.path,'utf8')
  f.queue(mode==='provider'?[{status:400,output:{}}]:mode==='json'?[{output:{},rawContent:'synthetic-private-invalid',usage:{prompt_tokens:3,completion_tokens:1}},{output:{},rawContent:'synthetic-private-invalid-again',usage:{prompt_tokens:5,completion_tokens:2}}]:[{output:{profile:[]}},{output:{profile:[]}}])
  await assert.rejects(prepareImOwnerPeriodicPlan({...f,...input}),error=>error instanceof ImOwnerPeriodicError&&!error.cancelled
   &&error.usages.length===(mode==='provider'?0:2)&&!String(error).includes('synthetic-private')&&!('cause'in error))
  assert.equal(f.requests.length,mode==='provider'?1:2);assert.equal(await readFile(input.path,'utf8'),before)
  assert.equal(JSON.parse(await readFile(input.statePath,'utf8')).profile_last_compact_at,undefined)
 }finally{await f.close()}}
})

test('源/metadata漂移、撤权和member均取消；成功计划不覆盖其后编辑，attempt幂等且不回退',async()=>{
 for(const mode of['source','state','revoked','member','plan'] as const){const f=await fixture();try{
  const input=await begin(f)
  const initial=await readFile(input.statePath,'utf8');await f.files.beginPeriodicAttempt(f.job,'profile',100,f.authorize)
  assert.equal(await readFile(input.statePath,'utf8'),initial)
  await assert.rejects(f.files.beginPeriodicAttempt(f.job,'profile',99,f.authorize))
  f.queue([{output:{profile:[profile[0]]}}])
  if(mode==='source')f.onResponse(()=>writeFile(input.path,JSON.stringify([...profile,{type:'note',text:'新条目'}])))
  if(mode==='state')f.onResponse(()=>writeFile(input.statePath,JSON.stringify({profile_last_attempt_at:101})))
  if(mode==='revoked')f.onResponse(async()=>f.revoke())
  const args={...f,...input,...(mode==='member'?{job:{...f.job,actor:{...f.job.actor,role:'member' as const,verifiedOwner:false}}}:{})}
  if(mode==='plan'){
   const result=await prepareImOwnerPeriodicPlan(args);await writeFile(input.path,'[]')
   await assert.rejects(f.files.apply(f.job,result.plan,f.authorize));assert.equal(await readFile(input.path,'utf8'),'[]')
  }else await assert.rejects(prepareImOwnerPeriodicPlan(args),error=>error instanceof ImOwnerPeriodicError&&error.cancelled)
  if(mode==='member')assert.equal(f.requests.length,0)
 }finally{await f.close()}}
})

test('pattern源ID校验纠正、排序和未知用量不伪造零，另一field水位保持',async()=>{
 const f=await fixture();try{
  const input=await begin(f,'pattern')
  f.queue([{output:{pattern:[{...patterns[0],id:'foreign-id'}]},usage:null},{output:{pattern:[{...patterns[1],conf:0.5},patterns[0]]},usage:null}])
  const before=Date.now()/1000,result=await prepareImOwnerPeriodicPlan({...f,...input}),after=Date.now()/1000;assert.deepEqual(result.usages,[null,null])
  assert.match(JSON.stringify(f.requests[1]!.body),/pattern_source_id_invalid/)
  await f.files.apply(f.job,result.plan,f.authorize)
  assert.equal(JSON.parse(await readFile(input.path,'utf8'))[0].id,'p0')
  const state=JSON.parse(await readFile(input.statePath,'utf8'));assert.ok(state.last_review_at>=before&&state.last_review_at<=after);assert.equal(state.reviewed_count,2)
  assert.equal(state.profile_last_compact_at,undefined)
 }finally{await f.close()}
})
