import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMcpServerName, validateMcpEndpoint, validateMcpCommon, normalizeMcpSlots, validateMcpCredentialValues } from '../../../../packages/core/src/mcp/server-config.js'
import {isPublicAddress} from '../../../../packages/core/src/agent/providers/transport/network.js'

test('MCP 凭据槽位校验与写入前的 Header 安全边界', () => {
 const slots=normalizeMcpSlots([{id:'key',label:'密钥',target:'header',name:'Authorization',prefix:'Bearer '},{id:'tenant',target:'query',parameter_name:'tenant'}])
 assert.deepEqual(slots[1],{id:'tenant',label:'tenant',target:'query',name:'tenant',prefix:''})
 assert.deepEqual(validateMcpCredentialValues(slots,{key:'synthetic',tenant:'示例'}),{key:'synthetic',tenant:'示例'})
 for (const value of ['含中文','bad\nvalue']) assert.throws(()=>validateMcpCredentialValues(slots,{key:value}))
 assert.throws(()=>validateMcpCredentialValues(slots,{other:'secret'}))
 assert.throws(()=>normalizeMcpSlots([{id:'key',target:'header',name:'Bad Header'}]))
 assert.throws(()=>normalizeMcpSlots([{id:'key',target:'query',name:'a'},{id:'key',target:'query',name:'b'}]))
})

test('MCP server 配置沿用 Python 名称、endpoint 和通用字段边界',()=>{
 assert.equal(normalizeMcpServerName('  高德-天气  '),'高德-天气')
 for(const name of ['', 'bad name!', 'x'.repeat(65)]) assert.throws(()=>normalizeMcpServerName(name))
 assert.equal(validateMcpEndpoint(' https://mcp.example.com/rpc ',isPublicAddress),'https://mcp.example.com/rpc')
 for(const endpoint of ['ftp://mcp.example.com','https:///path','http://user:pass@mcp.example.com','http://127.0.0.1/rpc','http://[::1]/rpc']) assert.throws(()=>validateMcpEndpoint(endpoint,isPublicAddress))
 assert.equal(validateMcpCommon({confirm_mode:'auto',timeout_seconds:30,tool_allowlist:['search']},64).timeout_seconds,30)
 for(const common of [
  {confirm_mode:'sometimes',timeout_seconds:30,tool_allowlist:[]},
  {confirm_mode:'confirm_all',timeout_seconds:0,tool_allowlist:[]},
  {confirm_mode:'confirm_all',timeout_seconds:301,tool_allowlist:[]},
  {confirm_mode:'confirm_all',timeout_seconds:30,tool_allowlist:['  ']},
  {confirm_mode:'confirm_all',timeout_seconds:30,tool_allowlist:Array.from({length:65},(_,i)=>`t${i}`)},
 ]) assert.throws(()=>validateMcpCommon(common,64))
})
