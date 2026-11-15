import assert from 'node:assert/strict'
import test from 'node:test'
import {createPostgresMcpConnectionTester} from '../../src/modules/mcp/test-connection.js'

const owner='00000000-0000-4000-8000-000000000001',server='00000000-0000-4000-8000-000000000002'
function database(row:Record<string,unknown>|undefined,whereCalls:string[][]){
 return {selectFrom:(table:string)=>{assert.equal(table,'user_mcp_servers');return {select:()=>({where:(column:string,_op:string,value:string)=>{whereCalls.push([column,value]);return {where:(column2:string,_op2:string,value2:string)=>{whereCalls.push([column2,value2]);return {where:(column3:string,_op3:string,value3:string)=>{whereCalls.push([column3,value3]);return {executeTakeFirst:async()=>row}}}}}}})}}}
}
const row={id:server,name:'weather',transport:'http',endpoint:'',encrypted_endpoint:'cipher-endpoint',endpoint_nonce:'n',encrypted_endpoint_key:'k',endpoint_key_version:1,command:'',credential_slots:[{id:'api',target:'header',name:'Authorization',prefix:'Bearer '}],encrypted_credentials:'cipher-creds',credentials_nonce:'n',encrypted_credentials_key:'k',credentials_key_version:1,encrypted_headers:'',headers_nonce:'',encrypted_headers_key:'',headers_key_version:1,encrypted_query_params:'',query_params_nonce:'',encrypted_query_params_key:'',query_params_key_version:1,tool_allowlist:['echo'],timeout_seconds:12}

test('PG MCP 探测按 owner 读取并只向受控 HTTP client 传 Header 密文解包结果',async()=>{
 const whereCalls:string[][]=[],clientCalls:unknown[]=[],closed:string[]=[]
 const testConnection=createPostgresMcpConnectionTester(database(row,whereCalls),{
  decrypt:{async decrypt(input){return input.ciphertext==='cipher-endpoint'?'https://mcp.example/rpc':JSON.stringify({api:'secret-value'})}},
  transport:()=>({async request(){throw new Error('探测测试不应直接发出网络请求')},async close(){closed.push('transport')}}),
  maxTools:8,
  client(input){clientCalls.push(input);return {async connect(){},async listTools(){return {tools:[{name:'echo',inputSchema:{type:'object'}},{name:'private',inputSchema:{type:'object'}}]}},async close(){closed.push('client')}} as never},
 })
 const result=await testConnection(owner,server)
 assert.deepEqual(whereCalls,[['id',server],['user_id',owner],['scope','user']])
 assert.deepEqual(result,{ok:true,tool_count:1,tools:['echo']})
 const clientOptions=clientCalls[0] as {endpoint:string;headers:Record<string,string>}
 assert.equal(clientOptions.endpoint,'https://mcp.example/rpc')
 assert.deepEqual(clientOptions.headers,{Authorization:'Bearer secret-value'})
 assert.deepEqual(closed,['client','transport'])
})

test('owner 不匹配时不连接外部 MCP server',async()=>{
 const whereCalls:string[][]=[],closed:string[]=[]
 const testConnection=createPostgresMcpConnectionTester(database(undefined,whereCalls),{
  decrypt:{async decrypt(){throw new Error('must not decrypt')}},
  transport:()=>{closed.push('transport');return {async request(){throw new Error('must not request')}}},
  maxTools:8,
 })
 await assert.rejects(testConnection(owner,server),error=> (error as {statusCode?:number}).statusCode===404)
 assert.deepEqual(whereCalls,[['id',server],['user_id',owner],['scope','user']])
 assert.deepEqual(closed,[])
})

test('拒绝查询参数槽位凭据且不把秘密写入可见错误',async()=>{
 const whereCalls:string[][]=[],closed:string[]=[]
 const queryRow={...row,credential_slots:[{id:'api',target:'query',name:'key'}]}
 const testConnection=createPostgresMcpConnectionTester(database(queryRow,whereCalls),{
  decrypt:{async decrypt(input){return input.ciphertext==='cipher-endpoint'?'https://mcp.example/rpc':JSON.stringify({api:'synthetic-secret'})}},
  transport:()=>({async request(){throw new Error('must not request')},async close(){closed.push('transport')}}),maxTools:8,
  client(){throw new Error('must not create client')},
 })
 const result=await testConnection(owner,server)
 assert.equal(result.ok,false)
 if(!result.ok){assert.match(result.error,/不得放入 URL/);assert.equal(result.error.includes('synthetic-secret'),false);assert.equal(result.error_kind,'configuration')}
 assert.deepEqual(closed,[])
})

test('工具数超限时按 Python 约定整体失败并返回空工具列表',async()=>{
 const whereCalls:string[][]=[];let maxTools=8
 const testConnection=createPostgresMcpConnectionTester(database(row,whereCalls),{
  decrypt:{async decrypt(input){return input.ciphertext==='cipher-endpoint'?'https://mcp.example/rpc':JSON.stringify({api:'synthetic-secret'})}},
  transport:()=>({async request(){throw new Error('not used')}}),maxTools:()=>maxTools,
  client(){return {async connect(){},async listTools(){return {tools:[{name:'echo',inputSchema:{type:'object'}}]}},async close(){}} as never},
 })
 maxTools=0
 const result=await testConnection(owner,server)
 assert.equal(result.ok,false)
 if(!result.ok){assert.equal(result.error_kind,'limit');assert.match(result.error,/超出单个 server 上限/);assert.deepEqual(result.tools,[])}
})

test('缺少已配置的凭据槽位值时不尝试连接外部服务',async()=>{
 const whereCalls:string[][]=[],closed:string[]=[]
 const testConnection=createPostgresMcpConnectionTester(database({...row,encrypted_credentials:''},whereCalls),{
  decrypt:{async decrypt(){return 'https://mcp.example/rpc'}},
  transport:()=>{closed.push('transport');return {async request(){throw new Error('must not request')}}},maxTools:8,
  client(){throw new Error('must not create client')},
 })
 const result=await testConnection(owner,server)
 assert.equal(result.ok,false)
 if(!result.ok){assert.equal(result.error_kind,'configuration');assert.match(result.error,/缺少凭据值/)}
 assert.deepEqual(closed,[])
})
