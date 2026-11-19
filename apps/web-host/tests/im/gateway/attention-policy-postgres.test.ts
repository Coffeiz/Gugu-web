import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { ImActorInput } from '@gugu/core/im/access'
import { createPostgresImAttentionPolicyGuard } from '../../../src/modules/im/gateway/attention-policy-postgres.js'

const ownerId='00000000-0000-4000-8000-000000000011'
const identity={ownerId,sessionId:'21',runId:'synthetic-run'}
const input:ImActorInput={ownerId,botId:'1',platform:'telegram',chatType:'group',chatId:'synthetic-group',platformUserId:'speaker',botMentioned:false,mentionsOtherBot:false}
const record={v:1,disposition:'run',mode:'natural',configVersion:7,subjectEventId:'1791000000000-1',sourceAttentionKind:'DIRECT',proactive:false,replyChoice:'pending'}
test('普通非attention运行兼容既有schema；畸形冻结范围拒绝且查询错误不外泄',async()=>{
  const pool={async query(){throw new Error('synthetic-private-sql')}} as unknown as Pool
  assert.equal(await createPostgresImAttentionPolicyGuard({pool,identity,input,record:undefined})(),true)
  await assert.rejects(createPostgresImAttentionPolicyGuard({pool,identity,input,record})(),error=>error instanceof Error
    &&error.message==='IM 自动回复策略暂时不可用'&&!error.message.includes('synthetic-private-sql')&&!('cause' in error))
  assert.throws(()=>createPostgresImAttentionPolicyGuard({pool,identity,input:{...input,chatType:'c2c',chatId:null},record}))
  assert.throws(()=>createPostgresImAttentionPolicyGuard({pool,identity,input,record:{...record,disposition:'pending',replyChoice:'reply'}}))
})
const pgUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG：冻结mode/版本、仅@和只读切换、账户及群撤权、完整owner/Bot/群范围实时复核',{
  skip:!pgUrl&&'未运行：显式GUGU_IM_GATEWAY_TEST_DATABASE_URL后以随机schema验证真实当前策略',
},async()=>{
  const{Pool}=await import('pg'),admin=new Pool({connectionString:pgUrl}),schema=`im_policy_${randomUUID().replaceAll('-','')}`
  let pool:Pool|undefined
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:pgUrl,options:`-c search_path=${schema}`})
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,
        group_requires_at boolean,group_read_enabled boolean,group_attention_mode text,group_attention_config_version integer);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text)`)
    await pool.query("INSERT INTO users VALUES($1,true,'active')",[ownerId])
    await pool.query("INSERT INTO user_bots VALUES(1,$1,'telegram',true,true,NULL,false,false,'natural',7)",[ownerId])
    await pool.query("INSERT INTO conversation_sessions VALUES(21,$1,'telegram','1','group','synthetic-group')",[ownerId])
    const db=pool,guard=createPostgresImAttentionPolicyGuard({pool:db,identity,input,record})
    assert.equal(await guard(),true)
    for(const sql of ["group_requires_at=true","group_read_enabled=true","group_attention_mode='quiet'","group_attention_config_version=8","group_chat_enabled=false","enabled=false"]){
      await db.query(`UPDATE user_bots SET ${sql}`);assert.equal(await guard(),false)
      await db.query("UPDATE user_bots SET group_requires_at=false,group_read_enabled=false,group_attention_mode='natural',group_attention_config_version=7,group_chat_enabled=true,enabled=true")
    }
    for(const sql of ["is_active=false","account_status='disabled'"]){
      await db.query(`UPDATE users SET ${sql}`);assert.equal(await guard(),false);await db.query("UPDATE users SET is_active=true,account_status='active'")
    }
    for(const changed of [{...input,chatId:'other-group'},{...input,botId:'2'},{...input,platform:'qq' as const}])
      assert.equal(await createPostgresImAttentionPolicyGuard({pool:db,identity,input:changed,record})(),false)
    const other=randomUUID()
    assert.equal(await createPostgresImAttentionPolicyGuard({pool:db,identity:{...identity,ownerId:other},input:{...input,ownerId:other},record})(),false)
    assert.equal(await createPostgresImAttentionPolicyGuard({pool:db,identity:{...identity,sessionId:'22'},input,record})(),false)
    // 与原runtime相同：未知旧mode规范化为autonomous；飞书nullable群开关允许，QQ/TG必须true。
    await db.query("UPDATE user_bots SET group_attention_mode='legacy-value'")
    assert.equal(await createPostgresImAttentionPolicyGuard({pool:db,identity,input,record:{...record,mode:'autonomous'}})(),true)
    await db.query("UPDATE user_bots SET platform='feishu',group_chat_enabled=false,feishu_group_chat_enabled=NULL;UPDATE conversation_sessions SET source='feishu'")
    assert.equal(await createPostgresImAttentionPolicyGuard({pool:db,identity,input:{...input,platform:'feishu'},record:{...record,mode:'autonomous'}})(),true)
    await db.query('UPDATE user_bots SET feishu_group_chat_enabled=false')
    assert.equal(await createPostgresImAttentionPolicyGuard({pool:db,identity,input:{...input,platform:'feishu'},record:{...record,mode:'autonomous'}})(),false)
  }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
})
