import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerLlmPresetSelectionRoutes} from '../../src/modules/admin/llm-preset-selection.js'
import {createLlmPresetSelection} from '../../../../packages/core/src/agent/config/llm-preset-selection.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('管理员激活删除权限、404与400历史语义及持久化失败边界',async()=>{
 const app=Fastify();installHttpErrorHandler(app);let document:Record<string,unknown>={ai_presets:{active_id:'a',items:[{id:'a',model:'a'},{id:'b',model:'b'}]}},writes=0,invalidations=0,failSave=false,failState=false
 const operations=createLlmPresetSelection(async work=>{writes++;if(failSave)throw new Error('synthetic configuration failure');return work(document)},async()=>{invalidations++;if(failState)throw new Error('/tmp/synthetic-state token=syntheticsecretvalue');return 0})
 registerLlmPresetSelectionRoutes(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},operations})
 try{
  const base='/api/v1/admin/agent/llm-presets',headers={authorization:'admin'}
  for(const [method,url] of [['POST',`${base}/b/activate`],['DELETE',`${base}/b`]] as const){assert.equal((await app.inject({method,url})).statusCode,401);assert.equal((await app.inject({method,url,headers:{authorization:'user'}})).statusCode,403)}
  assert.equal(writes,0);assert.equal(invalidations,0)
  assert.equal((await app.inject({method:'POST',url:`${base}/missing/activate`,headers})).statusCode,404);assert.equal(invalidations,0)
  assert.equal((await app.inject({method:'DELETE',url:`${base}/a`,headers})).statusCode,400);assert.equal(invalidations,0)
  assert.deepEqual((await app.inject({method:'DELETE',url:`${base}/missing`,headers})).json(),{deleted:'missing'});assert.equal(invalidations,1)
  assert.deepEqual((await app.inject({method:'POST',url:`${base}/b/activate`,headers})).json(),{active_id:'b'});assert.equal((document.ai as Record<string,unknown>).model,'b')
  failState=true;const failure=await app.inject({method:'DELETE',url:`${base}/a`,headers});assert.equal(failure.statusCode,500);assert.doesNotMatch(failure.body,/synthetic-state|syntheticsecretvalue/);assert.deepEqual((document.ai_presets as Record<string,unknown>).items,[{id:'b',model:'b'}])
  failState=false;assert.equal((await app.inject({method:'DELETE',url:`${base}/missing`,headers})).statusCode,400)
  failSave=true;assert.equal((await app.inject({method:'POST',url:`${base}/b/activate`,headers})).statusCode,503)
 }finally{await app.close()}
})
