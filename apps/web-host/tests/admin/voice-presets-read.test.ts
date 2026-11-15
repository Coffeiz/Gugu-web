import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import Fastify from 'fastify'
import {createVoicePresetsFileReader,registerVoicePresetsReadRoute} from '../../src/modules/admin/voice-presets-read.js'
test('语音预设只读动态配置并正确遮蔽ASCII/Unicode密钥，保留未知字段和激活态',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-read-')),path=join(root,'override.json'),app=Fastify()
 registerVoicePresetsReadRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(401).send({detail:'未登录'})},read:createVoicePresetsFileReader(path)})
 try{
  const document={db:{marker:'preserve'},voice_presets:{active_id:'v_one',items:[{id:'v_one',name:'测试语音',api_key:'synthetic-key',extension:'preserve'},{id:'v_two',api_key:'🔑🔑'},{id:'v_three',api_key:''},null,8]}}
  await writeFile(path,JSON.stringify(document));const before=await readFile(path,'utf8')
  assert.equal((await app.inject({url:'/api/v1/admin/agent/voice-presets'})).statusCode,401)
  const response=await app.inject({url:'/api/v1/admin/agent/voice-presets',headers:{authorization:'admin'}});assert.equal(response.statusCode,200)
  const body=response.json();assert.equal(body.active_id,'v_one');assert.equal(body.items.length,3);assert.equal(body.items[0].api_key,'syn••••••-key');assert.equal(body.items[0].has_api_key,true);assert.equal(body.items[0].active,true);assert.equal(body.items[0].extension,'preserve');assert.equal(body.items[1].api_key,'••');assert.equal(body.items[2].has_api_key,false);assert.equal(response.body.includes('synthetic-key'),false)
  assert.equal(await readFile(path,'utf8'),before)
  await writeFile(path,JSON.stringify({voice_presets:{active_id:'v_two',items:document.voice_presets.items}}));const updated=await app.inject({url:'/api/v1/admin/agent/voice-presets',headers:{authorization:'admin'}});assert.equal(updated.json().items[1].active,true)
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
})
test('缺少配置或预设集合无效时返回空列表且不会创建文件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-empty-')),path=join(root,'override.json'),read=createVoicePresetsFileReader(path)
 try{
  assert.deepEqual(await read(),{active_id:'',items:[]});await assert.rejects(readFile(path),{code:'ENOENT'})
  for(const document of [{},{voice_presets:null},{voice_presets:{active_id:'stale',items:null}}]){await writeFile(path,JSON.stringify(document));assert.deepEqual(await read(),{active_id:'',items:[]})}
 }finally{await rm(root,{recursive:true,force:true})}
})
