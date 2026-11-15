import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import type {LightMyRequestResponse} from 'fastify'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('生产Host完整邮件预览经真实管理员认证，10色板HTML/plain/图片与Python相同，无SMTP或Redis', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`email_preview_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-email-preview-'))
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:2}),owner=randomUUID(),secret='synthetic-email-preview-secret'
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'config.json'),PYTHONPATH:'.'}
 try{
  await pool.query(execFileSync(python!,['-c',"from app.models import User,AuditLog; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [User,AuditLog]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  await pool.query("INSERT INTO users(id,username,email,hashed_password,is_active,account_status,security_version,is_developer,created_at) VALUES($1,'小北','synthetic-preview@example.invalid','synthetic-not-a-password',true,'active',1,false,clock_timestamp())",[owner])
  await writeFile(env.GUGU_CONFIG_OVERRIDE_FILE,'{}')
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:env.GUGU_CONFIG_OVERRIDE_FILE,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:join(root,'storage'),ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const url='/api/v1/admin/email/preview',base={subject:'站点 <更新>',title:'邮件预览😀',body:'第一行\n<script>不执行</script>',preheader:' 预览摘要 ',sections:[{heading:'状态',text:'进度 & 后续'}],actions:[{label:'打开项目',url:'https://example.invalid/project?a=1&b=2'}]}
  assert.equal((await host.app.inject({method:'POST',url,payload:base})).statusCode,401)
  assert.equal((await host.app.inject({method:'POST',url,payload:base,headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)
  const login:LightMyRequestResponse=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const drafts=[];for(const theme of ['light','dark'])for(const palette of ['cafe','neutral','red','blue','green'])drafts.push({...base,theme,palette})
  const expected=JSON.parse(execFileSync(python!,['-c',"import asyncio,json,sys;from app.api.v1.email_admin import EmailDraft,preview_email;print(json.dumps([asyncio.run(preview_email(EmailDraft.model_validate(value))) for value in json.load(sys.stdin)]))"],{encoding:'utf8',input:JSON.stringify(drafts),maxBuffer:8*1024*1024,cwd:resolve('../../backend'),env}))
  for(const [index,payload] of drafts.entries()){
   const response:LightMyRequestResponse=await host.app.inject({method:'POST',url,payload,headers})
   assert.equal(response.statusCode,200,response.body.slice(0,150));assert.deepEqual(response.json(),expected[index])
  }
  const unsafe:LightMyRequestResponse=await host.app.inject({method:'POST',url,payload:{...base,actions:[{label:'打开',url:'javascript:alert(1)'}]},headers})
  assert.equal(unsafe.statusCode,400);assert.deepEqual(unsafe.json(),{detail:'操作链接只支持 http、https 或 mailto 协议'})
  assert.equal((await host.app.inject({method:'POST',url,payload:{...base,translations:{'en-US':{subject:'缺少正文'}}},headers})).statusCode,422)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action<>'login'")).rows[0].n,0)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
