import assert from 'node:assert/strict'
import test from 'node:test'
import {createMcpRuntime} from '../../src/modules/mcp/runtime.js'

const owner='00000000-0000-4000-8000-000000000071'
const other='00000000-0000-4000-8000-000000000072'
const server='00000000-0000-4000-8000-000000000073'
const row={id:server,name:'高德',scope:'user',transport:'http',endpoint:'',encrypted_endpoint:'cipher-endpoint',endpoint_nonce:'n',encrypted_endpoint_key:'k',endpoint_key_version:1,command:'',credential_slots:[{id:'auth',target:'header',name:'Authorization',prefix:'Bearer '}],encrypted_credentials:'cipher-creds',credentials_nonce:'n',encrypted_credentials_key:'k',credentials_key_version:1,encrypted_headers:'',headers_nonce:'',encrypted_headers_key:'',headers_key_version:1,encrypted_query_params:'',query_params_nonce:'',encrypted_query_params_key:'',query_params_key_version:1,enabled:true,confirm_mode:'confirm_all',timeout_seconds:15,tool_allowlist:['geocode'],created_at:null,updated_at:null}

function fixture(callResponse?:unknown, callError?:unknown, connectError?:unknown){
 let enabled=true,closed=0,transportClosed=0,connects=0,listed=0,calls=0
 let receivedSignal:AbortSignal|undefined
 let currentRow={...row}
 const receivedAuthorization:string[]=[]
 const service=createMcpRuntime({
  configs:async user=>user===owner?[currentRow]:[],enabled:()=>enabled,maxTools:5,builtinNames:async()=>new Set(['builtin_tool']),
  decrypt:{async decrypt(input){return input.ciphertext.startsWith('cipher-endpoint')?`https://mcp.example/${input.ciphertext.slice('cipher-endpoint'.length)||'rpc'}`:JSON.stringify({auth:input.ciphertext==='cipher-creds-v2'?'rotated-synthetic-secret':'synthetic-secret'})}},
  transport:()=>({async request(){throw new Error('must use SDK fetch')},async close(){transportClosed++}} as never),
  client(input){
   receivedAuthorization.push(input.headers.Authorization??'')
   assert.notEqual(input.fetch,globalThis.fetch)
   return {async connect(){connects++;if(connectError)throw connectError},async listTools(){listed++;return {tools:[
    {name:'geocode',description:'地址查询',inputSchema:{type:'object',properties:{address:{type:'string',minLength:2,examples:['private']}},required:['address'],additionalProperties:false}},
    {name:'not_allowed',inputSchema:{type:'object'}},{name:'builtin_tool',inputSchema:{type:'object'}},
   ]}},async callTool(name:string,args:Record<string,unknown>,options?:{signal?:AbortSignal}){calls++;receivedSignal=options?.signal;if(callError)throw callError;return callResponse??{isError:false,content:[{type:'text',text:`called:${name}:${String(args.address)}`}]}},async close(){closed++}}
  },
 })
 return {service,setEnabled(v:boolean){enabled=v},setRow(next:typeof currentRow){currentRow=next},stats:()=>({closed,transportClosed,connects,listed,calls}),receivedAuthorization:()=>receivedAuthorization,receivedSignal:()=>receivedSignal}
}

test('Agent 探测刷新已保存连接，只发现工具，失败分类不返回上游正文',async()=>{
 const signal=new AbortController().signal
 const f=fixture()
 try{
  await assert.rejects(f.service.testConnection(other,server,signal),{statusCode:404})
  await assert.rejects(f.service.testConnection(owner,server,AbortSignal.abort()),{name:'AbortError'})
  assert.equal(f.stats().connects,0)
  await f.service.load(owner,server)
  assert.deepEqual(await f.service.testConnection(owner,server,signal),{ok:true,toolNames:['mcp_gaode_geocode']})
  assert.equal(f.service.state(owner,server).loaded_tool_count,1)
  assert.deepEqual(f.stats(),{connects:2,listed:2,calls:0,closed:1,transportClosed:1})
  f.setRow({...row,enabled:false})
  assert.deepEqual(await f.service.testConnection(owner,server,signal),{ok:false,errorKind:null})
  assert.equal(f.stats().connects,2)
 }finally{await f.service.close()}
 const failed=fixture(undefined,undefined,new Error('401 synthetic-secret'))
 try{
  assert.deepEqual(await failed.service.testConnection(owner,server,signal),{ok:false,errorKind:'auth'})
  assert.equal(failed.service.state(owner,server).last_error,'MCP server 认证失败，请检查凭据')
 }finally{await failed.service.close()}
})

