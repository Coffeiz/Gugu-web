import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {Pool} from 'pg'
import {withPostgresTransaction} from '../../src/adapters/postgres-transaction.js'
import {createDataExportCreator} from '../../../../packages/core/src/data-portability/create-export.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('导出创建按用户锁执行幂等和跨导入导出互斥，并发不同请求不产生双任务', {skip:!url&&'需要隔离PG'},async()=>{
 const schema=`export_create_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4}),owner=randomUUID(),other=randomUUID()
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE data_export_jobs(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),status text,stage text,options json,idempotency_key text,progress_current integer,progress_total integer,error_code text,artifact_key text,artifact_size bigint,created_at timestamptz,expires_at timestamptz,updated_at timestamptz,UNIQUE(user_id,idempotency_key));CREATE TABLE data_import_jobs(id uuid PRIMARY KEY,user_id uuid,status text)')
  await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
  const create=createDataExportCreator(work=>withPostgresTransaction(pool,client=>work((sql,params)=>client.query(sql,params))),(sql,params)=>pool.query(sql,params),{now:()=>new Date('2026-01-01T00:00:00Z'),uuid:randomUUID})
  const first=await create(owner,['projects','account','projects'],'synthetic-request-1')
  assert.equal(first.status,'queued');assert.equal(first.expires_at,'2026-01-02T00:00:00+00:00')
  assert.equal((await create(owner,['account','projects'],'synthetic-request-1')).id,first.id)
  await assert.rejects(create(owner,['clients'],'synthetic-request-1'),/此幂等键已用于不同的导出范围/)
  await assert.rejects(create(owner,['projects'],'synthetic-request-2'),/已有数据迁移任务正在处理/)
  await assert.rejects(create(owner,['archive_docs'],'synthetic-invalid-1'),/导出类别无效/)
  await pool.query("UPDATE data_export_jobs SET status='ready' WHERE user_id=$1",[owner])
  await pool.query("INSERT INTO data_import_jobs VALUES($1,$2,'needs_recovery')",[randomUUID(),owner])
  await assert.rejects(create(owner,['projects'],'synthetic-request-3'),/已有数据迁移任务正在处理/)
  const race=await Promise.allSettled([create(other,['projects'],'synthetic-other-1'),create(other,['projects'],'synthetic-other-2')]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM data_export_jobs WHERE user_id=$1',[other])).rows[0].count,1)
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
