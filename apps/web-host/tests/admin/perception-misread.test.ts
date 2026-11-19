import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {createPostgresRuntime} from '@gugu/core/data'
import {createAdminMisreadReader} from '@gugu/core/perception-recent-misread'
import {registerAdminRecentMisreadRoute} from '../../src/modules/admin/perception.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('最近错读先限制原始Redis列表再跳坏JSON，开发者前缀过滤只超采200并读取真实用户表', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`misread_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2}),runtime=await createPostgresRuntime({url:databaseUrl!,schema}),developer=randomUUID(),owner=randomUUID()
 try{
  const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-misread-config',TEST_SCHEMA:schema}
  await pool.query(execFileSync(python!,['-c',"from app.models import User;from sqlalchemy.schema import CreateTable;from sqlalchemy.dialects import postgresql;print(CreateTable(User.__table__).compile(dialect=postgresql.dialect()))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  for(const [id,isDev] of [[developer,true],[owner,false]])await pool.query("INSERT INTO users(id,username,email,hashed_password,is_active,account_status,security_version,is_developer,created_at) VALUES($1,$3,$4,'synthetic',true,'active',1,$2,clock_timestamp())",[id,isDev,String(id),`${id}@example.invalid`])
  const raw=['{',JSON.stringify({u:developer.slice(0,8),miss:{pattern:'潜台词漏读'},sequence:1}),JSON.stringify({u:owner.slice(0,8),miss:{pattern:'情绪当任务'},sequence:2}),...Array.from({length:198},(_,i)=>JSON.stringify({u:developer.slice(0,8),sequence:i+3})),JSON.stringify({u:'outside!',sequence:201})]
  const read=createAdminMisreadReader(runtime.db,async(key,start,stop)=>{assert.equal(key,'perc:misread_cases');assert.equal(start,0);return raw.slice(start,stop+1)})
  const scenarios=[{}, {n:1},{n:2},{n:3},{n:0},{n:-5},{n:300},{n:2,excludeDev:true},{n:200,excludeDev:true}]
  const expected=JSON.parse(execFileSync(python!,['-c',`import asyncio,json,os,sys
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.api.v1 import agent_perception as api
payload=json.load(sys.stdin)
class Store:
 async def lrange(self,key,start,stop):
  assert key=='perc:misread_cases'
  return payload['raw'][start:stop+1]
api.get_redis=lambda:Store()
async def main():
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})
 try:
  async with async_sessionmaker(engine)() as db:
   print(json.dumps([await api.misread_recent(n=item.get('n',30),exclude_dev=item.get('excludeDev',False),db=db) for item in payload['scenarios']]))
 finally: await engine.dispose()
asyncio.run(main())`],{encoding:'utf8',input:JSON.stringify({raw,scenarios}),cwd:resolve('../../backend'),env}))
  for(const [index,scenario] of scenarios.entries())assert.deepEqual(await read(scenario),expected[index])
  assert.equal((await read({n:200,excludeDev:true})).total,1)
  await pool.query('UPDATE users SET is_developer=false WHERE id=$1',[developer]);assert.equal((await read({n:3,excludeDev:true})).total,3)
  const unavailable=createAdminMisreadReader(runtime.db,async()=>{throw new Error('synthetic Redis failure')})
  await assert.rejects(()=>unavailable({}),/synthetic Redis failure/)
  const scalars=createAdminMisreadReader(runtime.db,async()=>['null','[]','false','42','"合成标量"'])
  assert.deepEqual(await scalars({}),{total:5,cases:[null,[],false,42,'合成标量']})
  await assert.rejects(()=>scalars({excludeDev:true}),/错读案例记录格式无效/)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('管理员查询参数与真实FastAPI一致，无Redis503且后端失败脱敏',async()=>{
 assert.ok(python,'需要显式隔离测试Python')
 const queries=['','?n=0','?n=-1','?n=300','?n=1.0','?n=1_0','?n=1_0.00','?n=1.0_0','?n=%C2%851%C2%85','?n=%EF%BB%BF1','?n=999999999999999999999999','?n=2&n=3','?n=bad','?n=1.2','?n=1e2','?n=１２','?exclude_dev=yes','?exclude_dev=OFF','?exclude_dev=%20true%20','?exclude_dev=bad','?exclude_dev=false&exclude_dev=true']
 const expected=JSON.parse(execFileSync(python,['-c',`import json,sys
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api.v1 import agent_perception as api
from app.db.session import get_db
class Store:
 async def lrange(self,key,start,stop): return [json.dumps({'index':i}) for i in range(250)][start:stop+1]
async def db(): yield None
async def prefixes(db): return set()
api.get_redis=lambda:Store();api._dev_prefixes=prefixes
app=FastAPI();app.include_router(api.router,prefix='/api/v1');app.dependency_overrides[get_db]=db
with TestClient(app) as client:
 print(json.dumps([{'status':(r:=client.get('/api/v1/admin/perception/misread/recent'+query)).status_code,'body':r.json() if r.status_code==200 else None} for query in json.load(sys.stdin)]))`],{encoding:'utf8',input:JSON.stringify(queries),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-misread-query'}}))
 let calls=0,available=true,fail=false
 const app=Fastify();installHttpErrorHandler(app)
 registerAdminRecentMisreadRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},available:()=>available,read:async({n=30}={})=>{calls++;if(fail)throw new Error('/tmp/synthetic-secret token=syntheticsecretvalue');const count=Math.max(1,Math.min(n||30,200));return {total:count,cases:Array.from({length:count},(_,index)=>({index}))}}})
 try{
  const url='/api/v1/admin/perception/misread/recent',headers={authorization:'admin'}
  assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({url,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  for(const [index,query] of queries.entries()){
   const response=await app.inject({url:url+query,headers});assert.equal(response.statusCode,expected[index].status,query)
   if(response.statusCode===200)assert.deepEqual(response.json(),expected[index].body)
  }
  available=false;assert.equal((await app.inject({url,headers})).statusCode,503)
  available=true;fail=true;const failure=await app.inject({url,headers});assert.equal(failure.statusCode,500);assert.doesNotMatch(failure.body,/syntheticsecretvalue|synthetic-secret/)
 }finally{await app.close()}
})