test('MCP runtime 按 owner 和启用状态按需载入，列表只返回实际加载的过滤工具',async()=>{
 const f=fixture()
 await assert.rejects(f.service.tools(other,server),error=>(error as {statusCode?:number}).statusCode===404)
 await assert.rejects(f.service.load(other,server),error=>(error as {statusCode?:number}).statusCode===404)
 assert.equal((await f.service.load(owner,server)).state,'ok')
 assert.deepEqual(await f.service.tools(owner,server),{server_id:server,state:'ok',loaded_tool_count:1,loaded_tool_names:['mcp_gaode_geocode'],last_error:null})
 assert.equal(f.stats().connects,1)
 assert.equal(f.stats().listed,1)
})

test('另一实例轮换凭据后，旧连接关闭并使用最新 owner 配置重连',async()=>{
 const f=fixture()
 assert.equal((await f.service.load(owner,server)).state,'ok')
 assert.deepEqual(f.receivedAuthorization(),['Bearer synthetic-secret'])
 f.setRow({...row,encrypted_credentials:'cipher-creds-v2',credentials_nonce:'new-nonce'})
 assert.equal((await f.service.dispatch(owner,server,'mcp_gaode_geocode',{address:'杭州'})).result,'called:geocode:杭州')
 assert.deepEqual(f.receivedAuthorization(),['Bearer synthetic-secret','Bearer rotated-synthetic-secret'])
 assert.deepEqual(f.stats(),{closed:1,transportClosed:1,connects:2,listed:2,calls:1})
 await f.service.close()
})

test('配置变更期间完成的旧 MCP 握手不会重新写入失效缓存',async()=>{
 let currentRow={...row}
 let releaseConnect!:()=>void
 let markConnecting!:()=>void
 const connecting=new Promise<void>(resolve=>{markConnecting=resolve})
 const gate=new Promise<void>(resolve=>{releaseConnect=resolve})
 let connects=0,closed=0
 const receivedAuthorization:string[]=[]
 const service=createMcpRuntime({
  configs:async user=>user===owner?[currentRow]:[],enabled:()=>true,maxTools:5,builtinNames:async()=>new Set(),
  decrypt:{async decrypt(input){return input.ciphertext.startsWith('cipher-endpoint')?'https://mcp.example/rpc':JSON.stringify({auth:input.ciphertext==='rotated-cipher'?'rotated-synthetic-secret':'synthetic-secret'})}},
  transport:()=>({async request(){throw new Error('unused')},async close(){}} as never),
  client:input=>{receivedAuthorization.push(input.headers.Authorization??'');return {async connect(){connects++;markConnecting();await gate},async listTools(){return {tools:[{name:'lookup',inputSchema:{type:'object'}}]}},async callTool(){return {content:[]}},async close(){closed++}}},
 })
 const pending=service.load(owner,server)
 await connecting
 currentRow={...row,encrypted_credentials:'rotated-cipher'}
 const invalidation=service.invalidate(owner,server)
 const concurrentLoad=service.load(owner,server)
 await Promise.resolve()
 await Promise.resolve()
 releaseConnect()
 await invalidation
 const staleResult=await pending
 assert.notEqual(staleResult.state,'ok')
 assert.equal(closed,1)
 const fresh=await concurrentLoad
 assert.equal(fresh.state,'ok')
 assert.equal(connects,2)
 assert.deepEqual(receivedAuthorization,['Bearer synthetic-secret','Bearer rotated-synthetic-secret'])
 await service.close()
})

