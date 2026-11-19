import assert from 'node:assert/strict'
import {test} from 'vitest'
import type {Json} from '../../../src/agent/models.js'
import {ownerPeriodicDue,ownerPeriodicAttemptState,ownerPeriodicSuccessState,normalizeOwnerPeriodicItems,checkOwnerPeriodicOutput} from '../../../src/memory/owner-periodic.js'

const week=7*86400,now=2_000_000_000
const source:Json[]=[{id:'p1',text:'合成来源一'},{id:'p2',text:'合成来源二'},{id:'p3',text:'合成来源三'},{id:'p4',text:'合成来源四'},{id:'p5',text:'合成来源五'}]
const pattern=(id='p1',extra:Record<string,Json>={})=>({id,text:`合成整理${id}`,kind:'observed',...extra})

test('两字段99/100、整理后水位+30、七天冷却和一小时失败重试各自精确生效',()=>{
 for(const field of ['profile','pattern']as const){
  assert.equal(ownerPeriodicDue(field,99,{},now),false);assert.equal(ownerPeriodicDue(field,100,{},now),true)
  const success=ownerPeriodicSuccessState(field,{},now,70)
  assert.equal(ownerPeriodicDue(field,100,success,now+week-1),false)
  assert.equal(ownerPeriodicDue(field,100,success,now+week),true)
  const larger=ownerPeriodicSuccessState(field,{},now,100)
  assert.equal(ownerPeriodicDue(field,129,larger,now+week),false);assert.equal(ownerPeriodicDue(field,130,larger,now+week),true)
  const failed=ownerPeriodicAttemptState(field,{},now)
  assert.equal(ownerPeriodicDue(field,100,failed,now+3599),false);assert.equal(ownerPeriodicDue(field,100,failed,now+3600),true)
 }
})

test('attempt只更新对应key、success记录post-count，保另一字段和额外keys且不改原状态',()=>{
 const original={last_review_at:11,reviewed_count:70,pattern_last_attempt_at:12,profile_last_compact_at:13,profile_compacted_count:60,
  profile_last_attempt_at:14,extra:{retained:['合成扩展']}};const saved=structuredClone(original)
 const attempt=ownerPeriodicAttemptState('profile',original,100)
 assert.deepEqual(attempt,{...original,profile_last_attempt_at:100})
 const success=ownerPeriodicSuccessState('pattern',attempt,110,65)
 assert.deepEqual(success,{...attempt,last_review_at:110,reviewed_count:65})
 assert.deepEqual(original,saved);assert.notEqual(success.extra,original.extra)
 assert.equal(ownerPeriodicDue('profile',100,{last_review_at:now,reviewed_count:1000},now),true,'pattern水位不得抑制profile')
 assert.equal(ownerPeriodicDue('pattern',100,{profile_last_compact_at:now,profile_compacted_count:1000},now),true)
 assert.equal(ownerPeriodicDue('pattern',100,{last_review_at:'0',reviewed_count:'0',pattern_last_attempt_at:'0'},now),true)
})

test('损坏状态/非法count/非finite时钟固定错误，不能提前维护或删原列表',()=>{
 for(const work of[()=>ownerPeriodicDue('pattern',100,{pattern_last_attempt_at:null},now),()=>ownerPeriodicDue('profile',100,{profile_compacted_count:'3.2'},now),
  ()=>ownerPeriodicDue('profile',NaN,{},now),()=>ownerPeriodicDue('profile',100,{},Infinity),()=>ownerPeriodicAttemptState('pattern',{},NaN),
  ()=>ownerPeriodicSuccessState('profile',{},now,-1)])assert.throws(work,error=>error instanceof Error&&error.message==='个人记忆维护数据无效'&&!('cause'in error))
})

test('来源profile复刻旧store字符串/type兼容并保ts，pattern仅过滤且不发明来源ID或默认kind',()=>{
 const raw:Json[]=[' \u001c合成旧字符串\u0085 ',{type:' address ',text:' 合成地址 ',ts:12,id:'旧profile-id',conf:.8},
  {type:'unknown',text:'未知类型按note',ts:null},{text:42},{text:{fact:'合成结构'}},null,'  ']
 const saved=structuredClone(raw)
 assert.deepEqual(normalizeOwnerPeriodicItems('profile',raw),[{type:'note',text:'合成旧字符串',ts:null},{type:'address',text:'合成地址',ts:12},
  {type:'note',text:'未知类型按note',ts:null},{type:'note',text:'42',ts:null},{type:'note',text:"{'fact': '合成结构'}",ts:null}])
 const patterns:Json[]=[{id:'p1',text:' 保留来源空白 ',extra:{retained:true}},{text:'无id不在读取时伪造'},'',null,{text:' '}]
 assert.deepEqual(normalizeOwnerPeriodicItems('pattern',patterns),patterns.slice(0,2))
 assert.deepEqual(normalizeOwnerPeriodicItems('pattern',[{id:'p1',text:'合成来源'},{text:123}]),[],'旧store遇truthy非字符串text整次读取失败')
 assert.deepEqual(normalizeOwnerPeriodicItems('profile',{}),[]);assert.deepEqual(raw,saved)
})

