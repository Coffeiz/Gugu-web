import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createCredentialDeletion} from '@gugu/core/byok/credential-delete'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('BYOK删除受开关及owner限制，LLM同事务清空active推理状态，失败则回滚凭据', {skip:!databaseUrl&&'需要隔离PostgreSQL'},async()=>{
 const schema=`credential_delete_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1})
 const runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const owner='00000000-0000-4000-8000-000000000071',foreign='00000000-0000-4000-8000-000000000072'
 try{
  await pool.query('CREATE TABLE user_provider_credentials(id integer PRIMARY KEY,user_id uuid,capability text)')
  await pool.query('CREATE TABLE provider_reasoning_states(id integer PRIMARY KEY,user_id uuid,status text,invalidated_reason text,invalidated_at timestamptz,encrypted_payload text,payload_nonce text,encrypted_data_key text,payload_size integer,version integer,updated_at timestamptz)')
  await pool.query("INSERT INTO user_provider_credentials VALUES(1,$1,'llm'),(2,$2,'llm'),(3,$1,'embedding'),(4,$1,'llm')",[owner,foreign])
  await pool.query("INSERT INTO provider_reasoning_states(id,user_id,status,encrypted_payload,payload_nonce,encrypted_data_key,payload_size,version) VALUES(1,$1,'active','cipher','nonce','wrapped',6,3),(2,$2,'active','cipher','nonce','wrapped',6,3),(3,$1,'invalidated','','','',0,5)",[owner,foreign])
  let enabled=false
  const remove=createCredentialDeletion(runtime.db,()=>enabled)
  await assert.rejects(remove(owner,1),(error:unknown)=>(error as {statusCode:number}).statusCode===403)
  enabled=true
  await assert.rejects(remove(owner,2),(error:unknown)=>(error as {code:string}).code==='not_found')
  await remove(owner,3)
  assert.equal((await pool.query('SELECT status FROM provider_reasoning_states WHERE id=1')).rows[0].status,'active')
  await remove(owner,1)
  const rows=(await pool.query('SELECT * FROM provider_reasoning_states ORDER BY id')).rows
  assert.equal(rows[0].status,'invalidated');assert.equal(rows[0].version,4)
  assert.equal(rows[0].invalidated_reason,'config_changed')
  assert.equal(rows[0].encrypted_payload,'');assert.equal(rows[0].payload_nonce,'');assert.equal(rows[0].encrypted_data_key,'');assert.equal(rows[0].payload_size,0)
  assert.equal(rows[1].status,'active');assert.equal(rows[2].version,5)
  await pool.query('DROP TABLE provider_reasoning_states')
  await assert.rejects(remove(owner,4))
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_provider_credentials WHERE id=4')).rows[0].count,1)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

import Fastify from 'fastify'
import {registerCredentialDeleteRoute} from '../../src/modules/byok/credential-delete.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
import {CoreError} from '@gugu/core'

test('删除凭据HTTP拒绝未认证、验证整数并保持204和404语义',async()=>{
 const app=Fastify();installHttpErrorHandler(app)
 const calls:unknown[][]=[]
 registerCredentialDeleteRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},ownerIdFromRequest:()=> 'trusted-owner',remove:async(owner,id)=>{calls.push([owner,id]);if(id===2)throw new CoreError('not_found','凭据不存在')}})
 try{
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/byok/1'})).statusCode,401)
  assert.deepEqual(calls,[])
  const invalid=await app.inject({method:'DELETE',url:'/api/v1/byok/bad',headers:{authorization:'user'}})
  assert.equal(invalid.statusCode,422);assert.deepEqual(calls,[])
  const removed=await app.inject({method:'DELETE',url:'/api/v1/byok/1',headers:{authorization:'user'}})
  assert.equal(removed.statusCode,204);assert.equal(removed.body,'');assert.deepEqual(calls,[['trusted-owner',1]])
  const absent=await app.inject({method:'DELETE',url:'/api/v1/byok/2',headers:{authorization:'user'}})
  assert.equal(absent.statusCode,404);assert.deepEqual(absent.json(),{detail:'凭据不存在'})
 }finally{await app.close()}
})
