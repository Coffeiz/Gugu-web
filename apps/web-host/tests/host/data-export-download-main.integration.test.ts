import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import test from 'node:test'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
import {writePythonPortableArchive} from '../helpers/portable-archive.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON
async function port(){const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()));return address.port}

test('生产导出下载与HttpOnly票据完整闭环，权限/过期/Range/完整性失败不改记录或文件', {skip:(!url||!python)&&'需要隔离PG/Python'},async()=>{
 const schema=`export_download_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(url!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString()}),root=await mkdtemp(join(tmpdir(),'gugu-export-download-main-'))
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,username text,email text,is_active boolean,account_status text,security_version integer,avatar text,created_at timestamptz,timezone text,email_subscribed boolean,display_name text,last_active_at timestamptz);
   CREATE TABLE user_bots(id integer,user_id uuid,platform text,enabled boolean);
   CREATE TABLE data_export_jobs(id uuid PRIMARY KEY,user_id uuid,status text,artifact_key text,artifact_size bigint,artifact_sha256 text,expires_at timestamptz)`)
  const owner=randomUUID(),other=randomUUID(),job=randomUUID(),key=`${owner.replaceAll('-','')}/.data-portability/exports/${job.replaceAll('-','')}.gupa`,path=join(root,key),plain=Buffer.from('synthetic ZIP download bytes for authenticated Range')
  await mkdir(dirname(path),{recursive:true});writePythonPortableArchive(path,`data-portability:${owner.replaceAll('-','')}:${job.replaceAll('-','')}`,plain)
  const encrypted=await readFile(path),sha=createHash('sha256').update(encrypted).digest('hex')
  await pool.query("INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at) VALUES($1,'小北','a@example.test',true,'active',1,'2025-01-01'),($2,'小月','b@example.test',true,'active',1,'2025-01-01')",[owner,other])
  await pool.query("INSERT INTO data_export_jobs VALUES($1,$2,'ready',$3,$4,$5,$6)",[job,owner,key,encrypted.length,sha,new Date(Date.now()+3600000).toISOString()])
  const override=join(root,'config.json');await import('node:fs/promises').then(fs=>fs.writeFile(override,'{}'))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:'synthetic-secret',GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await port()),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:root})
  const headers={authorization:`Bearer ${signedUserToken('synthetic-secret',owner)}`},foreign={authorization:`Bearer ${signedUserToken('synthetic-secret',other)}`},base=`/api/v1/data-portability/exports/${job}`
  assert.equal((await host.app.inject({url:`${base}/download`})).statusCode,401)
  assert.equal((await host.app.inject({url:`${base}/download`,headers:foreign})).statusCode,404)
  const ranged=await host.app.inject({url:`${base}/download`,headers:{...headers,range:'bytes=-7'}});assert.equal(ranged.statusCode,206);assert.deepEqual(ranged.rawPayload,plain.subarray(-7));assert.equal(ranged.headers['content-range'],`bytes ${plain.length-7}-${plain.length-1}/${plain.length}`)
  assert.equal(ranged.headers['cache-control'],'no-store');assert.equal(ranged.headers['x-content-type-options'],'nosniff')
  const invalidRange=await host.app.inject({url:`${base}/download`,headers:{...headers,range:'bytes=999999-'}});assert.equal(invalidRange.statusCode,416);assert.equal(invalidRange.headers['content-range'],`bytes */${plain.length}`)
  const ticket=await host.app.inject({method:'POST',url:`${base}/download-ticket`,headers});assert.equal(ticket.statusCode,200);assert.deepEqual(ticket.json(),{url:`${base}/download/browser`})
  const cookie=String(ticket.headers['set-cookie']);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Max-Age=120/);assert.match(cookie,/SameSite=Lax/);assert.ok(cookie.includes(`Path=${base}/download/browser`));assert.doesNotMatch(ticket.json().url,/secret|ticket=|token=/)
  const onlyCookie={cookie:cookie.split(';')[0]!}
  for(let attempt=0;attempt<2;attempt++){const downloaded:{statusCode:number;rawPayload:Buffer}=await host.app.inject({url:ticket.json().url,headers:onlyCookie});assert.equal(downloaded.statusCode,200);assert.deepEqual(downloaded.rawPayload,plain)}
  assert.equal((await host.app.inject({url:`${base}/download/browser`})).statusCode,401)
  assert.equal((await host.app.inject({url:`${base}/download/browser`,headers:{cookie:`${onlyCookie.cookie}x`}})).statusCode,401)
  assert.equal((await host.app.inject({url:`/api/v1/data-portability/exports/${randomUUID()}/download/browser`,headers:onlyCookie})).statusCode,401)
  await pool.query("UPDATE data_export_jobs SET artifact_sha256='wrong' WHERE id=$1",[job]);assert.equal((await host.app.inject({url:`${base}/download`,headers})).statusCode,410)
  assert.deepEqual(await readFile(path),encrypted);assert.equal((await pool.query('SELECT status FROM data_export_jobs WHERE id=$1',[job])).rows[0].status,'ready')
  await pool.query('UPDATE data_export_jobs SET artifact_sha256=$2,expires_at=$3 WHERE id=$1',[job,sha,new Date(Date.now()-1000).toISOString()])
  assert.equal((await host.app.inject({url:`${base}/download`,headers})).statusCode,404);assert.equal((await host.app.inject({method:'POST',url:`${base}/download-ticket`,headers})).statusCode,404)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
