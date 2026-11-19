import assert from 'node:assert/strict'
import { test } from 'vitest'
import { applyOwnerReflectionOutput } from '../../src/agent/memory/owner-reflection.js'

const now=1791000000,date='2026-10-03',nextId=()=> 'abcdef'
test('owner增量删除相似旧条、印证pattern且不把阶段事实沉淀为稳定画像',()=>{
  const result=applyOwnerReflectionOutput({current:{profile:[{text:'喜欢温茶',type:'preference',ts:1}],pattern:[{id:'old',text:'先列计划再执行',kind:'inferred',conf:.6,imp:3,ts:1}],daily:'',summary:{text:'原重心',ts:1}},
    output:{profile_remove:['喜欢温茶'],profile_add:[{text:'喜欢清茶',type:'preference'},{text:'最近在准备展览',type:'note'}],
      pattern_add:[{text:'先列计划再执行',kind:'observed',importance:4}],daily:'展览已提交',summary:'筹备展览'},now,date,nextId})
  assert.deepEqual(result.profile,[{text:'喜欢清茶',type:'preference',ts:now}])
  assert.deepEqual(result.pattern,[{id:'old',text:'先列计划再执行',kind:'observed',conf:.7,imp:4,ts:now}])
  assert.match(String(result.daily),/展览已提交；最近在准备展览/u)
  assert.deepEqual(result.summary,{text:'筹备展览',ts:now})
})
test('owner lens须重复才提拔；summary空值不清空旧记忆，输入不被原地改写',()=>{
  const current={profile:[],pattern:[],lens:{rules:[],candidates:[]}},copy=structuredClone(current)
  const first=applyOwnerReflectionOutput({current,output:{lens_hint:'「随便」→先追问偏好',summary:''},now,date,nextId})
  assert.deepEqual(current,copy);assert.equal(first.summary,undefined)
  const second=applyOwnerReflectionOutput({current:{...current,lens:first.lens!},output:{lens_hint:'「随便」→先追问偏好'},now:now+1,date,nextId})
  assert.deepEqual(second.lens,{rules:[{rule:'「随便」→先追问偏好',confidence:.6,last_seen:now+1,hits:1}],candidates:[]})
})
test('owner新增pattern使用独立ID与真实置信规则，删除不受模型虚假旧ID影响',()=>{
  const result=applyOwnerReflectionOutput({current:{pattern:[{id:'a',text:'先搜索再核对',kind:'observed',conf:.9,imp:3,ts:1}]},
    output:{pattern_remove:['先搜索再核对'],pattern_add:[{text:'偏好先看完整例子',kind:'unsupported',importance:2}]},now,date,nextId})
  assert.deepEqual(result.pattern,[{id:'abcdef',text:'偏好先看完整例子',kind:'inferred',conf:.6,imp:2,ts:now}])
  assert.throws(()=>applyOwnerReflectionOutput({current:{},output:[],now,date,nextId}),/反思记忆增量无效/u)
})
test('lens相似规则复用稳定触发语，不能因整句相似把不同触发误合并',()=>{
  const first=applyOwnerReflectionOutput({current:{lens:{rules:[],candidates:[{rule:'「随便」→先追问偏好',count:1,last_seen:now}]}},
    output:{lens_hint:'「没事」→先追问偏好'},now,date,nextId})
  assert.equal((first.lens as {rules:unknown[]}).rules.length,0)
  const next=applyOwnerReflectionOutput({current:{lens:first.lens!},output:{lens_hint:'「随便」→应先问具体想法'},now:now+1,date,nextId})
  assert.equal((next.lens as {rules:unknown[]}).rules.length,1)
})
