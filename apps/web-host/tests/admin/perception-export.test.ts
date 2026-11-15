import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {createPerceptionEventExporter} from '@gugu/core/perception-export'
import {registerAdminPerceptionExportRoute} from '../../src/modules/admin/perception-export.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
const python=process.env.GUGU_WEBUI_TEST_PYTHON
const now=10000
function reference(raw:string[],hours:string[]){
 assert.ok(python,'需要显式隔离测试Python')
 return JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from app.api.v1 import agent_perception as api
payload=json.load(sys.stdin)
class Store:
 async def lrange(self,key,start,stop):
  assert (key,start,stop)==('perc:events',0,-1)
  return payload['raw']
api.get_redis=lambda:Store();api.time.time=lambda:10000.0
async def main():
 result=[]
 for value in payload['hours']:
  try:
   response=await api.export_events(hours=int(value))
   result.append({'status':response.status_code,'events':json.loads(response.body),'filename':response.headers['content-disposition'],'type':response.headers['content-type']})
  except Exception: result.append({'status':500})
 print(json.dumps(result))
asyncio.run(main())`],{encoding:'utf8',input:JSON.stringify({raw,hours}),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-perception-export'}}))
}
test('导出全部遥测列表，Python时间窗含边界、缺时间默认0和稳定排序，无效记录不伪造结果',async()=>{
 const datasets=[['{',JSON.stringify({ts:10001,kind:'future'}),JSON.stringify({ts:6400,kind:'boundary'}),JSON.stringify({ts:6399.999999,kind:'outside'}),JSON.stringify({kind:'missing'}),JSON.stringify({ts:null,kind:'null'}),JSON.stringify({ts:0,kind:'zero'}),JSON.stringify({ts:10001,kind:'same-time'})],[],['null'],[JSON.stringify({ts:'synthetic'}),JSON.stringify({ts:1})],[JSON.stringify({ts:'𐀀'}),JSON.stringify({ts:'\uE000'})]]
 const hours=['0','1','2','-1','999999999999999999999999','9'.repeat(400)]
 for(const raw of datasets){
  const expected=reference(raw,hours),read=createPerceptionEventExporter(async(key,start,stop)=>{assert.deepEqual([key,start,stop],['perc:events',0,-1]);return raw},()=>now)
  for(const [index,value] of hours.entries()){
   if(expected[index].status===500)await assert.rejects(()=>read(BigInt(value)))
   else{
    const actual=await read(BigInt(value));assert.deepEqual(actual.events,expected[index].events)
    assert.equal(`attachment; filename="${actual.filename}"`,expected[index].filename)
   }
  }
 }
})
test('导出管理员鉴权、JSON附件头与查询校验，无Redis503及失败500脱敏',async()=>{
 let available=true,fail=false,calls=0
 const app=Fastify();installHttpErrorHandler(app)
 registerAdminPerceptionExportRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},available:()=>available,read:async(hours=0n)=>{calls++;if(fail)throw new Error('/tmp/synthetic-secret token=syntheticsecretvalue');return {events:[{ts:1,u:'syntheti',text:'中文😀'}],filename:`perception_events_${hours||'all'}h.json`}}})
 try{
  const url='/api/v1/admin/perception/export',headers={authorization:'admin'}
  assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({url,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  for(const [query,filename] of [['','all'],['?hours=1.0','1'],['?hours=-1','-1'],['?hours=1_0','10'],['?hours=2&hours=3','3'],['?hours=999999999999999999999999','999999999999999999999999']]){
   const response=await app.inject({url:url+query,headers});assert.equal(response.statusCode,200)
   assert.equal(response.headers['content-disposition'],`attachment; filename="perception_events_${filename}h.json"`)
   assert.match(String(response.headers['content-type']),/^application\/json; charset=utf-8$/)
   assert.deepEqual(response.json(),[{ts:1,u:'syntheti',text:'中文😀'}]);assert.match(response.body,/\n /)
  }
  for(const query of ['?hours=bad','?hours=1.1','?hours=1e2','?hours=１２'])assert.equal((await app.inject({url:url+query,headers})).statusCode,422)
  available=false;assert.equal((await app.inject({url,headers})).statusCode,503)
  available=true;fail=true;const failure=await app.inject({url,headers});assert.equal(failure.statusCode,500);assert.doesNotMatch(failure.body,/synthetic-secret|syntheticsecretvalue/)
 }finally{await app.close()}
})
