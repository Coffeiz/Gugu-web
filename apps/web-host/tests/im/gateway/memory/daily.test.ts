import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {test} from 'node:test'
import {stableJson} from '@gugu/core/agent'
import {ProviderRuntime,type ProviderHttpRequest} from '@gugu/core/providers'
import {parseGroupDailyEntries,renderGroupDailyEntries} from '@gugu/core/im-group-daily-compaction'
import {prepareImGroupDailyPlan,ImGroupDailyCompactionError} from '../../../../src/modules/im/gateway/memory/daily.js'
import {createImReflectionFiles,reflectionFileKey} from '../../../../src/modules/im/gateway/memory/files.js'
import type {ImReflectionJob,ImReflectionRuntime} from '../../../../src/modules/im/gateway/memory/contracts.js'
import {context} from '../run-sender.fixtures.js'

const entries=(count:number):[string,string][]=>Array.from({length:count},(_,n)=>[`2026-11-${String(18-Math.floor(n/40)).padStart(2,'0')}`,`合成群事件${n}`])
const output='## 合成群事件\n2026-11-18 茶会\n2026-11-17 排练\n2026-11-16 展览\n\n## 合成群事件\n2026-11-18 茶会\n2026-11-17 排练\n2026-11-16 展览'
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'gugu-reflection-daily-')),source=context()
 const job:ImReflectionJob={id:randomUUID(),identity:source.identity,actor:{...source.actor,chatType:'group',chatId:'synthetic-daily-group'},scope:{type:'group',id:'synthetic-daily-group'},
  messageIds:['31'],modelIdentity:'synthetic-daily-model',accessScopeHash:'synthetic-daily-access',contextWindow:32000,ownerMessage:'',assistantEvidence:'',hadTools:false}
 const files=createImReflectionFiles(root),requests:ProviderHttpRequest[]=[],memoryPath=join(root,reflectionFileKey(job,'memory')),dailyPath=join(root,reflectionFileKey(job,'daily'))
 let providerOutput:unknown={memory:output},status=200,allowed=true,assertions=0,beforeResponse:(()=>Promise<void>)|null=null
 const provider=new ProviderRuntime({digest:value=>createHash('sha256').update(stableJson(value)).digest('hex'),nextId:randomUUID,
  references:{dehydrate:async entry=>entry.message,hydrate:async entry=>entry.message},prepareRequest:async()=>assert.fail('独立沉淀不得准备主对话请求'),
  async resolve(){return{modelIdentity:job.modelIdentity,accessScopeHash:job.accessScopeHash,config:{provider:'openai',model:'synthetic',api_format:'openai',api_key:'synthetic-daily-key',base_url:'https://provider.example.test/v1',context_window:32000},systemPrompt:'合成主对话私有系统'}},
  transport:{async request(request){requests.push(request);await beforeResponse?.();const value=status===200?{choices:[{message:{content:JSON.stringify(providerOutput)},finish_reason:'stop'}],usage:{prompt_tokens:9,completion_tokens:4}}:{error:{message:'synthetic-private-provider-body'}}
   return{status,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify(value))})(),cancel(){}}}}
 })
 const runtime:ImReflectionRuntime={provider,selection:{modelIdentity:job.modelIdentity,accessScopeHash:job.accessScopeHash,contextWindow:32000},
  usageConfig:{defaultLimit6h:null,byokEnabled:false,localDeployment:true,model:'synthetic',provider:'openai',isByok:false},release:()=>provider.close()}
 async function write(memory:string,daily:string){await mkdir(dirname(memoryPath),{recursive:true});await writeFile(memoryPath,memory);await writeFile(dailyPath,daily)}
 const prompt=await readFile(new URL('../../../../../../backend/agent/prompts/im/group_compress.md',import.meta.url),'utf8')
 const authorize=async()=>{assertions++;if(!allowed)throw Error('synthetic-private-authorization')}
 return{job,files,runtime,requests,memoryPath,dailyPath,prompt,authorize,write,setOutput(value:unknown){providerOutput=value},setStatus(value:number){status=value},setAllowed(value:boolean){allowed=value},
  onResponse(value:()=>Promise<void>){beforeResponse=value},assertions:()=>assertions,async close(){await provider.close();await rm(root,{recursive:true,force:true})}}
}

