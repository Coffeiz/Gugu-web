import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import Fastify from 'fastify'
import {createVoicePresetFileMutations,registerVoicePresetMutationRoutes} from '../../src/modules/admin/voice-presets-mutate.js'
test('语音预设CRUD持久化、目的地密钥隔离、失败回滚及停用删除活动项',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-mutate-')),path=join(root,'override.json'),app=Fastify(),headers={authorization:'admin'}
 registerVoicePresetMutationRoutes(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(401).send({detail:'未登录'})},operations:createVoicePresetFileMutations(path)})
 const request=(method:'POST'|'PUT'|'DELETE',suffix:string,payload?:unknown)=>app.inject({method,url:`/api/v1/admin/agent/voice-presets${suffix}`,headers,...(payload?{payload}: {})})
 try{
  await writeFile(path,JSON.stringify({db:{marker:'preserve'},llm_presets:{items:[{id:'keep'}]}}))
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/agent/voice-presets',payload:{}})).statusCode,401)
  const first=await request('POST','',{name:' 测试语音 ',provider:'qwen',api_key:'synthetic-test-key',base_url:'https://voice.example.test',model:'qwen3-asr-flash',api_format:'dashscope'})
  assert.equal(first.statusCode,200,first.body);const id=first.json().item.id;assert.equal(first.json().active_id,id);assert.equal(first.json().item.name,'测试语音');assert.equal(first.json().item.dashscope_service,'qwen3-asr');assert.equal(first.body.includes('synthetic-test-key'),false)
  const before=await readFile(path,'utf8');assert.equal((await request('PUT',`/${id}`,{base_url:'https://other.example.test',api_key:''})).statusCode,422);assert.equal(await readFile(path,'utf8'),before)
  const updated=await request('PUT',`/${id}`,{model:'fun-asr-flash',api_key:''});assert.equal(updated.statusCode,200);assert.equal(updated.json().item.dashscope_service,'fun-asr');assert.equal(updated.json().item.has_api_key,true)
  assert.equal((await request('POST','/deactivate')).statusCode,200);assert.equal(JSON.parse(await readFile(path,'utf8')).voice_presets.active_id,'')
  assert.equal((await request('POST',`/${id}/activate`)).json().active_id,id)
  assert.equal((await request('DELETE',`/${id}`)).json().active_id,'');assert.equal(JSON.parse(await readFile(path,'utf8')).voice_presets.items.length,0)
  const final=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(final.db,{marker:'preserve'});assert.deepEqual(final.llm_presets,{items:[{id:'keep'}]})
  assert.equal((await request('POST','/missing/activate')).statusCode,404)
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
})
import {spawn} from 'node:child_process'
import {resolve} from 'node:path'
test('真实Python flock与两个Node写入串行化，保留Python更新及全部新增预设',async()=>{
 const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
 const root=await mkdtemp(join(tmpdir(),'voice-mutate-')),path=join(root,'override.json'),operations=createVoicePresetFileMutations(path)
 let child:ReturnType<typeof spawn>|undefined
 try{
  await writeFile(path,JSON.stringify({db:{marker:'preserve'}}))
  child=spawn(python,[resolve('tests/admin/fixtures/voice_config_lock_writer.py'),'--allow-isolated-test-config',path],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend')},stdio:['ignore','pipe','pipe']})
  const writer=child
  const finished=new Promise<void>((resolve,reject)=>{writer.once('error',reject);writer.once('exit',code=>code===0?resolve():reject(new Error('Python配置写入夹具失败')))})
  await new Promise<void>((resolve,reject)=>{let output='';writer.stdout!.on('data',chunk=>{output+=chunk.toString();if(output.includes('locked'))resolve()});writer.once('error',reject);writer.once('exit',code=>{if(code!==0)reject(new Error('Python未获得配置锁'))})})
  await Promise.all([operations.create({name:'预设一',provider:'local',model:'model-one'}),operations.create({name:'预设二',provider:'local',model:'model-two'})]);await finished
  const document=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(document.db,{marker:'preserve',writer:'python'});assert.equal(document.voice_presets.items.length,2);assert.deepEqual(new Set(document.voice_presets.items.map((item:{name:string})=>item.name)),new Set(['预设一','预设二']))
 }finally{if(child?.exitCode===null)child.kill('SIGTERM');await rm(root,{recursive:true,force:true})}
})
test('缺失或损坏配置不创建覆盖，非法集合与模型校验失败保留原文',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-mutate-')),path=join(root,'override.json'),operations=createVoicePresetFileMutations(path)
 try{
  const draft={name:'测试语音',provider:'local',model:'model'}
  await assert.rejects(operations.create(draft),{statusCode:503});await assert.rejects(readFile(path),{code:'ENOENT'})
  for(const text of ['broken-json',JSON.stringify({voice_presets:{items:null}})]){
   await writeFile(path,text);await assert.rejects(operations.create(draft));assert.equal(await readFile(path,'utf8'),text)
  }
  await writeFile(path,'{}');await assert.rejects(operations.create({name:'无效',provider:'minimax',model:'model',api_format:'openai'}),{statusCode:422});assert.equal(await readFile(path,'utf8'),'{}')
 }finally{await rm(root,{recursive:true,force:true})}
})
