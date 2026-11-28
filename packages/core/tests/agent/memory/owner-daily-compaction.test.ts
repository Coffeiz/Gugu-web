import assert from 'node:assert/strict'
import {test} from 'vitest'
import {parseOwnerDailyEntries,prepareOwnerDailyCompactionBatch,ownerDailyDatesPreserved,
 buildOwnerDailyReferenceQuery,renderOwnerDailyEventReferences} from '../../../src/memory/owner-daily-compaction.js'
import {groupDailyDatesPreserved,renderGroupDailyEntries} from '../../../src/memory/im-group-daily-compaction.js'

const daily=(count:number):Array<[string,string]>=>Array.from({length:count},(_,index)=>
 [index<100?'2026-11-19':index<200?'2026-11-18':'2026-11-17',`合成个人经历${index}：保留具体结果。`])

test('owner只解析新严格日期标题与bullet，不把旧迁移格式或宽松群标题放大为事实',()=>{
 assert.deepEqual(parseOwnerDailyEntries('- 2026-11-19 旧格式仅迁移\n## 2026-1-2\n- 非标准日期\n## 非日期长标题\n- 不收录\n'),[])
 assert.deepEqual(parseOwnerDailyEntries('## 2026-11-19\r\n- 合成甲\r\n- \t\r\n正文忽略\r\n##\t2026-11-18\n-\t合成乙\n'),
  [['2026-11-19','合成甲'],['2026-11-18','合成乙']])
 assert.deepEqual(parseOwnerDailyEntries('##\u30002026-11-19\n-\u3000合成正文\u0085- \ufeff保留BOM\n'),
  [['2026-11-19','合成正文'],['2026-11-19','\ufeff保留BOM']])
 assert.throws(()=>parseOwnerDailyEntries(null as never),error=>error instanceof Error&&error.message==='个人每日记忆数据无效或已变更'&&!('cause'in error))
})

test('owner初始49不启动、50整批沉淀，不误用群100阈值',()=>{
 assert.equal(prepareOwnerDailyCompactionBatch(renderGroupDailyEntries(daily(49))),null)
 const expected=daily(50),result=prepareOwnerDailyCompactionBatch(renderGroupDailyEntries(expected))!
 assert.deepEqual(result.batch,expected);assert.deepEqual(result.remainingEntries,[]);assert.equal(result.dailyAfter,'')
})

test('owner初始250按最旧100/100/50清空全部冻结范围，日期与每条正文不丢',()=>{
 const original=daily(250),batches:Array<Array<[string,string]>>=[]
 let result=prepareOwnerDailyCompactionBatch(renderGroupDailyEntries(original))!
 for(;;){batches.push(result.batch);assert.deepEqual(parseOwnerDailyEntries(result.dailyAfter),result.remainingEntries)
  if(!result.remainingEntries.length)break
  result=prepareOwnerDailyCompactionBatch(result.dailyAfter,result.remainingEntries)!
 }
 assert.deepEqual(batches.map(batch=>batch.length),[100,100,50]);assert.deepEqual(batches.toReversed().flat(),original)
 assert.equal(result.dailyAfter,'');assert.equal(prepareOwnerDailyCompactionBatch(result.dailyAfter,result.remainingEntries),null)
})

test('owner恢复保留并发新头部，初始冻结尾部改日期/正文/删除或重排均拒绝覆盖',()=>{
 const original=daily(120),first=prepareOwnerDailyCompactionBatch(renderGroupDailyEntries(original))!
 const head:Array<[string,string]>=[['2026-11-20','并发新增事实']]
 const last=prepareOwnerDailyCompactionBatch(renderGroupDailyEntries([...head,...first.remainingEntries]),first.remainingEntries)!
 assert.deepEqual(last.batch,original.slice(0,20));assert.equal(last.dailyAfter,renderGroupDailyEntries(head))
 assert.equal(prepareOwnerDailyCompactionBatch(renderGroupDailyEntries(daily(100)),[]),null,'新头不纳入已结束的一轮')
 const text=structuredClone(original);text[119]![1]='synthetic-private-body'
 const date=structuredClone(original);date[119]![0]='2026-01-01'
 const reordered=structuredClone(original);[reordered[0],reordered[1]]=[reordered[1]!,reordered[0]!]
 for(const current of[text,date,original.slice(1),original.slice(0,-1),reordered])assert.throws(()=>
  prepareOwnerDailyCompactionBatch(renderGroupDailyEntries(current),original),error=>error instanceof Error&&error.message==='个人每日记忆数据无效或已变更'&&!('cause'in error))
 assert.throws(()=>prepareOwnerDailyCompactionBatch('',[['2026-11-19',7]]as never),/个人每日记忆数据无效或已变更/)
})

