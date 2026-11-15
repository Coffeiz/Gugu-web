import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import type {LightMyRequestResponse} from 'fastify'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('生产四条感知API消费真实Python反思发布与Local文档，管理员隔离、权限和Redis错误脱敏', {skip:(!databaseUrl||!redisUrl||!python)&&'需要隔离PG/Redis与显式Python'},async()=>{
 const schema=`recent_host_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-recent-misread-'))
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:2}),owner=randomUUID(),developer=randomUUID(),secret='synthetic-recent-misread-secret',redisScoped=new URL(redisUrl!)
 redisScoped.pathname='/13'
 let host:Awaited<ReturnType<typeof startServer>>|undefined,published=false
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'config.json'),PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_DEVELOPER:developer,TEST_STORAGE:join(root,'storage'),TEST_REDIS_URL:redisScoped.toString()}
 const bridge=(action:string)=>execFileSync(python!,[resolve('../../compat/support/perception_recent_misread.py')],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,TEST_ACTION:action},timeout:15000})
 async function launch(redis:string){
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
  return startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:env.GUGU_CONFIG_OVERRIDE_FILE,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:redis,STORAGE__LOCAL_PATH:env.TEST_STORAGE,ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
 }
 async function login(){
  const response:LightMyRequestResponse=await host!.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  assert.equal(response.statusCode,200);return {authorization:`Bearer ${response.json().access_token}`}
 }
 try{
  await pool.query(execFileSync(python!,['-c',"from app.models import User,AuditLog;from sqlalchemy.schema import CreateTable;from sqlalchemy.dialects import postgresql;print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [User,AuditLog]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  for(const [id,isDev,name] of [[owner,false,'小北'],[developer,true,'小月']])await pool.query("INSERT INTO users(id,username,email,hashed_password,is_active,account_status,security_version,is_developer,created_at) VALUES($1,$2,$3,'synthetic',true,'active',1,$4,clock_timestamp())",[id,name,`${id}@example.invalid`,isDev])
  await writeFile(env.GUGU_CONFIG_OVERRIDE_FILE,'{}')
  host=await launch(redisScoped.toString())
  const url='/api/v1/admin/perception/misread/recent'
  assert.equal((await host.app.inject(url)).statusCode,401)
  assert.equal((await host.app.inject({url,headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)
  const exportUrl='/api/v1/admin/perception/export'
  const statsUrl='/api/v1/admin/perception'
  const markdownUrl='/api/v1/admin/perception/misread/export'
  assert.equal((await host.app.inject(markdownUrl)).statusCode,401)
  assert.equal((await host.app.inject({url:markdownUrl,headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)
  assert.equal((await host.app.inject(statsUrl)).statusCode,401)
  assert.equal((await host.app.inject({url:statsUrl,headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)
  assert.equal((await host.app.inject(exportUrl)).statusCode,401)
  assert.equal((await host.app.inject({url:exportUrl,headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)
  const headers=await login()
  assert.deepEqual((await host.app.inject({url,headers})).json(),{total:0,cases:[]})
  assert.equal((await host.app.inject({url:statsUrl,headers})).json().active_users,0)
  assert.match((await host.app.inject({url:markdownUrl,headers})).body,/暂无/)
  published=true;const expected=JSON.parse(bridge('publish'))
  const plain:LightMyRequestResponse=await host.app.inject({url,headers}),filtered:LightMyRequestResponse=await host.app.inject({url:url+'?exclude_dev=true',headers})
  assert.equal(plain.statusCode,200);assert.deepEqual(plain.json(),expected.plain)
  assert.equal(filtered.statusCode,200);assert.deepEqual(filtered.json(),expected.filtered)
  assert.doesNotMatch(plain.body,new RegExp(`${owner}|${developer}|synthetic-private-input`))
  const download:LightMyRequestResponse=await host.app.inject({url:exportUrl,headers})
  assert.equal(download.statusCode,200);assert.deepEqual(download.json(),expected.download.events)
  assert.equal(download.body,expected.download.raw);assert.equal(download.headers['content-disposition'],expected.download.disposition);assert.equal(download.headers['content-type'],expected.download.type)
  assert.doesNotMatch(download.body,new RegExp(`${owner}|${developer}|synthetic-private-input`))
  assert.deepEqual((await host.app.inject({url:exportUrl+'?hours=1',headers})).json(),expected.download.events)
  assert.deepEqual((await host.app.inject({url:exportUrl+'?hours=-1',headers})).json(),[])
  assert.equal((await host.app.inject({url:exportUrl+'?hours=bad',headers})).statusCode,422)
  const statistics:LightMyRequestResponse=await host.app.inject({url:statsUrl,headers})
  assert.equal(statistics.statusCode,200);assert.deepEqual(statistics.json(),expected.statistics)
  assert.deepEqual((await host.app.inject({url:statsUrl+'?exclude_dev=true',headers})).json(),expected.filtered_statistics)
  const huge='9'.repeat(400),noActive:LightMyRequestResponse=await host.app.inject({url:statsUrl+'?min_events='+huge,headers})
  assert.equal(noActive.statusCode,200);assert.match(noActive.body,new RegExp('"min_events":'+huge));assert.equal(noActive.json().active_users,0)
  for(const query of ['?rate_hi=nan','?ambig_hi=inf','?hours='+huge,'?limit='+huge])assert.equal((await host.app.inject({url:statsUrl+query,headers})).statusCode,500)
  assert.equal((await host.app.inject({url:statsUrl+'?rate_hi=1.',headers})).statusCode,200)
  const markdown:LightMyRequestResponse=await host.app.inject({url:markdownUrl,headers})
  assert.equal(markdown.statusCode,200);assert.equal(markdown.body,expected.markdown.body)
  assert.equal(markdown.headers['content-type'],expected.markdown.type);assert.equal(markdown.headers['content-disposition'],expected.markdown.disposition)
  const markdownDirectory=join(env.TEST_STORAGE,'_analytics');await chmod(markdownDirectory,0)
  try{
   const denied:LightMyRequestResponse=await host.app.inject({url:markdownUrl,headers})
   assert.equal(denied.statusCode,500);assert.doesNotMatch(denied.body,/EACCES|_analytics|misread.md|gugu-recent/)
  }finally{await chmod(markdownDirectory,0o700)}
  await pool.query('UPDATE users SET is_developer=false WHERE id=$1',[developer])
  assert.equal((await host.app.inject({url:url+'?exclude_dev=true',headers})).json().total,2)
  assert.equal((await host.app.inject({url:statsUrl+'?exclude_dev=true',headers})).json().active_users,2)
  assert.equal((await host.app.inject({url:url+'?n=bad',headers})).statusCode,422)
  bridge('corrupt')
  const failure:LightMyRequestResponse=await host.app.inject({url,headers})
  assert.equal(failure.statusCode,500);assert.doesNotMatch(failure.body,/WRONGTYPE|synthetic-wrongtype|redis|perc:misread_cases/i)
  bridge('corrupt-export')
  const exportFailure:LightMyRequestResponse=await host.app.inject({url:exportUrl,headers})
  assert.equal(exportFailure.statusCode,500);assert.doesNotMatch(exportFailure.body,/WRONGTYPE|synthetic-wrongtype|redis|perc:events/i)
  const statsFailure:LightMyRequestResponse=await host.app.inject({url:statsUrl,headers})
  assert.equal(statsFailure.statusCode,500);assert.doesNotMatch(statsFailure.body,/WRONGTYPE|synthetic-wrongtype|redis|perc:events/i)
  await host.close();host=undefined
  host=await launch('');const noRedisHeaders=await login()
  assert.equal((await host.app.inject({url,headers:noRedisHeaders})).statusCode,503)
  assert.equal((await host.app.inject({url:exportUrl,headers:noRedisHeaders})).statusCode,503)
  assert.equal((await host.app.inject({url:statsUrl,headers:noRedisHeaders})).statusCode,503)
  assert.equal((await host.app.inject({url:markdownUrl,headers:noRedisHeaders})).body,expected.markdown.body)
 }finally{await host?.close();if(published)bridge('cleanup');await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
