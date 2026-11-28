import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import type {LightMyRequestResponse} from 'fastify'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../../../src/modules/auth/session/token.js'
import { startServer } from '../../../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test('生产Host读取临时语音预设、保持配置原文并随文件更新刷新',async()=>{
 assert.ok(databaseUrl)
 const root=await mkdtemp(join(tmpdir(),'voice-main-')),path=join(root,'override.json'),secret='synthetic-voice-key'
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  const document={db:{marker:'preserve'},llm_presets:{items:[]},voice_presets:{active_id:'v_one',items:[{id:'v_one',name:'测试语音',provider:'local',model:'synthetic-model',api_format:'openai',api_key:secret}]}}
  await writeFile(path,JSON.stringify(document));const before=await readFile(path,'utf8')
  host=await startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-voice-main-secret',GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  assert.equal((await host.app.inject({url:'/api/v1/admin/agent/voice-presets'})).statusCode,401)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200)
  const headers={authorization:`Bearer ${login.json().access_token}`}
  const response:LightMyRequestResponse=await host.app.inject({url:'/api/v1/admin/agent/voice-presets',headers});assert.equal(response.statusCode,200);assert.equal(response.json().items[0].active,true);assert.equal(response.json().items[0].has_api_key,true);assert.equal(response.body.includes(secret),false);assert.equal(await readFile(path,'utf8'),before)
  document.voice_presets.active_id='';await writeFile(path,JSON.stringify(document))
  const updated=await host.app.inject({url:'/api/v1/admin/agent/voice-presets',headers});assert.equal(updated.json().active_id,'');assert.equal(updated.json().items[0].active,false)
  const base='/api/v1/admin/agent/voice-presets'
  const create=await host.app.inject({method:'POST',url:base,headers,payload:{name:'新增语音',provider:'qwen',model:'qwen3-asr-flash',api_format:'dashscope',base_url:'https://voice.example.test',api_key:'synthetic-write-key'}})
  assert.equal(create.statusCode,200,create.body);const id=create.json().item.id;assert.equal(create.json().active_id,id);assert.equal(create.body.includes('synthetic-write-key'),false)
  const protectedBytes=await readFile(path,'utf8')
  const denied=await host.app.inject({method:'PUT',url:`${base}/${id}`,headers,payload:{base_url:'https://other.example.test',api_key:''}});assert.equal(denied.statusCode,422);assert.equal(await readFile(path,'utf8'),protectedBytes)
  const edit=await host.app.inject({method:'PUT',url:`${base}/${id}`,headers,payload:{model:'fun-asr-flash',api_key:''}});assert.equal(edit.statusCode,200);assert.equal(edit.json().item.dashscope_service,'fun-asr');assert.equal(edit.json().item.has_api_key,true)
  const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
  const consume=(model:string)=>assert.equal(execFileSync(python,[resolve('tests/admin/fixtures/voice_config_consumer.py'),'--allow-isolated-test-config',path,model],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend')},encoding:'utf8'}).trim(),'accepted')
  consume('fun-asr-flash')
  assert.equal((await host.app.inject({method:'POST',url:`${base}/deactivate`,headers})).statusCode,200)
  consume('')
  assert.equal((await host.app.inject({method:'POST',url:`${base}/${id}/activate`,headers})).json().active_id,id)
  assert.equal((await host.app.inject({method:'DELETE',url:`${base}/${id}`,headers})).json().active_id,'')
  const saved=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(saved.db,{marker:'preserve'});assert.equal(saved.voice_presets.items.length,1)
  await writeFile(path,'bad-json-containing-synthetic-key')
  const badWrite=await host.app.inject({method:'POST',url:'/api/v1/admin/agent/voice-presets',headers,payload:{name:'测试',provider:'local',model:'model'}});assert.equal(badWrite.statusCode,503);assert.equal(await readFile(path,'utf8'),'bad-json-containing-synthetic-key')
  const broken=await host.app.inject({url:'/api/v1/admin/agent/voice-presets',headers});assert.equal(broken.statusCode,500);assert.equal(broken.body.includes('bad-json-containing'),false)
 }finally{await host?.close();await rm(root,{recursive:true,force:true})}
})
