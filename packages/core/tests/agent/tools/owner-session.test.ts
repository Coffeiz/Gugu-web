import {describe,it,expect} from 'vitest'
import {createImOwnerSessionBindTool,type ImOwnerSessionBindInput} from '../../../src/agent/tools/conversations.js'
import {createToolRegistry} from '../../../src/agent/tools/registry.js'
import {imCanUseTool} from '../../../src/agent/scenes/im/index.js'
const identity={ownerId:'synthetic-owner',sessionId:'1',runId:'synthetic-run'},signal=new AbortController().signal
describe('owner私聊显式绑定网页会话',()=>{
 it('参数只包含正整数目标会话，拒绝模型指定owner/平台和多余权限字段',()=>{
  const tool=createImOwnerSessionBindTool({async bind(){return 'bound'},async recover(){return 'unknown'}})
  for(const input of [{session_id:0},{session_id:-1},{session_id:2147483648},{session_id:'3'},{session_id:3,ownerId:'other'},{session_id:3,platform:'qq'}])expect(tool.validate(input).success).toBe(false)
  expect(tool.validate({session_id:3}).success).toBe(true)
 })
 it('注册器传递可信Run/round/call，明确拒绝不伪造成功；unknown恢复只读收据',async()=>{
  const calls:ImOwnerSessionBindInput[]=[],recoveries:ImOwnerSessionBindInput[]=[]
  let state:'bound'|'denied'|'unknown'='bound'
  const tool=createImOwnerSessionBindTool({async bind(input){calls.push(input);return state},async recover(input){recoveries.push(input);return 'bound'}})
  const registry=createToolRegistry({authorize:async()=>true,tools:[tool]}),scope={identity,roundId:'round',signal,resolution:null,execute:async()=>{throw Error('不执行Shell')}}
  const call={id:'call',name:'bind_web_session',input:{session_id:3}}
  expect(await registry.tools.dispatch(call,scope)).toMatchObject({kind:'completed',successful:true,mutated:true,value:{bound:true,session_id:3}})
  expect(calls).toEqual([{identity,roundId:'round',toolCallId:'call',sessionId:3}])
  state='denied';expect(await tool.execute(call.input,scope,call)).toMatchObject({successful:false,mutated:false})
  state='unknown';expect(await tool.execute(call.input,scope,call)).toEqual({kind:'unknown'})
  expect(await tool.reconcile!(call.input,{...identity,roundId:'round'},call)).toMatchObject({successful:true})
  expect(recoveries).toMatchObject([{identity,roundId:'round',toolCallId:'call',sessionId:3}])
 })
 it('即使白名单包含工具，群聊和未验证身份仍拒绝，取消不执行端口',async()=>{
  for(const platform of ['qq','telegram','feishu','wechat'] as const)
   for(const role of ['owner','member','unknown'] as const)
    for(const chatType of ['c2c','group'] as const){
     const verifiedOwner=role==='owner'
     expect(imCanUseTool({platform,role,chatType,verifiedOwner,allowedToolNames:['bind_web_session']},'bind_web_session')).toBe(verifiedOwner&&chatType==='c2c')
    }
  const tool=createImOwnerSessionBindTool({async bind(){throw Error('取消后不调用')},async recover(){return 'unknown'}})
  await expect(tool.execute({session_id:3},{identity,roundId:'round',signal:AbortSignal.abort(),resolution:null,execute:async()=>{throw Error('不执行')}},{id:'call',name:'bind_web_session',input:{session_id:3}})).rejects.toThrow()
 })
})
