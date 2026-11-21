import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {test} from 'node:test'
import {stableJson} from '@gugu/core/agent'
import {readAgentPrompt} from '@gugu/core/agent/context/prompts'
import {ProviderRuntime,type ProviderHttpRequest} from '@gugu/core/providers'
import {parseOwnerDailyEntries} from '@gugu/core/owner-daily-compaction'
import {renderGroupDailyEntries} from '@gugu/core/im-group-daily-compaction'
import {prepareImOwnerDailyPlan,ImOwnerDailyCompactionError} from '../../../../src/modules/im/gateway/memory/owner.js'
import {createImReflectionFiles,reflectionFileKey} from '../../../../src/modules/im/gateway/memory/files.js'
import type {ImReflectionJob,ImReflectionRuntime} from '../../../../src/modules/im/gateway/memory/contracts.js'
import {context} from '../run-sender.fixtures.js'

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
 const prompt=readAgentPrompt('memory_compress.md')
 return{job,files,runtime,requests,memoryPath,dailyPath,prompt,async authorize(){if(!allowed)throw Error('synthetic-private-revocation')},
  async readReferences(query:string,signal:AbortSignal){signal.throwIfAborted();referenceCalls++;assert.ok(Array.from(query).length<=2000);referenceHook?.();if(referenceFailure)throw referenceFailure;return references},
  async write(daily:string,memory=oldMemory){await mkdir(dirname(memoryPath),{recursive:true});await writeFile(memoryPath,memory);await writeFile(dailyPath,daily)},
  queue(value:typeof queue){queue=value},failReferences(error:unknown){referenceFailure=error},onReference(value:()=>void){referenceHook=value},referenceCalls:()=>referenceCalls,
  revoke(){allowed=false},onResponse(value:()=>Promise<void>){onResponse=value},async close(){await provider.close();await rm(root,{recursive:true,force:true})}}
}

