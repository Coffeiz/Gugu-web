import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresPool } from '@gugu/database/postgres/pool'
import { withBorrowedPostgresQuery, type BorrowedPostgresQuery } from '@gugu/core/data'
import { withPostgresTransaction } from '../../../src/adapters/database/postgres-transaction.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('借用事务保持同一连接，effects 失败回滚且连接不能越期或重入', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `borrow_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE effects(id integer PRIMARY KEY)')
    let escaped: BorrowedPostgresQuery | undefined
    await assert.rejects(withPostgresTransaction(pool, async client => {
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await withBorrowedPostgresQuery(client, async query => {
        escaped = query
        assert.equal((await query.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid, pid)
        await query.query('INSERT INTO effects(id) VALUES ($1)', [1])
        await assert.rejects(query.query('COMMIT'), /不允许事务控制/)
        await assert.rejects(withBorrowedPostgresQuery(client, async () => {}), /已被借用/)
      })
      await client.query('INSERT INTO effects(id) VALUES (2)')
      throw new Error('合成 effects 失败')
    }), /合成 effects 失败/)
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM effects')).rows[0].count), 0)
    await assert.rejects(escaped!.query('SELECT 1'), /借用已结束/)
    await pool.query('INSERT INTO effects VALUES (3)')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('COMMIT 结果未知时不会自动重试事务或写入第二次', async () => {
  let calls = 0, commits = 0, released = 0
  const client = { async query(text: string) { if (text === 'COMMIT') { commits++; throw new Error('合成连接中断') } return { rows: [], rowCount: 0 } }, release() { released++ } }
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  await assert.rejects(withPostgresTransaction(pool, async () => { calls++; return 'ok' }), /合成连接中断/)
  assert.equal(calls, 1); assert.equal(commits, 1); assert.equal(released, 1)
})

test('协议异常丢弃异常连接，业务错误正常回滚并归还连接', async () => {
  for (const [code, discard] of [['08P01', true], ['23505', false]] as const) {
    const queries: string[] = [], released: boolean[] = []
    const client = { async query(text: string) { queries.push(text) }, release(destroy: boolean) { released.push(destroy) } }
    const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
    const error = new Error('合成数据库异常', { cause: Object.assign(new Error('合成底层异常'), { code }) })
    await assert.rejects(withPostgresTransaction(pool, async () => { throw error }), received => received === error)
    assert.deepEqual(queries, discard ? ['BEGIN'] : ['BEGIN', 'ROLLBACK'])
    assert.deepEqual(released, [discard])
  }
})

test('直接借用的连接在协议错误或事务未结束时销毁，正常回滚后可以复用', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const pool = createPostgresPool(Pool, { connectionString: url, max: 1 })
  const pid = async (client: Pick<Pool, 'query'>) =>
    (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
  try {
    let client = await pool.connect()
    const originalPid = await pid(client)
    await client.query('BEGIN')
    await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' })
    await client.query('ROLLBACK')
    client.release()
    assert.equal(await pid(pool), originalPid)

    client = await pool.connect()
    await client.query('BEGIN')
    await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' })
    client.release()
    const replacementPid = await pid(pool)
    assert.notEqual(replacementPid, originalPid)

    await new Promise<void>((resolve, reject) => pool.connect((error, borrowed, done) => {
      if (error || !borrowed) return reject(error ?? new Error('未取得数据库连接'))
      // 错误由 PostgreSQL 在完好的传输上返回，能区分连接池显式销毁和驱动被动断开。
      borrowed.query("DO $$ BEGIN RAISE SQLSTATE '08P01'; END $$", failure => {
        done()
        try {
          assert.equal((failure as { code?: string } | null)?.code, '08P01')
          resolve()
        } catch (assertionError) { reject(assertionError) }
      })
    }))
    assert.notEqual(await pid(pool), replacementPid)
  } finally {
    await pool.end()
  }
})
