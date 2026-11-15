import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { withBorrowedMindPostgres, withBorrowedPostgresQuery, type BorrowedPostgresQuery } from '../../../src/data/borrowed-postgres.js'
import { applyMindUndoWithPostgresClient } from '../../../src/mind/undo-postgres-client.js'
import { applyMindUndoInTransaction } from '../../../src/mind/undo-adapter.js'
import type { Database } from '../../../src/data/schema.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离测试连接')
test('借用同一 PG 事务并约束生命周期、并发和 savepoint', async () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 })
  const client = await pool.connect(), other = await pool.connect()
  const table = `borrowed_${randomUUID().replaceAll('-', '')}`
  let escapedQuery: BorrowedPostgresQuery | undefined
  let escapedMind: Kysely<Database> | undefined
  try {
    await client.query(`CREATE TEMP TABLE ${table} (id int PRIMARY KEY)`)
    await client.query('BEGIN')
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await withBorrowedPostgresQuery(client, async () => {
      await assert.rejects(withBorrowedMindPostgres(client, async () => {}), /已被借用/)
    })
    await withBorrowedMindPostgres(client, async () => {
      await assert.rejects(withBorrowedPostgresQuery(client, async () => {}), /已被借用/)
    })
    await withBorrowedPostgresQuery(client, async query => {
      escapedQuery = query
      assert.equal((await query.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid, pid)
      await query.query(`INSERT INTO ${table} VALUES ($1)`, [1])
      await assert.rejects(query.query('COMMIT'), /事务控制/)
      await assert.rejects(query.query('SELECT 1; SELECT 2'), /事务控制/)
      for (const statement of ['/* 外 /* 内 */ 尾 */ COMMIT', '-- 注释\rCOMMIT', 'START/* 注释 */TRANSACTION',
        'SET/* 注释 */TRANSACTION READ ONLY', 'SET SESSION/* 注释 */CHARACTERISTICS AS TRANSACTION READ ONLY',
        'SELECT 1 /* 未闭合', '/* 未闭合'])
        await assert.rejects(query.query(statement), /事务控制/)
      assert.equal((await query.query<{ text: string }>("SELECT '/* 字符串 */' AS text /* 嵌套 /* 注释 */ 正常 */")).rows[0]!.text, '/* 字符串 */')
      await assert.rejects(withBorrowedMindPostgres(client, async () => {}), /已被借用/)
      assert.equal(await withBorrowedPostgresQuery(other, async q => (await q.query<{ n: number }>('SELECT 7 AS n')).rows[0]!.n), 7)
    })
    await assert.rejects(escapedQuery!.query('SELECT 1'), /借用已结束/)
    await withBorrowedMindPostgres(client, async db => {
      escapedMind = db
      assert.equal((db as unknown as { destroy?: unknown }).destroy, undefined)
      assert.throws(() => (db as unknown as { destroy: () => void }).destroy(), TypeError)
      assert.equal((db as unknown as { transaction?: unknown }).transaction, undefined)
      assert.equal((db as unknown as { connection?: unknown }).connection, undefined)
      assert.equal((db.getExecutor() as unknown as { provideConnection?: unknown }).provideConnection, undefined)
      assert.equal((db.getExecutor() as unknown as { withPlugins?: unknown }).withPlugins, undefined)
      assert.equal((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)).rows[0]!.pid, pid)
      await assert.rejects(withBorrowedPostgresQuery(client, async () => {}), /已被借用/)
      await assert.rejects(sql.raw('COMMIT').execute(db), /事务控制/)
      await assert.rejects(sql.raw('SET CONSTRAINTS ALL DEFERRED').execute(db), /事务控制/)
      await assert.rejects(sql.raw('SAVEPOINT arbitrary').execute(db), /事务控制/)
      await sql`SAVEPOINT mind_undo_adapter`.execute(db)
      await sql`INSERT INTO ${sql.table(table)} VALUES (2)`.execute(db)
      await sql`ROLLBACK TO SAVEPOINT mind_undo_adapter`.execute(db)
      await sql`RELEASE SAVEPOINT mind_undo_adapter`.execute(db)
      await sql`INSERT INTO ${sql.table(table)} VALUES (3)`.execute(db)
    })
    await assert.rejects(sql`SELECT 1`.execute(escapedMind!), /借用已结束/)
    assert.deepEqual((await client.query(`SELECT id FROM ${table} ORDER BY id`)).rows, [{ id: 1 }, { id: 3 }])
    await client.query('ROLLBACK')
    assert.deepEqual((await client.query(`SELECT id FROM ${table}`)).rows, [])
    await client.query('BEGIN')
    await withBorrowedPostgresQuery(client, async query => {
      const pending = query.query('SELECT pg_sleep(0.1)')
      await assert.rejects(query.query('SELECT 1'), /并发查询/)
      await pending
    })
    await assert.rejects(withBorrowedPostgresQuery(client, async query => { void query.query('SELECT pg_sleep(0.1)').catch(() => {}) }), /未等待/)
    assert.equal((await client.query('SELECT 1 AS n')).rows[0].n, 1)
    await assert.rejects(withBorrowedMindPostgres(client, async db => { void sql`SELECT pg_sleep(0.1)`.execute(db).catch(() => {}) }), /未等待/)
    assert.equal((await client.query('SELECT 1 AS n')).rows[0].n, 1)
    await assert.rejects(withBorrowedMindPostgres(client, async db => {
      void sql`SELECT pg_sleep(0.1)`.execute(db).catch(() => {})
      throw new Error('模拟调用方异常')
    }), /模拟调用方异常/)
    assert.equal((await client.query('SELECT 1 AS n')).rows[0].n, 1)
    let attempts = 0
    const uncertain = new Proxy(client, { get(target, property) { if (property === 'query') return async () => { attempts++; throw new Error('模拟连接结果未知') }; const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value } })
    await assert.rejects(withBorrowedPostgresQuery(uncertain, q => q.query('SELECT 1')), /结果未知/)
    assert.equal(attempts, 1)
    await client.query('ROLLBACK')
    await withBorrowedMindPostgres(client, async db => { assert.equal((await sql<{ n: number }>`SELECT 1 AS n`.execute(db)).rows[0]!.n, 1) })
    assert.equal((await client.query('SELECT 1 AS n')).rows[0].n, 1)
    await client.query('CREATE TEMP TABLE mind_nodes (id int PRIMARY KEY,user_id uuid,kind text,title text,content_md text,content_plain text,color text,captured_at timestamptz,deleted_at timestamptz,version int,ref_snapshot json,updated_at timestamptz)')
    const owner = '11111111-1111-4111-8111-111111111111'
    await client.query("INSERT INTO mind_nodes VALUES (1,$1,'note',NULL,'正文','正文',NULL,'2020-01-01Z',NULL,1,NULL,CURRENT_TIMESTAMP)", [owner])
    await client.query('BEGIN')
    const snapshot = { kind: 'note', title: null, content_md: '正文', content_plain: '正文', color: null, captured_at: '2020-01-01T00:00:00Z', deleted_at: null }
    const result = await withBorrowedMindPostgres(client, db => applyMindUndoInTransaction(db, 'postgres', owner, { id: 'op', action: 'create', before_state: {}, after_state: { items: { 'note:1': snapshot } } }, 'undo'))
    assert.equal(result.versions['note:1'], 2)
    await client.query('ROLLBACK')
    assert.deepEqual((await client.query('SELECT version,deleted_at FROM mind_nodes WHERE id=1')).rows[0], { version: 1, deleted_at: null })
    await client.query('BEGIN')
    await applyMindUndoWithPostgresClient(client, owner, { id: 'op', action: 'create', before_state: {}, after_state: { items: { 'note:1': snapshot } } }, 'undo')
    await client.query('COMMIT')
    const committed = (await client.query('SELECT version,deleted_at FROM mind_nodes WHERE id=1')).rows[0]
    assert.equal(committed.version, 2)
    assert.ok(committed.deleted_at)
    assert.equal((await client.query('SELECT 1 AS n')).rows[0].n, 1)

  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release(); other.release(); await pool.end()
  }
})
