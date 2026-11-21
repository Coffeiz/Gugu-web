import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createEmailRecipientCounter } from '../../../src/modules/admin/email.js'

const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('收件人数只计活跃订阅有效邮箱，locale损坏回到中文且不暴露邮箱', {skip:!url&&'需要隔离PG'},async()=>{
  const schema=`recipient_count_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`})
  try {
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,email text,is_active boolean,account_status text,email_subscribed boolean)')
    await pool.query('CREATE TABLE user_preferences(user_id uuid PRIMARY KEY,data_json text)')
    const cases=[[' a@example.test ','{"locale":"en-US"}',true,'active',true],['b@example.test','{"locale":"ja-JP"}',true,'active',true],['c@example.test','broken',true,'active',true],['d@example.test','[]',true,'active',true],['not-email','{}',true,'active',true],['e@example.test','{}',false,'active',true],['f@example.test','{}',true,'suspended',true],['g@example.test','{}',true,'active',false]] as const
    for(const [email,json,active,status,subscribed] of cases){const id=randomUUID();await pool.query('INSERT INTO users VALUES($1,$2,$3,$4,$5)',[id,email,active,status,subscribed]);await pool.query('INSERT INTO user_preferences VALUES($1,$2)',[id,json])}
    const result=await createEmailRecipientCounter((sql,params)=>pool.query(sql,params))()
    assert.deepEqual(result,{count:4,locale_counts:{'zh-CN':2,'ja-JP':1,'en-US':1}})
    assert.doesNotMatch(JSON.stringify(result),/@|example/)
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
