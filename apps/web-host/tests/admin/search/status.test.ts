import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {createAdminEmbeddingRebuildStatusReader} from '../../../src/modules/admin/embedding.js'
import {registerAdminEmbeddingRebuildStatusRoute} from '../../../src/modules/admin/embedding.js'
import {installHttpErrorHandler} from '../../../src/http/errors.js'

test('管理员状态兼容Python原handler的idle/任意JSON/完整进度，错误终态脱敏',()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON
 assert.ok(python,'需要显式隔离测试Python')
 return (async()=>{
  for(const raw of [null,'','{','null','[]','42',JSON.stringify({status:'running',done:3,total:5,tag:'tag',ts:12,message:'进度 /tmp/synthetic-progress'}),JSON.stringify({status:'done',pattern_vectors:4,memory_vectors:8,failed_users:0,rag_failed_users:0,message:'完成',ts:13})]){
   const read=createAdminEmbeddingRebuildStatusReader(async()=>raw)
   const reference=JSON.parse(execFileSync(python,['-c',"import asyncio,json,os; from app.api.v1 import config; from app.core import redis\nclass Store:\n async def get(self,key):\n  assert key=='emb:rebuild'\n  return json.loads(os.environ['TEST_RAW'])\nredis.get_redis=lambda:Store()\nprint(json.dumps(asyncio.run(config.embedding_rebuild_status())))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-admin-rebuild-config',PYTHONPATH:'.',TEST_RAW:JSON.stringify(raw)}}))
   assert.deepEqual(await read(),reference)
  }
  const read=createAdminEmbeddingRebuildStatusReader(async()=>JSON.stringify({status:'error',message:'无法读取 /tmp/synthetic-secret token=syntheticsecretvalue',done:2,total:3,ts:14}))
  const error=await read() as Record<string,unknown>
  assert.equal(error.status,'error');assert.equal(error.done,2);assert.equal(error.total,3);assert.equal(error.ts,14)
  assert.doesNotMatch(String(error.message),/synthetic-secret|syntheticsecretvalue/)
 })()
})

test('管理员认证先于Redis读取；无Redis503且读取失败脱敏500',async()=>{
 const app=Fastify();installHttpErrorHandler(app);let calls=0,available=true,fail=false
 registerAdminEmbeddingRebuildStatusRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(request.headers.authorization?403:401).send({detail:'拒绝访问'})},available:()=>available,read:async()=>{calls++;if(fail)throw new Error('token=syntheticsecretvalue /tmp/synthetic-secret');return {status:'idle'}}})
 try{
  const url='/api/v1/admin/config/embedding-rebuild/status',headers={authorization:'admin'}
  assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({url,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  assert.deepEqual((await app.inject({url,headers})).json(),{status:'idle'})
  available=false;assert.equal((await app.inject({url,headers})).statusCode,503);assert.equal(calls,1)
  available=true;fail=true;const error=await app.inject({url,headers});assert.equal(error.statusCode,500);assert.doesNotMatch(error.body,/synthetic-secret|syntheticsecretvalue/)
 }finally{await app.close()}
})