test('实际c2c owner与verified=false兼容投影：独立无token上限JSON、参考投影、任一日期、追加及CAS',async()=>{
 const f=await fixture();try{
  assert.equal(f.job.actor.role,'owner');assert.equal(f.job.actor.verifiedOwner,true,'当前真实Core私聊owner投影保留verified，不伪造上游行为')
  const frozen=entries(120),head:[string,string]=['2026-11-19','合成新增头部'];await f.write(renderGroupDailyEntries([head,...frozen]))
  const ordinary=await f.files.read(f.job);assert.equal(Object.hasOwn(ordinary.current,'memory'),false);assert.equal(Object.hasOwn(ordinary.raw,'memory'),false)
  const result=await prepareImOwnerDailyPlan({...f,entries:frozen})
  assert.equal(f.requests.length,1);const body=f.requests[0]!.body as Record<string,unknown>,wire=JSON.stringify(body)
  assert.equal(body.max_tokens,undefined);assert.equal(body.max_completion_tokens,undefined);assert.notEqual(body.stream,true)
  assert.doesNotMatch(wire,/旧资料仅存本地|合成主聊天私有system|synthetic-private-chunk|score/)
  assert.match(wire,/相关历史事件参考/);assert.match(wire,/要追加的近期记录/)
  assert.equal((wire.match(/历史参考仅供去重/gu)??[]).length,1);assert.equal((body.messages as unknown[]).length,2)
  assert.ok(!Array.isArray(body.tools)||body.tools.length===0);assert.equal(result.remainingEntries.length,20)
  assert.deepEqual(result.usages,[{input:9,output:4,cacheRead:0,cacheWrite:0}])
  const compatible=await prepareImOwnerDailyPlan({...f,job:{...f.job,actor:{...f.job.actor,verifiedOwner:false}},entries:frozen})
  assert.deepEqual(compatible.plan.files,result.plan.files,'已授权owner角色的历史false字段不误拒，仍由真实authorize复核')
  await f.files.apply(f.job,result.plan,f.authorize);await f.files.apply(f.job,result.plan,f.authorize)
  const memory=await readFile(f.memoryPath,'utf8');assert.ok(memory.startsWith(`${oldMemory}\n\n`),'不归一或重写旧主档，只追加新增章节')
  assert.equal((memory.match(/## 记录长期记忆：合成新事件/gu)??[]).length,1)
  assert.deepEqual(parseOwnerDailyEntries(await readFile(f.dailyPath,'utf8')),[head,...frozen.slice(0,20)])
  const normalPlan=await f.files.plan(f.job,{memory:'模型不能扩大普通owner反思写集'},1,randomUUID)
  assert.equal(normalPlan.files.some(file=>file.key===reflectionFileKey(f.job,'memory')),false)
 }finally{await f.close()}
})

test('个人记忆保留主要资料链接并原样追加 Markdown，旧章节字节保持一致',async t=>{
 const f=await fixture()
 try{
  const links=[
   '[交付文件](gugu://open-object/file/path-c3ludGhldGlj)',
   '[验收对话](https://chat.example.test/conversations/31)',
   '[验收任务](gugu://open-object/scheduled-task/32)',
   '[改版项目](gugu://open-object/project/33)',
  ]
  const old=`\n${oldMemory}  \n\n\n`
  const frozen=entries(50)
  frozen[0]=['2026-11-18',`确认交付，相关资料：${links.join('、')}`]
  await f.write(renderGroupDailyEntries(frozen),old)
  const chapter=[
   '## 记录长期记忆：确认改版交付','','- 时间：2026-11-18','- 类型：项目工作','- 状态：已完成',
   '','### 事件经过','用户确认交付。','','### 相关资料',
   ...links.map(link=>`- ${link}`),
  ].join('\n')
  f.queue([{output:{entries:chapter}}])
  const result=await prepareImOwnerDailyPlan({...f,entries:frozen})
  const wire=JSON.stringify(f.requests[0]!.body)
  for(const link of links)assert.ok(wire.includes(link))
  const expected=Buffer.from(`${old}${chapter}\n`)
  const memory=result.plan.files.find(file=>file.key===reflectionFileKey(f.job,'memory'))
  assert.ok(memory)
  assert.deepEqual(Buffer.from(memory.text),expected)
  await t.test('落盘内容与追加计划一致',{skip:process.platform!=='linux'&&'生产原子写入要求 Linux'},async()=>{
   await f.files.apply(f.job,result.plan,f.authorize)
   assert.deepEqual(await readFile(f.memoryPath),expected)
  })
 }finally{await f.close()}
})

test('仅Provider异常或空对象最多重试两次，逐合法响应保留用量；非空无entries/空entries/丢全部日期不重试',async()=>{
 for(const mode of['provider-first','empty-first','two-empty','missing','empty-entries','missing-dates'] as const){const f=await fixture();try{
  const frozen=entries(50);await f.write(renderGroupDailyEntries(frozen))
  if(mode==='provider-first')f.queue([{status:400,output:{}},{output:{entries:addition}}])
  if(mode==='empty-first')f.queue([{output:{},usage:{prompt_tokens:3,completion_tokens:1}},{output:{entries:addition},usage:{prompt_tokens:5,completion_tokens:2}}])
  if(mode==='two-empty')f.queue([{output:{}},{output:{}}])
  if(mode==='missing')f.queue([{output:{memory:'不允许以memory字段替换owner主档'}}])
  if(mode==='empty-entries')f.queue([{output:{entries:''}}])
  if(mode==='missing-dates')f.queue([{output:{entries:'## 新事件\n2020-02-03 不是本批日期'}}])
  if(mode==='provider-first'||mode==='empty-first'){
   const result=await prepareImOwnerDailyPlan({...f,entries:frozen});assert.equal(f.requests.length,2)
   assert.equal(result.usages.length,mode==='provider-first'?1:2)
   if(mode==='empty-first')assert.deepEqual(result.usages.map(usage=>(usage as {input:number}).input),[3,5])
  }else{await assert.rejects(prepareImOwnerDailyPlan({...f,entries:frozen}),error=>error instanceof ImOwnerDailyCompactionError&&error.usages.length===(mode==='two-empty'?2:1)&&!String(error).includes('synthetic-private'))
   assert.equal(f.requests.length,mode==='two-empty'?2:1)}
  assert.equal(await readFile(f.memoryPath,'utf8'),oldMemory,'只准备计划，错误不落文件')
 }finally{await f.close()}}
})

test('RAG暂时故障可无参考继续，撤权/明确权限拒绝和member不降级；未报告用量保留unknown',async()=>{
 for(const mode of['rag-failure','rag-denied','rag-revoked','member','unknown-usage','zero-usage','partial-usage'] as const){const f=await fixture();try{
  const frozen=entries(50);await f.write(renderGroupDailyEntries(frozen))
  if(mode==='rag-failure')f.failReferences(Error('synthetic-private-rag-fault'))
  if(mode==='rag-denied')f.failReferences(Object.assign(Error('synthetic-private-denial'),{code:'forbidden'}))
  if(mode==='rag-revoked'){f.onReference(()=>f.revoke());f.failReferences(Error('synthetic-private-rag-fault'))}
  if(mode==='unknown-usage')f.queue([{output:{entries:addition},usage:null}])
  if(mode==='zero-usage')f.queue([{output:{entries:addition},usage:{prompt_tokens:0,completion_tokens:0}}])
  if(mode==='partial-usage')f.queue([{output:{entries:addition},usage:{completion_tokens:3}}])
  const input={...f,entries:frozen,...(mode==='member'?{job:{...f.job,actor:{...f.job.actor,role:'member' as const,verifiedOwner:false}}}:{})}
  if(mode==='rag-failure'||mode==='unknown-usage'||mode==='zero-usage'||mode==='partial-usage'){
   const result=await prepareImOwnerDailyPlan(input);assert.equal(f.requests.length,1)
   if(mode==='rag-failure')assert.match(JSON.stringify(f.requests[0]!.body),/暂无相关历史事件参考/)
   if(mode==='unknown-usage'){assert.equal(result.usages.length,1);assert.ok(result.usages[0]===null||Object.values(result.usages[0] as object).every(value=>value===null),'未报数值不编造0')}
   if(mode==='zero-usage')assert.deepEqual(result.usages,[{input:0,output:0,cacheRead:0,cacheWrite:0}],'明确报告的0不能误判unknown')
   if(mode==='partial-usage')assert.deepEqual(result.usages,[{input:null,output:3,cacheRead:null,cacheWrite:null}],'保留可靠正数，不给未报告的输入和缓存补0')
  }else{await assert.rejects(prepareImOwnerDailyPlan(input),error=>error instanceof ImOwnerDailyCompactionError&&!String(error).includes('synthetic-private'));assert.equal(f.requests.length,0)}
 }finally{await f.close()}}
})

test('合法HTTP的无效JSON正文先保留用量再重试，两次失败错误仍只带两份数值用量',async()=>{
 for(const twice of[false,true]){const f=await fixture();try{
  const frozen=entries(50),daily=renderGroupDailyEntries(frozen);await f.write(daily)
  f.queue([{output:null,rawContent:'synthetic-not-json',usage:{prompt_tokens:3,completion_tokens:1}},
   {output:twice?null:{entries:addition},...(twice?{rawContent:'synthetic-private-invalid-json'}:{}),usage:{prompt_tokens:5,completion_tokens:2}}])
  if(twice)await assert.rejects(prepareImOwnerDailyPlan({...f,entries:frozen}),error=>error instanceof ImOwnerDailyCompactionError
   &&JSON.stringify(error.usages.map(usage=>(usage as {input:number}).input))==='[3,5]'
   &&!String(error).includes('synthetic-')&&!JSON.stringify(error.usages).includes('synthetic-')&&!('cause'in error))
  else{const result=await prepareImOwnerDailyPlan({...f,entries:frozen});assert.deepEqual(result.usages.map(usage=>(usage as {input:number}).input),[3,5])}
  assert.equal(f.requests.length,2);assert.equal(await readFile(f.memoryPath,'utf8'),oldMemory);assert.equal(await readFile(f.dailyPath,'utf8'),daily)
 }finally{await f.close()}}
})

test('Provider期间只允许追加daily新头；旧memory/旧daily变化或计划后hash漂移均不覆盖',async()=>{
 for(const mode of['prepend','memory-edit','daily-edit','apply-cas'] as const){const f=await fixture();try{
  const frozen=entries(50),daily=renderGroupDailyEntries(frozen),head:[string,string]=['2026-11-19','新的日记头部'];await f.write(daily)
  if(mode==='prepend')f.onResponse(async()=>{await writeFile(f.dailyPath,renderGroupDailyEntries([head,...frozen]))})
  if(mode==='memory-edit')f.onResponse(async()=>{await writeFile(f.memoryPath,'管理员维护的新主档')})
  if(mode==='daily-edit')f.onResponse(async()=>{await writeFile(f.dailyPath,daily.replace('合成owner事件49','已编辑的旧记录'))})
  if(mode==='memory-edit'||mode==='daily-edit')await assert.rejects(prepareImOwnerDailyPlan({...f,entries:frozen}),ImOwnerDailyCompactionError)
  else{const result=await prepareImOwnerDailyPlan({...f,entries:frozen})
   if(mode==='apply-cas'){await writeFile(f.memoryPath,'准备计划之后的维护');await assert.rejects(f.files.apply(f.job,result.plan,f.authorize));assert.equal(await readFile(f.dailyPath,'utf8'),daily)}
   else{await f.files.apply(f.job,result.plan,f.authorize);assert.deepEqual(parseOwnerDailyEntries(await readFile(f.dailyPath,'utf8')),[head])}}
 }finally{await f.close()}}
})
