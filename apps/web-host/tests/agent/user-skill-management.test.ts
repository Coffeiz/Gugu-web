import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHash} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createUserSkillManager} from '../../../../packages/core/src/agent/skills/user-management.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL
const a='00000000-0000-4000-8000-000000000061',b='00000000-0000-4000-8000-000000000062'
test('用户技能持久创建、owner隔离、序列并发和失败回滚',{skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`gugu_skill_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url:url!,schema})
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,next_skill_sequence integer NOT NULL DEFAULT 1)')
  await pool.query("CREATE TABLE user_skills(id serial PRIMARY KEY,owner_id uuid NOT NULL,skill_id text NOT NULL,name text NOT NULL,description_short text NOT NULL,description_long text,category text NOT NULL,body text NOT NULL,related_tools json NOT NULL,source text NOT NULL,managed_by text NOT NULL,enabled boolean NOT NULL,content_digest text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(owner_id,skill_id))")
  await pool.query('INSERT INTO users(id) VALUES($1),($2)',[a,b]);const events:string[]=[]
  const manager=createUserSkillManager(runtime.db,'postgres',{knownTools:async()=>new Set(['web_search']),digest:text=>createHash('sha256').update(text).digest('hex').slice(0,16),publish:async owner=>{events.push(owner)}})
  const input={name:'合成',description_short:'摘要',description_long:null,category:'personal',body:'正文',related_tools:['web_search'],enabled:true}
  const [one,two]=await Promise.all([manager.create(a,input),manager.create(a,input)])
  assert.deepEqual(new Set([one.id,two.id]),new Set(['U1','U2']))
  const assistantSkill=await manager.create(a,{...input,name:'助理归纳',managed_by:'assistant'})
  assert.equal(assistantSkill.managed_by,'assistant')
  await assert.rejects(manager.update(b,one.id,{name:'越权'}));assert.equal((await manager.list(b)).length,0)
  await assert.rejects(manager.create(a,{...input,related_tools:['unknown']}));assert.equal((await pool.query('SELECT next_skill_sequence FROM users WHERE id=$1',[a])).rows[0].next_skill_sequence,4)
  const updated=await manager.update(a,one.id,{body:'更新正文',enabled:false});assert.equal(updated.body,'更新正文');assert.equal(updated.enabled,false)
  const assistantUpdated=await manager.update(a,assistantSkill.id,{body:'保留管理者'});assert.equal(assistantUpdated.managed_by,'assistant')
  const userTakeover=await manager.update(a,assistantSkill.id,{managed_by:'user',category:null});assert.equal(userTakeover.managed_by,'user');assert.equal(userTakeover.category,'personal')
  assert.equal((await manager.list(a)).length,3);assert.equal(events.length,6)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