test('owner只要求批次任一可靠日期，群需全部；近似日期子串不能冒充同一锚点',()=>{
 const batch:Array<[string,string]>=[['2026-11-19','合成甲'],['2026-11-18','合成乙']]
 assert.equal(ownerDailyDatesPreserved(batch,'2026-11-19 有价值的合成事件'),true)
 assert.equal(groupDailyDatesPreserved(batch,'2026-11-19 有价值的合成事件'),false)
 assert.equal(ownerDailyDatesPreserved(batch,'2026-11-1 不同日期'),false)
 assert.equal(ownerDailyDatesPreserved(batch,'2026-01-01 无关事件'),false)
 assert.equal(ownerDailyDatesPreserved(batch,''),false)
 assert.equal(ownerDailyDatesPreserved([['旧记录','无可靠日期']],''),true)
 assert.equal(ownerDailyDatesPreserved([['旧记录','实际发生于2026-11-19']], '2026-11-19 结果'),true)
})

test('参考查询只取本批日期正文且按2000码点裁剪，不拆代理对',()=>{
 assert.equal(buildOwnerDailyReferenceQuery([['2026-11-19',' 合成经历 '],['2026-11-18','另一经历']]),'- 2026-11-19 合成经历\n- 2026-11-18 另一经历')
 const query=buildOwnerDailyReferenceQuery([['2026-11-19','😀'.repeat(2100)]])
 assert.equal(Array.from(query).length,2000);assert.equal(query.endsWith('😀'),true);assert.ok(!query.endsWith('\ud83d'))
 assert.equal(buildOwnerDailyReferenceQuery([]),'');assert.equal(buildOwnerDailyReferenceQuery([['2026-11-19',' \t ']]),'')
 assert.throws(()=>buildOwnerDailyReferenceQuery([['2026-11-19',{}]]as never),/个人每日记忆数据无效或已变更/)
})

test('历史参考按content_hash去重、最多10条，忽略无正文并明确仅用于去重背景，不暴露内部元数据',()=>{
 const references=[{title:'合成历史甲',text:'历史正文甲',content_hash:'same',scope:'synthetic-private-scope',score:99},
  {title:'重复索引',text:'不同块但同hash不重复',content_hash:'same'},
  {title:'空参考',text:' \t ',content_hash:'empty'},...Array.from({length:15},(_,index)=>({title:`候选${index}`,text:`历史内容${index}`,content_hash:`hash-${index}`}))]
 const rendered=renderOwnerDailyEventReferences(references)
 assert.match(rendered,/^【历史事件参考，仅用于去重和背景核对】/u)
 assert.equal(rendered.split('\n').filter(line=>line.startsWith('## ')).length,10)
 assert.ok(rendered.includes('历史正文甲'));assert.ok(!rendered.includes('同hash不重复'));assert.ok(!rendered.includes('空参考'))
 assert.ok(!rendered.includes('synthetic-private-scope'));assert.ok(!rendered.includes('score'));assert.ok(!rendered.includes('hash-'))
 assert.equal(renderOwnerDailyEventReferences([{text:''},{title:'无正文'},{text:null},null as never]),'（暂无相关历史事件参考）')
 assert.equal(renderOwnerDailyEventReferences([{text:'相同正文'},{text:'相同正文'}]).split('\n').filter(line=>line.startsWith('## ')).length,1)
})

test('历史参考总渲染正文预算6000码点含标题，不拆Unicode，标记与分隔符合Python独立开销',()=>{
 const rendered=renderOwnerDailyEventReferences([{title:'甲',text:'😀'.repeat(7000),content_hash:'large'},{title:'乙',text:'不得超预算'}])
 const prefix='【历史事件参考，仅用于去重和背景核对】\n\n',body=rendered.slice(prefix.length)
 assert.equal(Array.from(body).length,6000);assert.ok(body.endsWith('😀'));assert.ok(!rendered.includes('不得超预算'))
 assert.throws(()=>renderOwnerDailyEventReferences(null as never),error=>error instanceof Error&&error.message==='个人每日记忆数据无效或已变更'&&!('cause'in error))
})
