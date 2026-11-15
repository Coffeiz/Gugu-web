import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { expect, it } from 'vitest'
import { createSqlAgentGroupNames } from '../../../src/agent/sessions/group-names.js'
const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('必须提供隔离的 PG 测试地址')
it('PG 群昵称只返回 owner 会话中候选人的最近有效名称', async () => {
  const schema = `gugu_names_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({connectionString:url,options:`-c search_path=${schema}`})
  const db = new Kysely<any>({dialect:new PostgresDialect({pool})})
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,chat_type text,source text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,platform_user_id text,platform_user_name text,created_at timestamptz)`)
    await pool.query(`INSERT INTO conversation_sessions VALUES (1,$1,'group','qq'),(2,$2,'group','qq'),(3,$1,'private','qq'),(4,$1,'group',NULL),(5,$1,'group','')`,[owner,other])
    await pool.query(`INSERT INTO conversation_messages VALUES
      (1,1,'a','旧','2026-01-01 00:00:00.000001Z'),(2,1,'a','新','2026-01-01 00:00:00.000002Z'),
      (3,1,'a','并列','2026-01-01 00:00:00.000002Z'),(4,1,'a','','2026-01-01 00:00:00.000003Z'),
      (5,1,'b',' ','2026-01-01'),(6,2,'a','其他用户','2026-01-02'),(7,3,'a','私聊','2026-01-03'),(8,4,'a','缺来源','2026-01-03'),(9,5,'a','空来源','2026-01-03')`)
    const lookup = createSqlAgentGroupNames(db, 'postgres')
    expect(Object.fromEntries(await lookup(owner,1,['a','b','missing']))).toEqual({a:'并列',b:' '})
    expect((await lookup(other,1,['a'])).size).toBe(0)
    expect((await lookup(owner,3,['a'])).size).toBe(0)
    expect((await lookup(owner,4,['a'])).size).toBe(0)
    expect((await lookup(owner,5,['a'])).size).toBe(0)
    expect((await lookup(owner,1,[])).size).toBe(0)
  } finally { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
