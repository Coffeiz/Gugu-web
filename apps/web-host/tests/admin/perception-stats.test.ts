import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {aggregatePerceptionStats} from '@gugu/core/perception-stats'
import {registerAdminPerceptionStatsRoute} from '../../src/modules/admin/perception-stats.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
const python=process.env.GUGU_WEBUI_TEST_PYTHON
const p=(u:string,ts:number,intent:string,model='synthetic-model',extra:Record<string,unknown>={})=>({t:'perc',u,ts,intent,model,...extra})
const m=(u:string,ts:number,kind='感知误读')=>({t:'misperc',u,ts,kind})
function canonical(value:any){
 const result=structuredClone(value)
 // Python set 迭代对等比分组无稳定次序；保留排名断言，比较各行完整内容。
 for(const [field,key] of [['intent_distribution','intent'],['misperc_by_kind','kind'],['flag_items','kind']] as const)if(result[field])result[field].sort((a:any,b:any)=>JSON.stringify([a[key],a.intent,a.model]).localeCompare(JSON.stringify([b[key],b.intent,b.model])))
 if(result.flags)result.flags.sort()
 return result
}
test('真实Python总览全字段对照保护宏平均、空值、误判配对、类别及阈值标记',()=>{
 assert.ok(python,'需要显式隔离测试Python')
 const datasets=[[],[p('aaaa',9000,'查询')],[p('aaaa',8000,'查询','A',{ambiguity:20.25,emo:true}),m('aaaa',8500),p('aaaa',9000,'闲聊','B',{ambiguity:40.25,emo:1,emotion:'委屈'}),m('aaaa',7000),m('aaaa',9500,'数据或执行错'),{t:'fb',u:'aaaa',ts:9600,v:'确认夸赞'},p('bbbb',8000,'陪伴','B',{ambiguity:null,emo:null})],Array.from({length:10},(_,i)=>p('heavy',9000+i,'查询','A',{ambiguity:65.25})).concat([p('light',9001,'情绪','B',{ambiguity:0})]),Array.from({length:50},(_,i)=>p('flag',8000+i*2,'查询',i<40?'A':'B',{ambiguity:80,emotion:'无'})).flatMap((item,i)=>i%2?[item,m('flag',item.ts+1,i%3?'感知误读':'数据或执行错')]:[item])]
 const variants=[{}, {min_events:2}, {min_n:1,rate_hi:0.2,ambig_hi:40}, {exclude_dev:true}, {hours:0}, {hours:-1}]
 const cases=datasets.flatMap(events=>variants.map(query=>({events,query})))
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from app.api.v1 import agent_perception as api
payload=json.load(sys.stdin)
class Store:
 async def lrange(self,key,start,stop):
  assert key=='perc:events'
  return [json.dumps(item) for item in current][start:stop+1 if stop!=-1 else None]
api.get_redis=lambda:Store();api.time.time=lambda:10000.0
async def prefixes(db): return {'bbbb'}
api._dev_prefixes=prefixes
async def main():
 global current
 result=[]
 for item in payload:
  current=item['events']
  result.append(await api.perception_stats(db=None,**item['query']))
 print(json.dumps(result))
asyncio.run(main())`],{encoding:'utf8',input:JSON.stringify(cases),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-perception-stats'}}))
 for(const [index,item] of cases.entries()){
  const q=item.query as Record<string,any>
  const actual=aggregatePerceptionStats(item.events,{hours:BigInt(q.hours??168),minEvents:BigInt(q.min_events??1),minN:BigInt(q.min_n??10),rateHi:q.rate_hi??0.25,ambigHi:q.ambig_hi??60,excludeDev:q.exclude_dev??false},new Set(['bbbb']),10000)
  assert.deepEqual(canonical(actual),canonical(expected[index]),`case ${index}`)
  const rows=actual.intent_distribution
  for(let i=1;i<rows.length;i++)assert.ok(rows[i-1]!.pct>=rows[i]!.pct)
 }
 assert.throws(()=>aggregatePerceptionStats([],{rateHi:NaN}),/感知阈值超出范围/)
 assert.throws(()=>aggregatePerceptionStats([],{ambigHi:Infinity}),/感知阈值超出范围/)
})
test('管理员总览参数与非有限阈值错误保护，认证先于数据读取',async()=>{
 const app=Fastify();installHttpErrorHandler(app);let calls=0,available=true
 registerAdminPerceptionStatsRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},available:()=>available,read:async(query={})=>{calls++;assert.equal(query.hours,0n);assert.equal(query.limit,0n);assert.equal(query.minEvents,-1n);assert.equal(query.minN,1n);assert.equal(query.rateHi,0.1);assert.equal(query.ambigHi,2.5);assert.equal(query.excludeDev,true);return {window_hours:query.hours} as never}})
 try{
  const url='/api/v1/admin/perception',headers={authorization:'admin'}
  assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({url,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  const response=await app.inject({url:url+'?hours=0&limit=0&min_events=-1&min_n=1.0&rate_hi=1e-1&ambig_hi=2_5e-1&exclude_dev=YES',headers})
  assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{window_hours:0})
  for(const query of ['?hours=bad','?limit=1.2','?min_events=bad','?min_n=bad','?rate_hi=bad','?ambig_hi=bad','?exclude_dev=bad'])assert.equal((await app.inject({url:url+query,headers})).statusCode,422)
  available=false;assert.equal((await app.inject({url:url+'?hours=0&limit=0&min_events=-1&min_n=1&rate_hi=.1&ambig_hi=2.5&exclude_dev=true',headers})).statusCode,503)
 }finally{await app.close()}
})
