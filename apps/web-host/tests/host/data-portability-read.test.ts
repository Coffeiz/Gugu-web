import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPortabilityJobReader } from '../../../../packages/core/src/data-portability/read-jobs.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner='00000000-0000-4000-8000-000000000001', foreign='00000000-0000-4000-8000-000000000002'
test('可移植任务状态查询隔离owner，列表限额及公开投影不泄漏内部路径和能力令牌', {skip:!url&&'需要隔离PG'}, async () => {
  const schema=`portability_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:url}); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`})
  try {
    await pool.query('CREATE TABLE data_export_jobs(id uuid PRIMARY KEY,user_id uuid,status text,stage text,progress_current integer,progress_total integer,error_code text,artifact_key text,artifact_size bigint,created_at timestamptz,expires_at timestamptz)')
    await pool.query('CREATE TABLE data_import_jobs(id uuid PRIMARY KEY,user_id uuid,status text,stage text,mode text,progress_current integer,progress_total integer,error_code text,preview jsonb,created_at timestamptz,expires_at timestamptz,rollback_expires_at timestamptz,import_token_hash text,staging_key text)')
    const exports:string[]=[], imports:string[]=[]
    for(let i=0;i<22;i++) {
      const e=randomUUID(), m=randomUUID(); exports.push(e); imports.push(m)
      await pool.query("INSERT INTO data_export_jobs VALUES($1,$2,'ready',NULL,1,NULL,NULL,'synthetic-private-key',500,$3,NULL)",[e,owner,`2026-01-${String(i+1).padStart(2,'0')}T00:00:00.123456Z`])
      await pool.query("INSERT INTO data_import_jobs VALUES($1,$2,'preview_ready',NULL,'preflight',0,NULL,NULL,'{\"safe\":true}',$3,NULL,NULL,'synthetic-token-hash','synthetic-staging-key')",[m,owner,`2026-01-${String(i+1).padStart(2,'0')}T00:00:00.123456Z`])
    }
    const read=createPortabilityJobReader((sql,params)=>pool.query(sql,params))
    assert.equal((await read.listExports(owner)).length,10)
    assert.equal((await read.listImports(owner)).length,20)
    assert.equal((await read.listExports(owner))[0]!.id,exports[21])
    assert.deepEqual(await read.listExports(foreign),[])
    await assert.rejects(read.getExport(foreign,exports[0]!), /找不到此导出任务/)
    await assert.rejects(read.getImport(foreign,imports[0]!), /找不到此导入任务/)
    const e=await read.getExport(owner,exports[0]!)
    assert.equal(e.created_at,'2026-01-01T00:00:00.123456+00:00'); assert.equal(e.download_available,true)
    const m=await read.getImport(owner,imports[0]!)
    assert.deepEqual(m.preview,{safe:true})
    assert.doesNotMatch(JSON.stringify([e,m]), /synthetic-private-key|synthetic-token-hash|synthetic-staging-key/)
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
