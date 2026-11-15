import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createDataExportPreviewReader} from '@gugu/core/data-portability/export-preview'
test('导出预览正式PG全模型与实际Python handler等价，隔离关联owner/草稿引用，统计墓碑与字节且不写数据',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(python)
 const schema=`export_preview_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),root=await mkdtemp(join(tmpdir(),'export-preview-')),path=join(root,'override.json'),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:1}),runtime=await createPostgresRuntime({url,schema});await writeFile(path,JSON.stringify({secret_key:'synthetic-export-preview-key'}))
 const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:join(root,'absent.env'),GUGU_CONFIG_OVERRIDE_FILE:path,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}
 const bridge=(action:string,who=owner)=>JSON.parse(execFileSync(python,[resolve('tests/portability/fixtures/export_preview_python.py'),action],{cwd:resolve('../../backend'),env:{...env,TEST_OWNER:who,TEST_OTHER:who===owner?other:owner},encoding:'utf8',timeout:20000}))
 try{
  bridge('setup');const read=createDataExportPreviewReader(runtime.db),expected=bridge('preview');assert.deepEqual(await read(owner),expected);assert.deepEqual(await read(other),bridge('preview',other));assert.equal(expected.categories.files.bytes,42);assert.equal(expected.categories.conversations.bytes,8);assert.equal(expected.categories.connections.records,4);assert.equal(expected.categories.account.records,1);assert.equal(expected.categories.archive_docs.records,0)
  bridge('cross')
  assert.deepEqual(await read(owner),bridge('preview'));assert.equal((await read(owner)).categories.conversations.bytes,8);assert.equal((await read(owner)).categories.im_memory.records,2)
  await pool.query("UPDATE conversation_pending_queues SET items='[]'::json WHERE user_id=$1",[owner]);assert.deepEqual(await read(owner),bridge('preview'));assert.equal((await read(owner)).categories.conversations.bytes,3)
  await pool.query("UPDATE conversation_pending_queues SET items='\"legacy-json-string\"'::json WHERE user_id=$1",[owner]);assert.deepEqual(await read(owner),bridge('preview'))
  bridge('large');assert.deepEqual(await read(owner),bridge('preview'));assert.equal((await read(owner)).categories.conversations.bytes,10)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM data_portable_identities')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM data_export_jobs')).rows[0].n,0)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
