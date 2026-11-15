import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {createPostgresRuntime} from '../../../../packages/core/src/data/postgres.js'
import {createQqBotCreator} from '../../../../packages/core/src/im/user-bot-create.js'
import {createUserBotDeleter} from '../../../../packages/core/src/im/user-bot-delete.js'
import {createRedisUserBotReachCleaner,createRedisScheduledTaskCommands,createRedisValueReader} from '../../src/adapters/redis-events.js'
import {encryptEncryptedString,decryptEncryptedString} from '../../src/adapters/encrypted-string.js'
test('Bot删除真实PG/Redis保护owner、清平台与匹配最近reach，提交后失效IM快照并广播',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisBase=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(redisBase);assert.ok(python)
 const schema=`bot_delete_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1}),root=await mkdtemp(join(tmpdir(),'bot-delete-')),owner=randomUUID(),other=randomUUID(),secret='synthetic-bot-delete-secret';await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4}),runtime=await createPostgresRuntime({url,schema}),redisUrl=new URL(redisBase);redisUrl.pathname='/8'
 const commands=createRedisScheduledTaskCommands(redisUrl.toString()),read=createRedisValueReader(redisUrl.toString()),clean=createRedisUserBotReachCleaner(redisUrl.toString()),keys=[owner,other].flatMap(id=>[`imreach:${id}:qq`,`imreach:${id}`])
 try{
  const path=join(root,'override.json');await writeFile(path,JSON.stringify({secret_key:secret,im:{qq:true}}))
  execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:path,GUGU_WEBUI_TEST_DATABASE_URL:url,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other,TEST_SECRET:secret},encoding:'utf8'})
  const create=createQqBotCreator(runtime.db,{encrypt:v=>encryptEncryptedString(secret,v),decrypt:v=>decryptEncryptedString(secret,v),platforms:()=>['qq'],publishChanged:async()=>{}})
  const first=await create(owner,{app_id:'synthetic-app',app_secret:'synthetic-secret'}),second=await create(other,{app_id:'other-app',app_secret:'other-secret'})
  await pool.query("UPDATE conversation_sessions SET context_epoch=4,snapshot_expires_at=clock_timestamp()+interval '1 day'")
  for(const id of [owner,other]){await commands.eval("return redis.call('SET',KEYS[1],ARGV[1])",1,`imreach:${id}:qq`,JSON.stringify({platform:'qq',puid:'synthetic-private-id'}));await commands.eval("return redis.call('SET',KEYS[1],ARGV[1])",1,`imreach:${id}`,JSON.stringify({platform:id===owner?'qq':'telegram',puid:'synthetic-private-id'}))}
  const published:string[]=[]
  const remove=createUserBotDeleter(runtime.db,{clearReach:clean,publishChanged:async who=>{assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_bots WHERE user_id=$1',[who])).rows[0].n,0);published.push(who)}})
  await assert.rejects(()=>remove(other,first.id as number),/机器人不存在/);assert.ok(await read(`imreach:${owner}`));assert.equal(published.length,0)
  await remove(owner,first.id as number);assert.equal(await read(`imreach:${owner}:qq`),null);assert.equal(await read(`imreach:${owner}`),null);assert.ok(await read(`imreach:${other}`));assert.deepEqual(published,[owner])
  const snapshots=(await pool.query('SELECT source,context_epoch,snapshot_hash,session_info_hash,snapshot_expires_at<clock_timestamp() AS expired FROM conversation_sessions WHERE user_id=$1 ORDER BY source',[owner])).rows
  for(const row of snapshots){assert.equal(row.context_epoch,row.source==='web'?4:5);assert.equal(row.expired,row.source!=='web');assert.equal(row.snapshot_hash,'synthetic-snapshot');assert.equal(row.session_info_hash,'synthetic-session')}
  const reference=JSON.parse(execFileSync(python,[resolve('tests/im/fixtures/user_bot_delete_python.py'),'--allow-isolated-test-delete-reference'],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:path,GUGU_WEBUI_TEST_DATABASE_URL:url,TEST_SCHEMA:schema,TEST_REDIS_URL:redisUrl.toString()},encoding:'utf8'}));assert.deepEqual(reference,{deleted:true,platform_reach:null,recent_reach:null,calls:[{resources:['im_channels'],operation:'refresh'}],snapshots})
  await assert.rejects(()=>remove(owner,first.id as number),/机器人不存在/);assert.deepEqual(published,[owner])
  await remove(other,second.id as number);assert.equal(await read(`imreach:${other}:qq`),null);assert.equal(JSON.parse((await read(`imreach:${other}`))!).platform,'telegram')
  await commands.eval("redis.call('SET',KEYS[1],ARGV[1]);redis.call('SET',KEYS[2],ARGV[2]);return 1",2,`imreach:${owner}:qq`,`imreach:${owner}`,'synthetic-platform','broken-json');await clean(owner,'qq');assert.equal(await read(`imreach:${owner}:qq`),null);assert.equal(await read(`imreach:${owner}`),'broken-json')
  const again=await create(owner,{app_id:'again-app',app_secret:'again-secret'});let attempted=0;const failedServices=createUserBotDeleter(runtime.db,{clearReach:async()=>{throw Error('synthetic redis failure')},publishChanged:async()=>{attempted++;throw Error('synthetic live failure')}});await failedServices(owner,again.id as number);assert.equal(attempted,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_bots WHERE id=$1',[again.id])).rows[0].n,0)
 }finally{await commands.eval("return redis.call('DEL',unpack(KEYS))",keys.length,...keys);await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
