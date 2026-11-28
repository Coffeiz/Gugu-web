import assert from 'node:assert/strict'
import test from 'node:test'
import {createMcpSkillToolDirectory} from '../../src/modules/mcp/skill-tool-directory.js'

const owner='00000000-0000-4000-8000-000000000061'
const server='00000000-0000-4000-8000-000000000062'

function fixture(){
 const writes:Array<{owner:string;digest:string;tools:unknown[]}>=[]
 const row={id:server,name:'高德',scope:'user',transport:'http',endpoint:'',encrypted_endpoint:'cipher-endpoint',endpoint_nonce:'n',encrypted_endpoint_key:'k',endpoint_key_version:1,command:'',credential_slots:[{id:'auth',target:'header',name:'Authorization',prefix:'Bearer '}],encrypted_credentials:'cipher-creds',credentials_nonce:'n',encrypted_credentials_key:'k',credentials_key_version:1,encrypted_headers:'',headers_nonce:'',encrypted_headers_key:'',headers_key_version:1,encrypted_query_params:'',query_params_nonce:'',encrypted_query_params_key:'',query_params_key_version:1,enabled:true,confirm_mode:'confirm_all',timeout_seconds:15,tool_allowlist:['geocode'],created_at:new Date('2026-01-01T00:00:00Z'),updated_at:'2026-01-01T00:00:00.000000+00:00'}
  let snapshot:{digest:string;tools:readonly never[]}|null=null,enabled=true,listedOwner='',discoveries=0,closed=0,transportClosed=0,shouldFail=false,passedOwner=''
 const create=createMcpSkillToolDirectory({}, {
  configs:async ownerId=>{listedOwner=ownerId;return shouldFail?[row,{...row,id:'00000000-0000-4000-8000-000000000063',name:'故障服务',endpoint:'https://mcp.example/fail',encrypted_endpoint:'',encrypted_credentials:'',credential_slots:[],tool_allowlist:['echo']}]:[row]},
  ports:{read:async()=>snapshot,writeIfCurrent:async(ownerId,digest,tools)=>{writes.push({owner:ownerId,digest,tools:[...tools]});snapshot={digest,tools:[...tools] as never[]}}},
  enabled:()=>enabled,
  maxTools:5,
  builtinNames:async()=>new Set(['builtin_tool']),
  decrypt:{async decrypt(input){return input.ciphertext==='cipher-endpoint'?'https://mcp.example/rpc':JSON.stringify({auth:'synthetic-secret'})}},
  transport:()=>({async request(){throw new Error('不应直接进行网络调用')},async close(){transportClosed++}} as never),
  client(input){
   discoveries++
   assert.match(input.endpoint,/^https:\/\/mcp\.example\//)
   assert.deepEqual(input.headers,input.endpoint.endsWith('/fail')?{}:{Authorization:'Bearer synthetic-secret'})
   assert.notEqual(input.fetch,globalThis.fetch)
   return {
    async connect(){passedOwner=owner},
    async listTools(){
      if(input.endpoint.endsWith('/fail'))throw new Error('private endpoint and token must not escape')
     return {tools:[
      {name:'geocode',description:'查地址\n第二行',inputSchema:{type:'object',properties:{address:{type:'string',examples:['private']}}}},
      {name:'ignored',description:'不在白名单',inputSchema:{type:'object',properties:{}}},
      {name:'bad-schema',description:'bad',inputSchema:{type:'string'}},
      {name:'builtin_tool',description:'collision',inputSchema:{type:'object',properties:{}}},
     ]}
    },
    async close(){closed++},
   }
  },
 })
 return {create,writes,stats:()=>({snapshot,enabled,listedOwner,discoveries,closed,transportClosed,passedOwner}),setEnabled(value:boolean){enabled=value},fail(){shouldFail=true}}
}

test('MCP Skills 目录通过 owner 配置发现，过滤 schema 与白名单后缓存安全声明',async()=>{
 const state=fixture(),tools=await state.create(owner)
 assert.equal(state.stats().listedOwner,owner)
 assert.equal(state.stats().passedOwner,owner)
 assert.deepEqual(tools,[{name:'mcp_gaode_geocode',description_short:'查地址',description:'查地址\n第二行',input_schema:{type:'object',properties:{address:{type:'string'}}},server_id:server,server_name:'高德',tool_name:'geocode'}])
 assert.equal(state.writes.length,1)
 assert.equal(state.stats().closed,1)
 assert.equal(state.stats().transportClosed,1)
 assert.deepEqual(await state.create(owner),tools)
 assert.equal(state.stats().discoveries,1)
})

test('MCP 关闭时不发现；单个连接失败保留健康服务结果且不写入不完整快照',async()=>{
 const state=fixture();state.setEnabled(false)
 assert.deepEqual(await state.create(owner),[])
 assert.equal(state.stats().discoveries,0)
 state.setEnabled(true);state.fail()
 const tools=await state.create(owner)
 assert.deepEqual(tools.map(tool=>tool.name),['mcp_gaode_geocode'])
 assert.equal(state.writes.length,0)
 assert.equal(state.stats().closed,2)
 assert.equal(state.stats().transportClosed,2)
})

test('MCP 目录读取传入的 owner 标识以供 Core 快照隔离',async()=>{
 let readOwner=''
 const other='00000000-0000-4000-8000-000000000099'
 const create=createMcpSkillToolDirectory({}, {
  configs:async()=>[],ports:{read:async ownerId=>{readOwner=ownerId;return null},writeIfCurrent:async()=>{}},
  enabled:()=>true,maxTools:1,romanize:value=>value,builtinNames:async()=>new Set(),decrypt:{decrypt:async()=>''},
  transport:()=>({request:async()=>{throw new Error()},close:async()=>{}} as never),client:()=>{throw new Error('no config should be discovered')},
 })
 await create(other)
 assert.equal(readOwner,other)
})

test('MCP Skills 发现拒绝查询参数凭据且不创建出站连接',async()=>{
 let clients=0,transports=0,writes=0
 const row={id:server,name:'高德',scope:'user',transport:'http',endpoint:'https://mcp.example/rpc',encrypted_endpoint:'',endpoint_nonce:'',encrypted_endpoint_key:'',endpoint_key_version:1,command:'',credential_slots:[{id:'api',target:'query',name:'key'}],encrypted_credentials:'cipher',credentials_nonce:'n',encrypted_credentials_key:'k',credentials_key_version:1,encrypted_headers:'',headers_nonce:'',encrypted_headers_key:'',headers_key_version:1,encrypted_query_params:'',query_params_nonce:'',encrypted_query_params_key:'',query_params_key_version:1,enabled:true,confirm_mode:'confirm_all',timeout_seconds:15,tool_allowlist:[],created_at:null,updated_at:null}
 const create=createMcpSkillToolDirectory({}, {
  configs:async()=>[row],ports:{read:async()=>null,writeIfCurrent:async()=>{writes++}},enabled:()=>true,maxTools:5,romanize:value=>value,
  builtinNames:async()=>new Set(),decrypt:{decrypt:async()=>JSON.stringify({api:'synthetic-secret'})},
  transport:()=>{transports++;return {request:async()=>{throw new Error('must not request')},close:async()=>{}} as never},
  client:()=>{clients++;throw new Error('must not create client')},
 })
 assert.deepEqual(await create(owner),[])
 assert.equal(clients,0)
 assert.equal(transports,0)
 assert.equal(writes,0)
})
