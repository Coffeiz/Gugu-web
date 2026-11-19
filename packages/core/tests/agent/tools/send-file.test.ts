import {describe,it,expect} from 'vitest'
import {createImSendFileTool,type ImSendFilePort} from '../../../src/agent/tools/send-file.js'
import {createToolRegistry} from '../../../src/agent/tools/registry.js'
const identity={ownerId:'synthetic-owner',sessionId:'1',runId:'synthetic-run'}
const signal=new AbortController().signal
describe('IM发送文件最小已授权来源',()=>{
 it('成员Schema不宣称owner文件库ID，严格拒绝URL/逻辑路径/多来源',()=>{
  const tool=createImSendFileTool({allowFileId:false,async send(){throw Error('不应发送')},async recover(){return 'unknown'}})
  const wire=tool.definition.schema as {function:{parameters:{properties:Record<string,unknown>}}}
  expect(wire.function.parameters.properties).not.toHaveProperty('file_id')
  for(const input of [{file_id:1},{url:'https://example.test/a'},{file:'/workspace/a'},{attach_id:'a',file_id:1},{attach_id:''}])expect(tool.validate(input).success).toBe(false)
 })
 it('实际注册器传可信Run/调用坐标；accepted不再产生第二份final附件',async()=>{
  const calls:unknown[]=[]
  const port:ImSendFilePort={allowFileId:true,async send(input){calls.push(input);return 'sent'},async recover(){return 'sent'}}
  const registry=createToolRegistry({authorize:async()=>true,tools:[createImSendFileTool(port)]})
  const result=await registry.tools.dispatch({id:'call',name:'send_file',input:{file_id:7}},{identity,roundId:'round',signal,resolution:null,execute:async()=>{throw Error('不能执行Shell')}})
  expect(calls).toEqual([{identity,roundId:'round',toolCallId:'call',fileId:7,signal}])
  expect(result).toMatchObject({kind:'completed',successful:true,mutated:true,value:{delivery_status:'sent'}})
  expect(result).not.toHaveProperty('artifact')
 })
 it('未知外部结果保持unknown；reconcile只读收据，不调用发送',async()=>{
  let sent=0,recovered=0
  const tool=createImSendFileTool({allowFileId:false,async send(){sent++;return 'unknown'},async recover(){recovered++;return 'sent'}})
  const scope={identity,roundId:'round',signal,resolution:null,execute:async()=>{throw Error('不能执行Shell')}}
  expect(await tool.execute({attach_id:'a'},scope,{id:'call',name:'send_file',input:{attach_id:'a'}})).toEqual({kind:'unknown'})
  expect(await tool.reconcile!({attach_id:'a'},{...identity,roundId:'round'},{id:'call',name:'send_file',input:{attach_id:'a'}})).toMatchObject({successful:true})
  expect([sent,recovered]).toEqual([1,1])
 })
 it('取消发生在发送前不调用平台，owner仍需精确单来源',async()=>{
  const tool=createImSendFileTool({allowFileId:true,async send(){throw Error('不应发送')},async recover(){return 'unknown'}})
  expect(tool.validate({file_id:1,attach_id:'a'}).success).toBe(false)
  await expect(tool.execute({file_id:1},{identity,roundId:'round',signal:AbortSignal.abort(),resolution:null,execute:async()=>{throw Error('不执行')}},{id:'call',name:'send_file',input:{file_id:1}})).rejects.toThrow()
 })
})
