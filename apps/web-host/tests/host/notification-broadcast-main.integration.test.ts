import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {Pool} from 'pg'
import {tablesSql} from '../../../../packages/core/src/data/schema.js'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redis=process.env.GUGU_WEBUI_TEST_REDIS_URL
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port}

test('生产广播真实PG/Redis/SSE闭环，定向隔离且离线上线可补弹，无Redis仍落库', {skip:(!url||!redis)&&'需要隔离PG/Redis',timeout:20000},async()=>{
 const schema=`notification_broadcast_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(url!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString()}),root=await mkdtemp(join(tmpdir(),'gugu-broadcast-'))
 let host:Awaited<ReturnType<typeof startServer>>|undefined,offline:Awaited<ReturnType<typeof startServer>>|undefined
 const abort=new AbortController()
 try{
  await pool.query(tablesSql('postgres').siteNotifications)
  await pool.query(tablesSql('postgres').notificationReads)
  await pool.query(tablesSql('postgres').notificationDismissals)
  await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,username text,email text,is_active boolean,account_status text,security_version integer,avatar text,created_at timestamptz,timezone text,email_subscribed boolean,display_name text,last_active_at timestamptz);
   CREATE TABLE user_bots(id integer,user_id uuid,platform text,enabled boolean);
   CREATE TABLE audit_logs(id serial PRIMARY KEY,username text,action text,description text,ip text,created_at timestamptz)`)
  const owner=randomUUID(),other=randomUUID();await pool.query("INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at) VALUES($1,'小北','a@example.test',true,'active',1,'2025-01-01'),($2,'小月','b@example.test',true,'active',1,'2025-01-01')",[owner,other])
  const override=join(root,'config.json');await writeFile(override,'{}')
  const secret='synthetic-broadcast-secret',port=await freePort(),env={GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(port),GUGU_WEBUI_REDIS_URL:redis!,STORAGE__LOCAL_PATH:root,ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'}
  host=await startServer(env)
  const auth={authorization:`Bearer ${signedUserToken(secret,owner)}`},foreign={authorization:`Bearer ${signedUserToken(secret,other)}`}
  const stream=await fetch(`http://127.0.0.1:${port}/api/v1/live/stream`,{headers:auth,signal:abort.signal});assert.equal(stream.status,200)
  const reader=stream.body!.getReader(),decoder=new TextDecoder();assert.match(decoder.decode((await reader.read()).value),/connected/)
  assert.equal((await host.app.inject({method:'POST',url:'/api/v1/admin/notifications/broadcast',payload:{content:'合成通知'}})).statusCode,401)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200)
  const headers={authorization:`Bearer ${login.json().access_token}`}
  const payload={title:'合成标题',content:'合成通知',color:'#abc',bubble:true,persist:false}
  const all=await host.app.inject({method:'POST',url:'/api/v1/admin/notifications/broadcast',headers,payload});assert.equal(all.statusCode,200)
  const frame=decoder.decode((await reader.read()).value);assert.match(frame,/data:/);assert.deepEqual(JSON.parse(frame.split('data: ')[1]!.trim()),{notification:{id:all.json().id,...payload}})
  const direct=await host.app.inject({method:'POST',url:'/api/v1/admin/notifications/broadcast',headers,payload:{...payload,target:owner}});assert.equal(direct.statusCode,200)
  assert.equal(JSON.parse(decoder.decode((await reader.read()).value).split('data: ')[1]!.trim()).notification.id,direct.json().id)
  assert.equal((await host.app.inject({url:'/api/v1/notifications/bubble',headers:auth})).json().bubble.id,direct.json().id)
  assert.equal((await host.app.inject({url:'/api/v1/notifications/bubble',headers:foreign})).json().bubble.id,all.json().id)
  assert.deepEqual((await host.app.inject({url:'/api/v1/notifications',headers:auth})).json(),[])
  assert.equal((await host.app.inject({method:'POST',url:'/api/v1/admin/notifications/broadcast',headers,payload:{}})).statusCode,400)
  const typed=await host.app.inject({method:'POST',url:'/api/v1/admin/notifications/broadcast',headers,payload:{content:'类型兼容',bubble:'true',persist:'false',bubble_ttl_hours:'2.0'}});assert.equal(typed.statusCode,200)
  abort.abort();await reader.cancel().catch(()=>undefined)
  offline=await startServer({...env,GUGU_WEBUI_REDIS_URL:'',GUGU_WEBUI_PORT:String(await freePort())})
  const offlineLogin=await offline.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  const stored=await offline.app.inject({method:'POST',url:'/api/v1/admin/notifications/broadcast',headers:{authorization:`Bearer ${offlineLogin.json().access_token}`},payload:{content:'离线通知'}})
  assert.equal(stored.statusCode,200);assert.equal((await pool.query('SELECT id FROM site_notifications WHERE id=$1',[stored.json().id])).rows.length,1)
 }finally{abort.abort();await offline?.close();await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
