import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {createImRuntimeBindingStore} from '../../../../src/modules/im/gateway/agent/store.js'

const url=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('真实PG：模型usage加密冻结/并发重放不覆写，冲突/跨scope/错密钥/密文篡改均拒绝，持锁client读取不争池或死锁',{skip:!url&&'需要显式隔离PG'},async()=>{
 const {Pool}=await import('pg'),schema=`im_binding_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:1})
 const owner=randomUUID(),other=randomUUID(),identity={ownerId:owner,sessionId:'1',runId:'synthetic-binding-run'},secret=randomUUID()
 const binding={modelIdentity:'synthetic-provider/model',accessVersion:'a'.repeat(64),usage:{byokEnabled:false,localDeployment:true,isByok:false,model:'synthetic-model',provider:'synthetic-provider',defaultLimit6h:null}}
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid)')
  await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other]);await pool.query('INSERT INTO conversation_sessions VALUES(1,$1),(2,$1),(3,$2)',[owner,other])
  await pool.query(imGatewaySql.production)
  const store=createImRuntimeBindingStore(pool,secret)
  await Promise.all([store.freeze(identity,binding),store.freeze(identity,structuredClone(binding))])
  assert.deepEqual(await store.read(identity),{v:1,...binding})
  const row=(await pool.query('SELECT nonce,payload FROM gugu_im_runtime_bindings WHERE session_id=1')).rows[0]!
  assert.ok(!row.payload.includes(Buffer.from(binding.modelIdentity)));assert.ok(!row.payload.includes(Buffer.from(binding.usage.model)))
  await assert.rejects(store.freeze(identity,{...binding,modelIdentity:'conflicting-model'}),/IM 持久模型绑定不可用/u)
  assert.deepEqual((await pool.query('SELECT nonce,payload FROM gugu_im_runtime_bindings WHERE session_id=1')).rows[0],row)
  await assert.rejects(createImRuntimeBindingStore(pool,'synthetic-wrong-key').read(identity),/IM 持久模型绑定不可用/u)
  await assert.rejects(store.read({...identity,runId:'other-run'}),/IM 持久模型绑定不可用/u)
  for(const target of [{...identity,sessionId:'2'},{...identity,ownerId:other,sessionId:'3'}]){
   await pool.query('INSERT INTO gugu_im_runtime_bindings(user_id,session_id,run_id,nonce,payload) VALUES($1,$2,$3,$4,$5)',[target.ownerId,target.sessionId,target.runId,row.nonce,row.payload])
   await assert.rejects(store.read(target),/IM 持久模型绑定不可用/u)
  }
  const client=await pool.connect()
  try{
   await client.query('BEGIN');await client.query('SELECT id FROM conversation_sessions WHERE id=1 FOR UPDATE')
   let timer:ReturnType<typeof setTimeout>|undefined
   try{assert.deepEqual(await Promise.race([store.read(identity,client),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('同client绑定读取被错误池查询阻塞')),1000)})]),{v:1,...binding})}
   finally{if(timer)clearTimeout(timer)}
   await client.query('ROLLBACK')
  }finally{client.release()}
  await pool.query('UPDATE gugu_im_runtime_bindings SET payload=set_byte(payload,0,get_byte(payload,0)#1) WHERE session_id=1')
  await assert.rejects(store.read(identity),/IM 持久模型绑定不可用/u)
  await assert.rejects(store.freeze({...identity,ownerId:other,sessionId:'1'},binding),/IM 持久模型绑定不可用/u)
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
})