test('profile输出默认note/ts、不接受空或超70结果，精准返回结构reason/index且不回显正文',()=>{
 assert.deepEqual(checkOwnerPeriodicOutput('profile',[{text:' 合成画像 '}],source),{items:[{type:'note',text:'合成画像',ts:null}],reason:'',index:null,count:1})
 const cases:Array<[unknown,string,number|null,number|null]>=[
  [null,'profile_result_not_array',null,null],[[],'profile_result_empty',null,0],
  [Array.from({length:71},()=>({text:'合成'})),'profile_count_over_target',null,71],[[null],'profile_item_not_object',0,1],
  [[{text:' '}],'profile_text_missing',0,1],[[{text:'synthetic-private',type:'invalid'}],'profile_type_invalid',0,1],
  [[{text:'合成',type:' preference '}],'profile_type_invalid',0,1],
 ]
 for(const[value,reason,index,count]of cases)assert.deepEqual(checkOwnerPeriodicOutput('profile',value,source),{items:null,reason,index,count})
 for(const type of ['name','address','pronoun','background','preference','note'])assert.equal(checkOwnerPeriodicOutput('profile',[{type,text:'合成',ts:17}],[]).items?.length,1)
})

test('pattern来源ID不能自造或重复，kind只准两值，失败不改源数据且只输出安全校验码',()=>{
 const saved=structuredClone(source)
 const cases:Array<[unknown,string,number|null,number|null]>=[
  [{},'pattern_result_not_array',null,null],[[],'pattern_result_empty',null,0],
  [Array.from({length:71},()=>pattern()),'pattern_count_over_target',null,71],[[null],'pattern_item_not_object',0,1],
  [[{...pattern(),text:''}],'pattern_text_missing',0,1],[[pattern('invented')],'pattern_source_id_invalid',0,1],
  [[pattern(),pattern()],'pattern_source_id_duplicate',1,2],[[{...pattern(),kind:'unknown'}],'pattern_kind_invalid',0,1],
 ]
 for(const[value,reason,index,count]of cases)assert.deepEqual(checkOwnerPeriodicOutput('pattern',value,source),{items:null,reason,index,count})
 assert.deepEqual(source,saved)
})

test('pattern数值按Python有限十进制/Unicode与float转int处理，clip后剔除未知字段',()=>{
 const result=checkOwnerPeriodicOutput('pattern',[pattern('p1',{conf:'1.3',importance:8.9,ts:'1_200.5',secret:'不写入'}),
  pattern('p2',{kind:'inferred',conf:'-2',imp:'-9',ts:null}),pattern('p3',{conf:'０.７',importance:'４',ts:true})],source)
 assert.deepEqual(result.items,[{id:'p1',text:'合成整理p1',kind:'observed',conf:.97,imp:5,ts:1200.5},
  {id:'p3',text:'合成整理p3',kind:'observed',conf:.7,imp:4,ts:1},{id:'p2',text:'合成整理p2',kind:'inferred',conf:0,imp:1,ts:0}])
 assert.equal(checkOwnerPeriodicOutput('pattern',[pattern()],source).items?.[0]&&JSON.stringify(checkOwnerPeriodicOutput('pattern',[pattern()],source).items),
  JSON.stringify([{id:'p1',text:'合成整理p1',kind:'observed',conf:.6,imp:3,ts:0}]))
})

test('非finite及无效数字给固定numeric reason，不把NaN/Infinity写JSON或宽松解析hex/小数字符串importance',()=>{
 for(const key of ['conf','importance','ts'])for(const value of [NaN,Infinity,-Infinity,'NaN','Infinity']){
  const result=checkOwnerPeriodicOutput('pattern',[pattern('p1',{[key]:value})],source)
  assert.deepEqual(result,{items:null,reason:'pattern_numeric_field_invalid',index:0,count:1})
 }
 for(const item of[pattern('p1',{conf:'0x10'}),pattern('p1',{importance:'2.9'}),pattern('p1',{conf:null})])
  assert.equal(checkOwnerPeriodicOutput('pattern',[item],source).reason,'pattern_numeric_field_invalid')
})

test('pattern按observed/conf/importance/ts稳定降序，所有排序相等保原模型次序',()=>{
 const output=[pattern('p1',{kind:'inferred',conf:.97,imp:5,ts:99}),pattern('p2',{conf:.8,imp:2,ts:3}),
  pattern('p3',{conf:.8,imp:3,ts:2}),pattern('p4',{conf:.8,imp:3,ts:4}),pattern('p5',{conf:.8,imp:3,ts:4})]
 const saved=structuredClone(output),result=checkOwnerPeriodicOutput('pattern',output,source)
 assert.deepEqual(result.items?.map(item=>(item as Record<string,Json>).id),['p4','p5','p3','p2','p1']);assert.deepEqual(output,saved)
})
