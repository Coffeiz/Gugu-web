import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQuotaPatch } from '@gugu/core/admin/user-settings'

test('配额遵循Python整数转换、null及各字段下界，忽略未知字段', () => {
  assert.deepEqual(parseQuotaPatch({token_limit_6h: ' -1 ', token_limit_weekly: 4.9, storage_limit_bytes: null, search_limit_daily: true, extra: 20}), {token_limit_6h:-1, token_limit_weekly:4, storage_limit_bytes:null, search_limit_daily:1})
  assert.deepEqual(parseQuotaPatch({search_limit_daily:'１２_３'}), {search_limit_daily:123})
  for (const input of [{search_limit_daily:-1},{storage_limit_bytes:-2},{token_limit_6h:'2.5'},{token_limit_6h:[]},{token_limit_6h:''}]) assert.throws(()=>parseQuotaPatch(input), {statusCode:422})
})

import Fastify from 'fastify'
import {Pool} from 'pg'
import {randomUUID} from 'node:crypto'
import {registerAdminUserSettingsRoutes,createPostgresAdminSettingsTransaction} from '../../src/modules/admin/user-settings.js'

test('管理员更新配额持久化、失败不部分写入，开发者标记可逆且拒绝未授权请求', async () => {
  const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL
  assert.ok(url,'必须提供独立测试数据库')
  const admin=new Pool({connectionString:url}), schema=`settings_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`})
  const app=Fastify()
  const audits:string[]=[]
  registerAdminUserSettingsRoutes(app,{
    requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin') return reply.code(401).send({detail:'未登录'})},
    transaction:createPostgresAdminSettingsTransaction(pool),adminUsername:()=> '测试管理员',
    writeAuditLog:async(_username,_action,description)=>{audits.push(description)},
  })
  try {
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY,username text NOT NULL,is_developer boolean NOT NULL DEFAULT false,token_limit_6h bigint,token_limit_weekly bigint,storage_limit_bytes bigint,search_limit_daily integer)')
    const id=randomUUID(), other=randomUUID(), headers={authorization:'admin'}, path=`/api/v1/admin/users/${id}`
    await pool.query("INSERT INTO users(id,username,token_limit_6h) VALUES($1,'小北',20),($2,'小南',30)",[id,other])
    assert.equal((await app.inject({method:'PATCH',url:`${path}/quota`,payload:{token_limit_6h:1}})).statusCode,401)
    assert.equal((await app.inject({method:'PATCH',url:`${path}/quota`,headers,payload:{token_limit_6h:2,search_limit_daily:-1}})).statusCode,422)
    assert.equal(Number((await pool.query('SELECT token_limit_6h FROM users WHERE id=$1',[id])).rows[0].token_limit_6h),20)
    const response=await app.inject({method:'PATCH',url:`${path}/quota`,headers,payload:{token_limit_6h:'-1',search_limit_daily:4.9,storage_limit_bytes:null}})
    assert.equal(response.statusCode,200)
    assert.equal(Number(response.json().token_limit_6h),-1)
    assert.equal(response.json().search_limit_daily,4)
    assert.equal(response.json().storage_limit_bytes,null)
    for(const expected of [true,false]) {
      const result=await app.inject({method:'PATCH',url:`${path}/developer`,headers})
      assert.deepEqual(result.json(),{id,is_developer:expected})
    }
    const missing=await app.inject({method:'PATCH',url:`/api/v1/admin/users/${randomUUID()}/quota`,headers,payload:{search_limit_daily:-1}})
    assert.equal(missing.statusCode,404)
    assert.equal(missing.json().message,'用户不存在')
    assert.equal(Number((await pool.query('SELECT token_limit_6h FROM users WHERE id=$1',[other])).rows[0].token_limit_6h),30)
    assert.equal(audits.length,3)
  } finally {await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
