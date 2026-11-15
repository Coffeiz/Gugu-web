import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { withBorrowedPostgresQuery, type BorrowedPostgresQuery } from '@gugu/core/data'
import { withPostgresTransaction } from '../../src/adapters/postgres-transaction.js'

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
