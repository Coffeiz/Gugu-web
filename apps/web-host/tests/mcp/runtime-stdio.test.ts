import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,realpath,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {PassThrough,Writable} from 'node:stream'
import {createMcpRuntime} from '../../src/modules/mcp/runtime.js'
import {createMcpStdioClientFactory,resolveMcpWorkspaceRoot} from '../../src/modules/mcp/stdio-client.js'

const owner='00000000-0000-4000-8000-000000000071'
const server='00000000-0000-4000-8000-000000000073'

test('stdio MCP 经 Host 隔离进程工厂建立官方客户端，发现工具并在失效时回收进程',async()=>{
 let created:unknown[]=[]
 let connected=0,closed=0
 const row={id:server,name:'本地工具',scope:'user',transport:'stdio',endpoint:'',encrypted_endpoint:'',endpoint_nonce:'',encrypted_endpoint_key:'',endpoint_key_version:0,command:'node /opt/mcp/server.js',credential_slots:[],encrypted_credentials:'',credentials_nonce:'',encrypted_credentials_key:'',credentials_key_version:0,encrypted_headers:'',headers_nonce:'',encrypted_headers_key:'',headers_key_version:0,encrypted_query_params:'',query_params_nonce:'',encrypted_query_params_key:'',query_params_key_version:0,enabled:true,confirm_mode:'confirm_all',timeout_seconds:15,tool_allowlist:[],created_at:null,updated_at:null}
 const runtime=createMcpRuntime({
  configs:async user=>user===owner?[row]:[],enabled:()=>true,maxTools:5,builtinNames:async()=>new Set(),
  decrypt:{decrypt:async()=>''},transport:()=>{throw new Error('stdio 不应创建 HTTP transport')},
  async stdioClient(input){created.push(input);return {async connect(){connected++},async listTools(){return {tools:[{name:'lookup',inputSchema:{type:'object'}}]}},async callTool(){return {content:[{type:'text',text:'ok'}]}},async close(){closed++}}},
 })
 try{
  assert.equal((await runtime.load(owner,server)).state,'ok')
  assert.deepEqual(await runtime.tools(owner,server),{server_id:server,state:'ok',loaded_tool_count:1,loaded_tool_names:['mcp_bendigongju_lookup'],last_error:null})
  assert.deepEqual(created,[{owner,command:'node /opt/mcp/server.js',timeoutSeconds:15}])
  assert.equal(connected,1)
  await runtime.invalidate(owner,server)
  assert.equal(closed,1)
 }finally{await runtime.close()}
})

test('官方 MCP Client 通过 MXC 标准流收发 JSON-RPC，工作区解析拒绝符号链接逃逸',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'gugu-mcp-stdio-'))
 const workspacePath=path.join(root,owner,'workspace','default')
 await mkdir(workspacePath,{recursive:true})
 const workspace=await realpath(workspacePath)
 const stdout=new PassThrough(),stderr=new PassThrough()
 let closed=0
 let processClosed!:()=>void
 const processEnded=new Promise<void>(resolve=>{processClosed=resolve})
 const input=new Writable({write(chunk,_encoding,callback){
  try{
   for(const line of String(chunk).split('\n').filter(Boolean)){
    const message=JSON.parse(line) as {id?:number|string;method?:string}
    if(message.id===undefined)continue
    const result=message.method==='initialize'
     ?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
     :message.method==='tools/list'?{tools:[{name:'lookup',inputSchema:{type:'object'}}]}:{}
    stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:message.id,result})}\n`)
   }
   callback()
  }catch(error){callback(error as Error)}
 }})
 const factory=createMcpStdioClientFactory({
  idleSeconds:0.01,maxSessions:2,maxSessionsPerOwner:1,
  resolveWorkspaceRoot:async()=>workspace,
  spawn:async request=>{
   assert.deepEqual(request,{command:'node /opt/mcp/server.js',cwd:workspace,workspaceRoot:workspace})
   return {standardInput:input,standardOutput:stdout,standardError:stderr,async wait(){await processEnded;return {exitCode:0,timedOut:false}},kill(){closed++;input.end();stdout.end();stderr.end();processClosed()},dispose(){}}
  },
 })
 try{
  const client=await factory({owner,command:'node /opt/mcp/server.js',timeoutSeconds:15})
  await client.connect()
  assert.deepEqual((await client.listTools()).tools.map(tool=>(tool as {name:string}).name),['lookup'])
  await assert.rejects(factory({owner,command:'node /opt/mcp/server.js',timeoutSeconds:15}),/会话数已达上限/)
  await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(client.isOpen(),false)
  assert.equal(closed,1)
  assert.equal(await resolveMcpWorkspaceRoot(root,owner),workspace)
  await rm(path.join(root,owner,'workspace'),{recursive:true,force:true})
  await mkdir(path.join(root,'outside','default'),{recursive:true})
  await symlink(path.join(root,'outside'),path.join(root,owner,'workspace'))
  await assert.rejects(resolveMcpWorkspaceRoot(root,owner),/工作区路径无效/)
 }finally{await rm(root,{recursive:true,force:true})}
})
