import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createMcpSettingsReader} from '../../src/modules/mcp/status.js'

test('MCP stdio limits keep Python defaults and hot-read environment/override values',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'gugu-mcp-stdio-settings-'))
 const config=path.join(root,'config.json')
 try{
  await writeFile(config,'{}')
  const read=createMcpSettingsReader(config,{MCP:'{}'})
  assert.deepEqual([
   read().stdio_max_sessions,read().stdio_max_sessions_per_user,read().stdio_idle_seconds,
  ],[8,4,300])
  const overridden=createMcpSettingsReader(config,{MCP__STDIO_MAX_SESSIONS:'6',MCP__STDIO_MAX_SESSIONS_PER_USER:'2',MCP__STDIO_IDLE_SECONDS:'120'})
  assert.deepEqual([
   overridden().stdio_max_sessions,overridden().stdio_max_sessions_per_user,overridden().stdio_idle_seconds,
  ],[6,2,120])
  await writeFile(config,'{"mcp":{"stdio_max_sessions":3,"stdio_max_sessions_per_user":1,"stdio_idle_seconds":60}}')
  assert.deepEqual([
   overridden().stdio_max_sessions,overridden().stdio_max_sessions_per_user,overridden().stdio_idle_seconds,
  ],[3,1,60])
 }finally{await rm(root,{recursive:true,force:true})}
})