test('真实ProviderRuntime独立group compaction→实际FS两文件CAS计划，保留新头/日期、去重、用量与剩余范围',async()=>{
 const f=await fixture();try{
  const frozen=entries(120),head:[string,string]=['2026-11-19','合成新增头部'];await f.write('已有合成长期记忆\n',renderGroupDailyEntries([head,...frozen]))
  const result=await prepareImGroupDailyPlan({...f,entries:frozen})
  assert.equal(f.requests.length,1);const body=f.requests[0]!.body as Record<string,unknown>,wire=JSON.stringify(body)
  assert.notEqual(body.stream,true,'独立分支必须使用非流式请求；OpenAI省略stream与false同义')
  assert.equal(body.max_tokens??body.max_completion_tokens,15000)
  assert.doesNotMatch(wire,/合成主对话私有系统/);assert.match(wire,/已有合成长期记忆/)
  assert.equal((body.messages as {role:string}[]).length,2,'无主对话history，只包含实际system与独立delta')
  const system=(body.messages as {role:string;content:string|{type:string;text:string}[]}[])[0]!
  assert.equal(system.role,'system')
  if(Array.isArray(system.content))assert.ok(system.content.every(block=>block.type==='text'))
  assert.equal(typeof system.content==='string'?system.content:system.content.map(block=>block.text).join(''),f.prompt)
  assert.ok(!Array.isArray(body.tools)||body.tools.length===0)
  assert.equal(result.remainingEntries.length,20);assert.equal(result.plan.dailyRemainingEntries.length,20)
  assert.deepEqual(result.plan.files.map(file=>file.key).sort(),[reflectionFileKey(f.job,'memory'),reflectionFileKey(f.job,'daily')].sort())
  assert.equal((result.usage as {input:number}).input,9);assert.equal((result.usage as {output:number}).output,4)
  assert.ok(f.assertions()>=4);assert.equal(await readFile(f.memoryPath,'utf8'),'已有合成长期记忆\n','prepare不写文件')
  await f.files.apply(f.job,result.plan,f.authorize);await f.files.apply(f.job,result.plan,f.authorize)
  const memory=await readFile(f.memoryPath,'utf8');assert.equal((memory.match(/## 记录长期记忆：合成群事件/gu)??[]).length,1)
  for(const date of['2026-11-18','2026-11-17','2026-11-16'])assert.equal((memory.match(new RegExp(date,'gu'))??[]).length,1)
  assert.deepEqual(parseGroupDailyEntries(await readFile(f.dailyPath,'utf8')),[head,...frozen.slice(0,20)])
 }finally{await f.close()}
})

test('空输出/丢日期/Provider拒绝/当前撤权均固定失败，不生成可应用计划也不写文件',async()=>{
 for(const mode of['empty','missing-date','provider','revoked-before','revoked-after'] as const){const f=await fixture();try{
  const frozen=entries(100),daily=renderGroupDailyEntries(frozen);await f.write('旧长期记忆\n',daily)
  if(mode==='empty')f.setOutput({memory:''});if(mode==='missing-date')f.setOutput({memory:'## 群事件\n2026-11-18 缺少其他日期'})
  if(mode==='provider')f.setStatus(400);if(mode==='revoked-before')f.setAllowed(false)
  if(mode==='revoked-after')f.onResponse(async()=>{f.setAllowed(false)})
  await assert.rejects(prepareImGroupDailyPlan({...f,entries:frozen}),error=>error instanceof ImGroupDailyCompactionError&&!String(error).includes('synthetic-private')&&!('cause'in error))
  assert.equal(f.requests.length,mode==='revoked-before'?0:1);assert.equal(await readFile(f.memoryPath,'utf8'),'旧长期记忆\n');assert.equal(await readFile(f.dailyPath,'utf8'),daily)
 }finally{await f.close()}}
})

test('Provider期间新daily头部可保留，旧范围编辑/长期记忆变化拒绝，apply时hash漂移不覆盖',async()=>{
 for(const mode of['prepend','edit-daily','edit-memory','apply-cas'] as const){const f=await fixture();try{
  const frozen=entries(120),daily=renderGroupDailyEntries(frozen);await f.write('旧长期记忆\n',daily)
  const head:[string,string]=['2026-11-19','Provider期间的新头部']
  if(mode==='prepend')f.onResponse(async()=>{await writeFile(f.dailyPath,renderGroupDailyEntries([head,...frozen]))})
  if(mode==='edit-daily')f.onResponse(async()=>{await writeFile(f.dailyPath,daily.replace('合成群事件119','合成已编辑事件'))})
  if(mode==='edit-memory')f.onResponse(async()=>{await writeFile(f.memoryPath,'合成管理员修改\n')})
  if(mode==='edit-daily'||mode==='edit-memory')await assert.rejects(prepareImGroupDailyPlan({...f,entries:frozen}),ImGroupDailyCompactionError)
  else{const result=await prepareImGroupDailyPlan({...f,entries:frozen})
   if(mode==='apply-cas'){await writeFile(f.memoryPath,'计划之后的真实修改\n');await assert.rejects(f.files.apply(f.job,result.plan,f.authorize));assert.equal(await readFile(f.dailyPath,'utf8'),daily)}
   else{await f.files.apply(f.job,result.plan,f.authorize);assert.deepEqual(parseGroupDailyEntries(await readFile(f.dailyPath,'utf8')),[head,...frozen.slice(0,20)])}}
 }finally{await f.close()}}
})

test('只允许group生成memory/daily计划，复读到计划间的修改也必须拒绝',async()=>{
 const f=await fixture();try{
  await f.write('旧记忆\n','## 2026-11-18\n- 事件\n')
  await assert.rejects(f.files.planGroupDaily({...f.job,scope:{type:'owner',id:f.job.identity.sessionId}},'不应写',''),/反思记忆文件暂不可用/)
  const before=await f.files.read(f.job);await writeFile(f.dailyPath,'并发写入的新daily\n')
  await assert.rejects(f.files.planGroupDaily(f.job,'不应写','',{memory:before.raw.memory??null,daily:before.raw.daily??null}),/反思记忆文件暂不可用/)
  assert.equal(await readFile(f.memoryPath,'utf8'),'旧记忆\n')
 }finally{await f.close()}
})