test('读取工具状态时发现其他实例已更新配置会关闭旧连接并返回未载入',async()=>{
 const f=fixture()
 assert.equal((await f.service.load(owner,server)).state,'ok')
 f.setRow({...row,encrypted_credentials:'cipher-creds-v2',credentials_nonce:'new-nonce'})
 assert.deepEqual(await f.service.tools(owner,server),{server_id:server,state:'unloaded',loaded_tool_count:0,loaded_tool_names:[],last_error:null})
 assert.deepEqual(f.stats(),{closed:1,transportClosed:1,connects:1,listed:1,calls:0})
 await f.service.close()
})

test('禁用时不外连；重连先关闭旧连接，调用复用当前 owner runtime',async()=>{
 const f=fixture();f.setEnabled(false)
 assert.equal((await f.service.load(owner,server)).state,'disabled')
 assert.equal(f.stats().connects,0)
 f.setEnabled(true)
 assert.equal((await f.service.load(owner,server)).state,'ok')
 assert.equal((await f.service.reconnect(owner,server)).state,'ok')
 await f.service.close()
 assert.equal(f.stats().closed,2)
 assert.equal(f.stats().transportClosed,2)
})

test('单 server 错误不泄露 endpoint 或凭据，stdio 不启动系统进程',async()=>{
 let clientCalls=0
 const f=fixture()
 const service=createMcpRuntime({configs:async()=>[{...row,transport:'stdio'}],enabled:()=>true,maxTools:5,builtinNames:async()=>new Set(),decrypt:{decrypt:async()=>''},transport:()=>{throw new Error('should not create transport')},client:()=>{clientCalls++;throw new Error('should not create client')}})
 const result=await service.load(owner,server)
 assert.equal(result.ok,false)
 assert.equal(result.state,'error')
 assert.equal(clientCalls,0)
 assert.equal(result.error?.includes('synthetic-secret'),false)
 assert.equal(f.stats().connects,0)
})

test('HTTP runtime 首次连接失败后可重试并清除已恢复的错误状态',async()=>{
 let failing=true,attempts=0
 const service=createMcpRuntime({configs:async()=>[{...row,encrypted_endpoint:'',endpoint:'https://mcp.example/rpc',encrypted_credentials:'',credential_slots:[]}],enabled:()=>true,maxTools:5,builtinNames:async()=>new Set(),decrypt:{decrypt:async()=>''},transport:()=>({request:async()=>new Response(),close:async()=>{}} as never),client:()=>({async connect(){attempts++;if(failing)throw new Error('endpoint=https://secret.example token=private')},async listTools(){return {tools:[{name:'lookup',inputSchema:{type:'object'}}]}},async close(){}})})
 const first=await service.load(owner,server)
 assert.equal(first.state,'error')
 assert.doesNotMatch(first.error??'',/secret|private/)
 failing=false
 const recovered=await service.load(owner,server)
 assert.equal(recovered.state,'ok')
 assert.equal(attempts,2)
 await service.close()
})

test('MCP 工具执行只调用当前 owner 已发现的原名工具并投影 Python 兼容文本',async()=>{
 const f=fixture()
 const controller=new AbortController()
 assert.deepEqual(await f.service.dispatch(owner,server,'mcp_gaode_geocode',{address:'杭州'},controller.signal),{result:'called:geocode:杭州'})
 assert.deepEqual(await f.service.dispatch(other,server,'mcp_gaode_geocode',{address:'杭州'},controller.signal),{error:'MCP 工具不可用，请重新加载工具目录'})
 assert.deepEqual(await f.service.dispatch(owner,server,'mcp_gaode_not_allowed',{address:'杭州'},controller.signal),{error:'MCP 工具不可用，请重新加载工具目录'})
 assert.equal(f.stats().calls,1)
 await f.service.close()
})

