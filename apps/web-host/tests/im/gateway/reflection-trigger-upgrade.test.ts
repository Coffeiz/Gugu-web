import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {createImProductionFixture} from './production.fixtures.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
test('隔离PG：旧反思唯一键显式升级保留任务字节，同Run多窗口可共存且重复升级幂等',{
 skip:!(databaseUrl&&python)&&'需要显式隔离PG与离线ORM解释器',timeout:90000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!})
 try{
  const session=await f.insert('conversation_sessions',{user_id:f.ownerId,source:'telegram',bot_id:f.botId,chat_type:'group',chat_id:'synthetic-upgrade-group'})
  const id=randomUUID(),nonce=Buffer.alloc(12,7),payload=Buffer.from('synthetic-encrypted-job-payload')
  await f.pool.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,state,nonce,payload)
   VALUES($1,$2,$3,'synthetic-upgrade-run',$4,0,'pending',$5,$6)`,[id,f.ownerId,session.id,'a'.repeat(64),nonce,payload])
  // 仅在本fixture随机schema重现旧版本列/唯一约束；不对任何既有用户库执行DDL。
  await f.pool.query('ALTER TABLE gugu_im_reflection_jobs DROP COLUMN window_key')
  await f.pool.query('ALTER TABLE gugu_im_reflection_jobs ADD CONSTRAINT synthetic_old_reflection_unique UNIQUE(user_id,session_id,run_id,scope_hash)')
  await f.pool.query('DROP TABLE gugu_im_reflection_cursor_positions')
  await f.pool.query("INSERT INTO gugu_im_reflection_run_revisions(user_id,session_id,run_id,owner_revision,scope_versions) VALUES($1,$2,'synthetic-upgrade-run',0,'{}')",[f.ownerId,session.id])
  await f.pool.query('ALTER TABLE gugu_im_reflection_run_revisions DROP COLUMN scope_versions')
  await f.pool.query(`INSERT INTO gugu_im_reflection_trigger_windows(id,user_id,session_id,owner_revision,through_message_id,through_message_seq,scope_versions,reason)
    VALUES($1,$2,$3,0,1,1,'{}','threshold')`,[randomUUID(),f.ownerId,session.id])
  await f.pool.query('ALTER TABLE gugu_im_reflection_trigger_windows DROP COLUMN scope_versions')
  const migration=await readFile(new URL('../../../src/modules/im/gateway/reflection-trigger-upgrade.sql',import.meta.url),'utf8')
  await f.pool.query(migration);await f.pool.query(migration)
  const preserved=(await f.pool.query('SELECT nonce,payload,window_key FROM gugu_im_reflection_jobs WHERE id=$1',[id])).rows[0]
  assert.deepEqual(preserved,{nonce,payload,window_key:'run'})
  assert.equal((await f.pool.query('SELECT scope_versions FROM gugu_im_reflection_run_revisions')).rows[0].scope_versions,null,'不能给旧Run事后补当前scope权限')
  assert.deepEqual((await f.pool.query('SELECT status,scope_versions FROM gugu_im_reflection_trigger_windows')).rows,[{status:'cancelled',scope_versions:{}}])
  await f.pool.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,window_key,state,nonce,payload)
   VALUES($1,$2,$3,'synthetic-upgrade-run',$4,0,'synthetic-second-window','pending',$5,$6)`,[randomUUID(),f.ownerId,session.id,'a'.repeat(64),nonce,payload])
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM gugu_im_reflection_jobs')).rows[0].n,2)
  assert.ok((await f.pool.query("SELECT to_regclass('gugu_im_reflection_cursor_positions') AS name")).rows[0].name)
 }finally{await f.close()}
})
