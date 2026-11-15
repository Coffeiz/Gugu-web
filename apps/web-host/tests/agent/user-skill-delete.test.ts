import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createUserSkillDeletion} from '@gugu/core/agent/skills/user-delete'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('删除技能限定owner，提交后通知；重复删除404且不发布，通知失败不回滚删除', {skip:!databaseUrl&&'需要隔离PostgreSQL'}, async()=>{
  const schema=`skill_delete_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:databaseUrl,max:1})
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1})
  const runtime=await createPostgresRuntime({url:databaseUrl!,schema})
  const first='00000000-0000-4000-8000-000000000061',second='00000000-0000-4000-8000-000000000062'
  const published:string[]=[]
  try {
    await pool.query('CREATE TABLE user_skills(id serial PRIMARY KEY,owner_id uuid NOT NULL,skill_id varchar(16) NOT NULL, UNIQUE(owner_id,skill_id))')
    await pool.query("INSERT INTO user_skills(owner_id,skill_id) VALUES($1,'U1'),($2,'U1'),($1,'U2')",[first,second])
    const remove=createUserSkillDeletion(runtime.db,'postgres',async(owner)=>{
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_skills WHERE owner_id=$1 AND skill_id=$2',[owner,'U1'])).rows[0].count,0)
      published.push(owner)
    })
    await assert.rejects(remove(first,'foreign'),(error:unknown)=>(error as {code:string}).code==='not_found')
    assert.deepEqual(published,[])
    await remove(first,'U1')
    assert.deepEqual(published,[first])
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_skills WHERE owner_id=$1',[second])).rows[0].count,1)
    await assert.rejects(remove(first,'U1'),(error:unknown)=>(error as {code:string}).code==='not_found')
    assert.deepEqual(published,[first])
    await createUserSkillDeletion(runtime.db,'postgres',async()=>{throw new Error('synthetic-notify-failure')})(first,'U2')
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_skills WHERE owner_id=$1',[first])).rows[0].count,0)
  } finally {await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

import Fastify from 'fastify'
import {registerUserSkillDeleteRoute} from '../../src/modules/skills/user-delete.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
import {CoreError} from '@gugu/core'

test('删除技能HTTP未认证拒绝、可信owner及204空响应和404映射',async()=>{
  const app=Fastify();installHttpErrorHandler(app)
  const calls:string[][]=[]
  registerUserSkillDeleteRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},ownerIdFromRequest:()=> 'trusted-owner',remove:async(owner,id)=>{calls.push([owner,id]);if(id==='missing')throw new CoreError('not_found','Skill 不存在')}})
  try {
    assert.equal((await app.inject({method:'DELETE',url:'/api/v1/skills/U1'})).statusCode,401)
    assert.deepEqual(calls,[])
    const removed=await app.inject({method:'DELETE',url:'/api/v1/skills/U1',headers:{authorization:'user'}})
    assert.equal(removed.statusCode,204);assert.equal(removed.body,'')
    assert.deepEqual(calls,[['trusted-owner','U1']])
    const missing=await app.inject({method:'DELETE',url:'/api/v1/skills/missing',headers:{authorization:'user'}})
    assert.equal(missing.statusCode,404);assert.deepEqual(missing.json(),{detail:'Skill 不存在'})
  }finally{await app.close()}
})
