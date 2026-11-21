import assert from 'node:assert/strict'
import test from 'node:test'
import type {LightMyRequestResponse} from 'fastify'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {Pool} from 'pg'
import {startServer} from '../../../../src/main.js'
import {signedUserToken} from '../../../helpers/auth.js'
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产导出预览排除文件库并保持其余历史统计，owner隔离、只读且不要求Redis',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(databaseUrl);assert.ok(python)
 const schema=`export_preview_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),root=await mkdtemp(join(tmpdir(),'export-preview-')),path=join(root,'override.json'),secret='synthetic-export-preview-key',admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`);const pool=new Pool({connectionString:scoped.toString(),max:1});let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  const original=JSON.stringify({secret_key:secret,other:{keep:true}});await writeFile(path,original)
  const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:join(root,'absent.env'),GUGU_CONFIG_OVERRIDE_FILE:path,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other},bridge=(action:string,uid=owner)=>JSON.parse(execFileSync(python,[resolve('tests/portability/fixtures/export_preview_python.py'),action],{cwd:resolve('../../backend'),env:{...env,TEST_OWNER:uid,TEST_OTHER:uid===owner?other:owner},encoding:'utf8',timeout:20000}))
  bridge('setup');await pool.query('UPDATE files SET size_bytes=999 WHERE user_id=$1',[other]);host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:''})
  const url='/api/v1/data-portability/export/preview';assert.equal((await host.app.inject(url)).statusCode,401)
  for(const uid of [owner,other]){const response:LightMyRequestResponse=await host.app.inject({method:'GET',url:url+'?owner='+other,headers:{authorization:`Bearer ${signedUserToken(secret,uid)}`}});assert.equal(response.statusCode,200,response.body);const expected=bridge('preview',uid);delete expected.categories.files;assert.deepEqual(response.json(),expected);assert.equal(response.body.includes('synthetic'),false)}
  assert.equal(await readFile(path,'utf8'),original);assert.equal((await pool.query('SELECT count(*)::int AS n FROM data_portable_identities')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM data_export_jobs')).rows[0].n,0)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
