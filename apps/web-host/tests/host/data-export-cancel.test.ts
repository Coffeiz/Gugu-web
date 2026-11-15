import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {Pool} from 'pg'
import {withPostgresTransaction} from '../../src/adapters/postgres-transaction.js'
import {createDataExportCanceler} from '@gugu/core/data-portability/cancel-export'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('取消导出按owner行锁转换状态，过期不阻止取消，终态拒绝且并发仅一次成功', {skip:!url&&'需要隔离PG'},async()=>{
 const schema=`export_cancel_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4}),owner=randomUUID(),foreign=randomUUID()
 try{
  await pool.query('CREATE TABLE data_export_jobs(id uuid PRIMARY KEY,user_id uuid,status text,stage text,progress_current integer,progress_total integer,error_code text,artifact_key text,artifact_size bigint,created_at timestamptz,expires_at timestamptz,finished_at timestamptz,updated_at timestamptz)')
  const cancel=createDataExportCanceler(work=>withPostgresTransaction(pool,client=>work((sql,params)=>client.query(sql,params))),(sql,params)=>pool.query(sql,params),()=>new Date('2026-01-02T00:00:00Z'))
  const ids:Record<string,string>={}
  for(const state of ['queued','running','ready']){const id=randomUUID();ids[state]=id;await pool.query("INSERT INTO data_export_jobs(id,user_id,status,stage,progress_current,created_at,expires_at) VALUES($1,$2,$3,$3,0,'2026-01-01','2026-01-01')",[id,owner,state])}
  await assert.rejects(cancel(foreign,ids.queued!),/找不到此导出任务/)
  const race=await Promise.allSettled([cancel(owner,ids.queued!),cancel(owner,ids.queued!)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
  const canceled=(await pool.query('SELECT * FROM data_export_jobs WHERE id=$1',[ids.queued])).rows[0];assert.equal(canceled.status,'canceled');assert.equal(canceled.finished_at.toISOString(),'2026-01-02T00:00:00.000Z')
  assert.equal((await cancel(owner,ids.running!)).status,'canceling')
  assert.equal((await pool.query('SELECT finished_at FROM data_export_jobs WHERE id=$1',[ids.running])).rows[0].finished_at,null)
  await assert.rejects(cancel(owner,ids.ready!),/此任务当前不能取消/)
  const doomed=randomUUID();await pool.query("INSERT INTO data_export_jobs(id,user_id,status,stage,progress_current,created_at) VALUES($1,$2,'queued','queued',0,CURRENT_TIMESTAMP)",[doomed,owner])
  const failed=createDataExportCanceler(work=>withPostgresTransaction(pool,client=>work(async(sql,params)=>{const result=await client.query(sql,params);if(sql.startsWith('UPDATE'))throw new Error('合成事务故障');return result})),(sql,params)=>pool.query(sql,params))
  await assert.rejects(failed(owner,doomed),/合成事务故障/);assert.equal((await pool.query('SELECT status FROM data_export_jobs WHERE id=$1',[doomed])).rows[0].status,'queued')
  const deleted=createDataExportCanceler(async work=>{const value=await withPostgresTransaction(pool,client=>work((sql,params)=>client.query(sql,params)));await pool.query('DELETE FROM data_export_jobs WHERE id=$1',[doomed]);return value},(sql,params)=>pool.query(sql,params))
  await assert.rejects(deleted(owner,doomed),error=>!!error&&typeof error==='object'&&'code' in error&&error.code==='storage_error')
  const finishing=randomUUID();await pool.query("INSERT INTO data_export_jobs(id,user_id,status,stage,progress_current,created_at) VALUES($1,$2,'running','running',0,CURRENT_TIMESTAMP)",[finishing,owner])
  const completed=createDataExportCanceler(async work=>{const value=await withPostgresTransaction(pool,client=>work((sql,params)=>client.query(sql,params)));await pool.query("UPDATE data_export_jobs SET status='canceled',stage='canceled' WHERE id=$1 AND status='canceling'",[finishing]);return value},(sql,params)=>pool.query(sql,params))
  assert.equal((await completed(owner,finishing)).status,'canceled')
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
