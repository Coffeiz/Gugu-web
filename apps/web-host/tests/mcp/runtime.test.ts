import assert from 'node:assert/strict'
import test from 'node:test'
import {createMcpRuntime} from '../../src/modules/mcp/runtime.js'

const owner='00000000-0000-4000-8000-000000000071'
const other='00000000-0000-4000-8000-000000000072'
const server='00000000-0000-4000-8000-000000000073'
const row={id:server,name:'高德',scope:'user',transport:'http',endpoint:'',encrypted_endpoint:'cipher-endpoint',endpoint_nonce:'n',encrypted_endpoint_key:'k',endpoint_key_version:1,command:'',credential_slots:[{id:'auth',target:'header',name:'Authorization',prefix:'Bearer '}],encrypted_credentials:'cipher-creds',credentials_nonce:'n',encrypted_credentials_key:'k',credentials_key_version:1,encrypted_headers:'',headers_nonce:'',encrypted_headers_key:'',headers_key_version:1,encrypted_query_params:'',query_params_nonce:'',encrypted_query_params_key:'',query_params_key_version:1,enabled:true,confirm_mode:'confirm_all',timeout_seconds:15,tool_allowlist:['geocode'],created_at:null,updated_at:null}

function fixture(){
 let enabled=true,closed=0,transportClosed=0,connects=0,listed=0
 const service=createMcpRuntime({
  configs:async user=>user===owner?[row]:[],enabled:()=>enabled,maxTools:5,builtinNames:async()=>new Set(['builtin_tool']),
  decrypt:{async decrypt(input){return input.ciphertext==='cipher-endpoint'?'https://mcp.example/rpc':JSON.stringify({auth:'synthetic-secret'})}},
  transport:()=>({async request(){throw new Error('must use SDK fetch')},async close(){transportClosed++}} as never),
  client(input){
   assert.equal(input.headers.Authorization,'Bearer synthetic-secret')
   assert.notEqual(input.fetch,globalThis.fetch)
   return {async connect(){connects++},async listTools(){listed++;return {tools:[
    {name:'geocode',description:'地址查询',inputSchema:{type:'object',properties:{address:{type:'string',examples:['private']}}}},
    {name:'not_allowed',inputSchema:{type:'object'}},{name:'builtin_tool',inputSchema:{type:'object'}},
   ]}},async close(){closed++}}
  },
 })
 return {service,setEnabled(v:boolean){enabled=v},stats:()=>({closed,transportClosed,connects,listed})}
}

test('MCP runtime 按 owner 和启用状态按需载入，列表只返回实际加载的过滤工具',async()=>{
 const f=fixture()
 await assert.rejects(f.service.tools(other,server),error=>(error as {statusCode?:number}).statusCode===404)
 await assert.rejects(f.service.load(other,server),error=>(error as {statusCode?:number}).statusCode===404)
 assert.equal((await f.service.load(owner,server)).state,'ok')
 assert.deepEqual(await f.service.tools(owner,server),{server_id:server,state:'ok',loaded_tool_count:1,loaded_tool_names:['mcp_gaode_geocode'],last_error:null})
 assert.equal(f.stats().connects,1)
 assert.equal(f.stats().listed,1)
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
