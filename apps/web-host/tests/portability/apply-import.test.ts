import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import {createDataImportApplier,createDataImportRollbackCreator,createDataImportRecoverer} from '@gugu/core/data-portability/apply-import'
import {withPostgresTransaction} from '../../src/adapters/database/postgres-transaction.js'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
test('真实PG导入确认保护owner/一次性token/模式/互斥/幂等及事务失败回滚',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(python)
 const schema=`apply_import_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4}),owner=randomUUID(),other=randomUUID(),token='synthetic-import-token-12345678901234567890'
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)');await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
  await pool.query(execFileSync(python,['-c',"from app.models import DataImportJob,DataExportJob;from sqlalchemy.schema import CreateTable;from sqlalchemy.dialects import postgresql;print(';'.join(str(CreateTable(m.__table__).compile(dialect=postgresql.dialect())) for m in [DataImportJob,DataExportJob]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/no-apply-config'}}))
  const insert=async()=>{const id=randomUUID();await pool.query("INSERT INTO data_import_jobs(id,user_id,mode,status,stage,import_token_hash,preview,progress_current,created_at,expires_at,updated_at) VALUES($1,$2,'preflight','preview_ready','preview_ready',$3,'{\"complete\":true,\"conflicts\":{\"total\":0}}',0,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp())",[id,owner,hash(token)]);return id}
  const apply=createDataImportApplier(work=>withPostgresTransaction(pool,c=>work((sql,args)=>c.query(sql,args))),(sql,args)=>pool.query(sql,args),{verify:(plain,expected)=>hash(plain)===expected})
  const id=await insert();await assert.rejects(()=>apply(other,id,'incremental',token,'synthetic-key'),/找不到此导入任务/);await assert.rejects(()=>apply(owner,id,'incremental','wrong-token-long-enough-123456789012','synthetic-key'),/导入确认令牌无效/);assert.equal((await pool.query('SELECT status FROM data_import_jobs WHERE id=$1',[id])).rows[0].status,'preview_ready')
  const responses=await Promise.all([1,2].map(()=>apply(owner,id,'incremental',token,'synthetic-key')));assert.equal(responses[0]!.status,'queued');assert.deepEqual(responses[0],responses[1]);assert.equal((await pool.query('SELECT import_token_hash FROM data_import_jobs WHERE id=$1',[id])).rows[0].import_token_hash,null)
  assert.doesNotMatch(JSON.stringify(responses),/import_token_hash|synthetic-import-token/);await assert.rejects(()=>apply(owner,id,'replace',token,'synthetic-key'),/导入预检尚未完成/)
  const second=await insert();await assert.rejects(()=>apply(owner,second,'replace',token,'second-key'),/已有数据迁移任务/);assert.equal((await pool.query('SELECT import_token_hash FROM data_import_jobs WHERE id=$1',[second])).rows[0].import_token_hash,hash(token));await pool.query("UPDATE data_import_jobs SET status='completed' WHERE id=$1",[id])
  await pool.query("UPDATE data_import_jobs SET preview='{\"complete\":false}' WHERE id=$1",[second]);await assert.rejects(()=>apply(owner,second,'replace',token,'second-key'),/全量替换需要完整归档/)
  await pool.query("UPDATE data_import_jobs SET preview='{\"complete\":true,\"conflicts\":{\"total\":1}}' WHERE id=$1",[second]);await assert.rejects(()=>apply(owner,second,'incremental',token,'second-key'),/归档中存在唯一键冲突/)
  await pool.query("UPDATE data_import_jobs SET preview='{\"complete\":true}' WHERE id=$1",[second]);assert.equal((await apply(owner,second,'replace',token,'second-key')).mode,'replace')
  await pool.query("UPDATE data_import_jobs SET status='completed' WHERE id=$1",[second]);const rollback=await insert();await pool.query(`CREATE FUNCTION reject_apply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${rollback}' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER reject_apply BEFORE UPDATE ON data_import_jobs FOR EACH ROW EXECUTE FUNCTION reject_apply()`)
  await assert.rejects(()=>apply(owner,rollback,'incremental',token,'rollback-key'));assert.equal((await pool.query('SELECT import_token_hash FROM data_import_jobs WHERE id=$1',[rollback])).rows[0].import_token_hash,hash(token))
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

 test('真实PG回滚任务保护owner、快照有效期、幂等和跨任务互斥',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(python)
 const schema=`rollback_import_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4}),owner=randomUUID(),other=randomUUID(),source=randomUUID()
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)');await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
  await pool.query(execFileSync(python,['-c',"from app.models import DataImportJob,DataExportJob;from sqlalchemy.schema import CreateTable;from sqlalchemy.dialects import postgresql;print(';'.join(str(CreateTable(m.__table__).compile(dialect=postgresql.dialect())) for m in [DataImportJob,DataExportJob]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/no-rollback-config'}}))
  await pool.query("INSERT INTO data_import_jobs(id,user_id,mode,status,stage,rollback_key,rollback_expires_at,progress_current,created_at,updated_at) VALUES($1,$2,'replace','completed','completed','synthetic-snapshot',clock_timestamp()+interval '1 hour',0,clock_timestamp(),clock_timestamp())",[source,owner])
  const rollback=createDataImportRollbackCreator(work=>withPostgresTransaction(pool,c=>work((sql,args)=>c.query(sql,args))),(sql,args)=>pool.query(sql,args),{uuid:randomUUID})
  await assert.rejects(()=>rollback(other,source,'synthetic-rollback-key'),/找不到此导入任务/)
  const values=await Promise.all([1,2].map(()=>rollback(owner,source,'synthetic-rollback-key')));assert.equal(values[0]!.id,values[1]!.id);assert.equal(values[0]!.mode,'rollback');assert.equal(values[0]!.status,'queued');assert.deepEqual(values[0]!.preview,{complete:true,rollback_of:source});assert.doesNotMatch(JSON.stringify(values),/synthetic-snapshot|rollback_key/)
  await assert.rejects(()=>rollback(owner,source,'different-rollback-key'),/已有数据迁移任务/)
  await pool.query("UPDATE data_import_jobs SET status='completed' WHERE id=$1",[values[0]!.id]);await pool.query("UPDATE data_import_jobs SET rollback_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[source]);await assert.rejects(()=>rollback(owner,source,'expired-rollback-key'),/替换快照不存在或已过期/)
  assert.equal((await rollback(owner,source,'synthetic-rollback-key')).id,values[0]!.id,'同幂等键重试不受后来过期影响')
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
 })

 test('真实PG显式恢复只重排所属needs_recovery且原子清旧租约与错误',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(python)
 const schema=`recover_import_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4}),owner=randomUUID(),other=randomUUID(),job=randomUUID()
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)');await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
  await pool.query(execFileSync(python,['-c',"from app.models import DataImportJob,DataExportJob;from sqlalchemy.schema import CreateTable;from sqlalchemy.dialects import postgresql;print(';'.join(str(CreateTable(m.__table__).compile(dialect=postgresql.dialect())) for m in [DataImportJob,DataExportJob]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/no-recover-config'}}))
  await pool.query("INSERT INTO data_import_jobs(id,user_id,mode,status,stage,staging_key,rollback_key,lease_owner,lease_until,error_code,progress_current,created_at,updated_at) VALUES($1,$2,'replace','needs_recovery','needs_recovery','synthetic-staging','synthetic-snapshot','dead-worker',clock_timestamp()+interval '1 day','replace_needs_recovery',0,clock_timestamp(),clock_timestamp())",[job,owner])
  const recover=createDataImportRecoverer(work=>withPostgresTransaction(pool,c=>work((sql,args)=>c.query(sql,args))),(sql,args)=>pool.query(sql,args))
  await assert.rejects(()=>recover(other,job),/找不到此导入任务/)
  const responses=await Promise.allSettled([recover(owner,job),recover(owner,job)]);assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);assert.equal(responses.filter(r=>r.status==='rejected').length,1)
  const row=(await pool.query('SELECT status,stage,lease_owner,lease_until,error_code,staging_key,rollback_key FROM data_import_jobs WHERE id=$1',[job])).rows[0];assert.deepEqual(row,{status:'queued',stage:'needs_recovery',lease_owner:null,lease_until:null,error_code:null,staging_key:'synthetic-staging',rollback_key:'synthetic-snapshot'})
  for(const mutation of ["mode='incremental'","staging_key=NULL","rollback_key=NULL"]){await pool.query("UPDATE data_import_jobs SET status='needs_recovery',mode='replace',staging_key='synthetic-staging',rollback_key='synthetic-snapshot' WHERE id=$1",[job]);await pool.query(`UPDATE data_import_jobs SET ${mutation} WHERE id=$1`,[job]);await assert.rejects(()=>recover(owner,job),/此任务当前不需要恢复或恢复数据不完整/)}
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
 })
