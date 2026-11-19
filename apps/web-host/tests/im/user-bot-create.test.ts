import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {createPostgresRuntime} from '../../../../packages/core/src/data/postgres.js'
import {createQqBotCreator,invalidateOwnerImSnapshots} from '../../../../packages/core/src/im/user-bot-create.js'
import {encryptEncryptedString,decryptEncryptedString} from '../../src/adapters/security/encrypted-string.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('QQ创建实际加密持久化、owner并发隔离，Python gateway读取及IM快照失效协议', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`qq_create_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-qq-create-')),owner=randomUUID(),other=randomUUID(),secret='synthetic-qq-encryption-secret'
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:4}),runtime=await createPostgresRuntime({url:databaseUrl!,schema}),db=runtime.db,override=join(root,'config.json')
 await writeFile(override,JSON.stringify({secret_key:secret,im:{qq:true}}))
 const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:override,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other,TEST_SECRET:secret}
 const bridge=(action:string,extra:Record<string,string>={})=>JSON.parse(execFileSync(python!,[resolve('../../compat/support/qq_bot_create.py'),action],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,...extra},timeout:20000}))
 try{
  bridge('setup')
  let enabled=true,publications=0
  const create=createQqBotCreator(db,{encrypt:value=>encryptEncryptedString(secret,value),decrypt:value=>decryptEncryptedString(secret,value),platforms:()=>enabled?['qq']:[],publishChanged:async who=>{assert.equal(who,owner);assert.equal((await pool.query("SELECT count(*)::int AS n FROM user_bots WHERE user_id=$1 AND platform='qq'",[owner])).rows[0].n,1);publications++}})
  enabled=false;await assert.rejects(()=>create(owner,{app_id:'',app_secret:''}),(e:any)=>e.code==='platform_disabled');enabled=true
  await assert.rejects(()=>create(owner,{app_id:'',app_secret:'synthetic'}),(e:any)=>e.code==='invalid_credentials')
  const input={name:' 自定义机器人 ',app_id:' synthetic-app ',app_secret:' synthetic-qq-secret ',sandbox:true,enabled:true}
  const outcomes=await Promise.allSettled([create(owner,input),create(owner,input)])
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.equal(outcomes.filter(item=>item.status==='rejected'&&item.reason.code==='already_exists').length,1)
  const actual=outcomes.find(item=>item.status==='fulfilled')!;assert.equal(actual.status,'fulfilled');if(actual.status!=='fulfilled')throw new Error('创建未完成')
  assert.equal(actual.value.name,input.name);assert.equal(actual.value.app_id,'synthetic-app');assert.doesNotMatch(JSON.stringify(actual.value),/synthetic-qq-secret/);assert.equal(publications,1)
  const raw=(await pool.query('SELECT app_secret FROM user_bots WHERE id=$1',[actual.value.id])).rows[0].app_secret
  assert.match(raw,/^gcm1:/);assert.equal(decryptEncryptedString(secret,raw),'synthetic-qq-secret')
  const pythonResult=bridge('consume',{TEST_BOT:String(actual.value.id)})
  assert.deepEqual(actual.value,pythonResult.response);assert.equal(pythonResult.gateway_secret_sha,pythonResult.expected_secret_sha);assert.equal(pythonResult.gateway_app_id,'synthetic-app');assert.equal(pythonResult.gateway_owner,owner)
  const rows=(await pool.query('SELECT source,context_epoch,snapshot_hash,session_info_hash,snapshot_expires_at<clock_timestamp() AS expired FROM conversation_sessions WHERE user_id=$1 ORDER BY source',[owner])).rows
  const baseline=bridge('reference',{TEST_INPUT:JSON.stringify(input)})
  const {id:nodeId,...nodeResponse}=actual.value,{id:pythonId,...pythonResponse}=baseline.response
  assert.ok(nodeId);assert.ok(pythonId);assert.deepEqual(nodeResponse,pythonResponse);assert.deepEqual(rows,baseline.snapshots);assert.equal(baseline.publications,1)
  for(const row of rows){assert.equal(row.context_epoch,row.source==='web'?4:5);assert.equal(row.expired,row.source!=='web');assert.equal(row.snapshot_hash,'synthetic-snapshot');assert.equal(row.session_info_hash,'synthetic-session')}
  assert.equal((await pool.query('SELECT context_epoch FROM conversation_sessions WHERE user_id=$1',[other])).rows[0].context_epoch,4)
  assert.equal(await invalidateOwnerImSnapshots(db,other),1)
  await pool.query("CREATE FUNCTION fail_qq_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insert failure'; END $$;CREATE TRIGGER fail_qq_insert BEFORE INSERT ON user_bots FOR EACH ROW EXECUTE FUNCTION fail_qq_insert()")
  await assert.rejects(()=>create(other,input));assert.equal(publications,1);assert.equal((await pool.query('SELECT context_epoch FROM conversation_sessions WHERE user_id=$1',[other])).rows[0].context_epoch,5)
  await pool.query("DROP TRIGGER fail_qq_insert ON user_bots;CREATE FUNCTION remove_new_qq() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM user_bots WHERE id=NEW.id;RETURN NEW;END $$;CREATE TRIGGER remove_new_qq AFTER INSERT ON user_bots FOR EACH ROW EXECUTE FUNCTION remove_new_qq()")
  await assert.rejects(()=>create(other,input),/机器人刷新失败/)
  assert.equal((await pool.query('SELECT context_epoch FROM conversation_sessions WHERE user_id=$1',[other])).rows[0].context_epoch,5)
  await pool.query("DROP TRIGGER remove_new_qq ON user_bots;CREATE FUNCTION fail_im_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic snapshot failure';END $$;CREATE TRIGGER fail_im_invalidation BEFORE UPDATE OF snapshot_expires_at ON conversation_sessions FOR EACH ROW EXECUTE FUNCTION fail_im_invalidation()")
  let failedPublication=0
  const createOther=createQqBotCreator(db,{encrypt:value=>encryptEncryptedString(secret,value),decrypt:value=>decryptEncryptedString(secret,value),platforms:()=>['qq'],publishChanged:async who=>{assert.equal(who,other);failedPublication++;throw new Error('synthetic live failure')}})
  const whitespace=await createOther(other,{app_id:' ',app_secret:' ',enabled:false})
  assert.equal(whitespace.app_id,'');assert.equal(whitespace.app_secret,'');assert.equal(whitespace.name,'我的 QQ 机器人');assert.equal(whitespace.enabled,false);assert.equal(failedPublication,1)
  assert.equal((await pool.query('SELECT context_epoch FROM conversation_sessions WHERE user_id=$1',[other])).rows[0].context_epoch,5)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