test('Agent runtime 区分外呼前拒绝和服务端执行错误，HTTP dispatch 不扩展旧响应',async()=>{
 const f=fixture()
 assert.deepEqual(await f.service.dispatchForAgent(other,server,'mcp_gaode_geocode',{address:'杭州'}),{
  error:'MCP 工具不可用，请重新加载工具目录',executed:false,
 })
 assert.equal(f.stats().calls,0)
 assert.deepEqual(await f.service.dispatch(other,server,'mcp_gaode_geocode',{address:'杭州'}),{
  error:'MCP 工具不可用，请重新加载工具目录',
 })

 const failed=fixture({isError:true,content:[{type:'text',text:'服务端执行失败'}]})
 assert.deepEqual(await failed.service.dispatchForAgent(owner,server,'mcp_gaode_geocode',{address:'杭州'}),{
  error:'服务端执行失败',executed:true,
 })
 await f.service.close();await failed.service.close()
})

test('MCP 工具执行将取消信号交给 SDK，并把不可信结果限制在 20000 字符',async()=>{
 const f=fixture({isError:false,content:[{type:'text',text:'x'.repeat(20001)}]})
 const controller=new AbortController()
 const result=await f.service.dispatch(owner,server,'mcp_gaode_geocode',{address:'杭州'},controller.signal)
 assert.equal(result.result,`${'x'.repeat(20000)}\n…（结果过长已截断）`)
 assert.equal(f.receivedSignal(),controller.signal)
 assert.equal(f.stats().calls,1)
 await f.service.close()
})

test('tools/call 已发出后连接失败标记为不确定，不能把潜在副作用作为可重试失败',async()=>{
 const f=fixture(undefined,new Error('synthetic disconnect after request write'))
 assert.deepEqual(await f.service.dispatchForAgent(owner,server,'mcp_gaode_geocode',{address:'杭州'}),{uncertain:true})
 assert.deepEqual(await f.service.dispatch(owner,server,'mcp_gaode_geocode',{address:'杭州'}),{error:'MCP 工具结果不确定，请检查服务端状态后再决定是否重试'})
 assert.equal(f.stats().calls,2)
 await f.service.close()
})

test('MCP tools/call 的服务端错误作为工具错误返回，不暴露连接配置',async()=>{
 const f=fixture({isError:true,content:[{type:'text',text:'工具输入不完整'}]})
 assert.deepEqual(await f.service.dispatch(owner,server,'mcp_gaode_geocode',{address:'杭州'}),{error:'工具输入不完整'})
 assert.equal(f.stats().calls,1)
 await f.service.close()
})

test('MCP 工具调用拒绝非对象参数，不向 server 发起 tools/call',async()=>{
 const f=fixture()
 const agentResult=await f.service.dispatchForAgent(owner,server,'mcp_gaode_geocode',null as never)
 assert.equal('executed' in agentResult && agentResult.executed,false)
 const result=await f.service.dispatch(owner,server,'mcp_gaode_geocode',null as never)
 assert.equal('result' in result, true)
 const payload=JSON.parse((result as {result:string}).result)
 assert.equal(payload.error,'tool_input_invalid')
 assert.equal(payload.issues[0].rule,'type')
 assert.equal(f.stats().calls,0)
 await f.service.close()
})

test('MCP 工具调用按 Python 错误契约拒绝缺失或非法字段，不外呼 tools/call',async()=>{
 const f=fixture()
 const missing=await f.service.dispatch(owner,server,'mcp_gaode_geocode',{})
 const short=await f.service.dispatch(owner,server,'mcp_gaode_geocode',{address:'杭'})
 assert.equal('result' in missing,true)
 assert.equal('result' in short,true)
 assert.equal(JSON.parse((missing as {result:string}).result).error,'tool_input_invalid')
 assert.equal(JSON.parse((missing as {result:string}).result).issues[0].rule,'required')
 assert.equal(JSON.parse((short as {result:string}).result).issues[0].rule,'minLength')
 assert.equal(f.stats().calls,0)
 await f.service.close()
})

test('MCP 参数按 Python 兼容规则归一化后才发送给 server',async()=>{
 const f=fixture()
 assert.deepEqual(await f.service.dispatch(owner,server,'mcp_gaode_geocode',{address:123 as never}),{result:'called:geocode:123'})
 assert.equal(f.stats().calls,1)
 await f.service.close()
})
