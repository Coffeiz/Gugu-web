import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { ImDeliveryStoreError, withPostgresImDeliveryStore } from '../../../src/modules/im/gateway/delivery-store.js'
import type { ImDeliveryReceipts } from '../../../src/modules/im/gateway/delivery-store.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000021', sessionId: '21', runId: 'synthetic-run' }
const fingerprint = 'a'.repeat(64)

/** 仅验证PG查询契约和故障传播；不把此替身计为持久化或PostgreSQL验收。 */
function queryFixture() {
  type Receipt = { state: string; fingerprint: string; attempt: string }
  const data = new Map<string, Receipt>()
  let cursor = 0, owned = true, locked = false, held = true, released = false, discarded = false, failQuery = false
  let writes = 0
  const client = Object.assign(new EventEmitter(), {
    async query(text: string, params: unknown[] = []) {
      if (failQuery) throw new Error('私密SQL错误及凭据')
      if (text.includes('pg_try_advisory_lock')) { const acquired = !locked; locked = true; return { rows: [{ locked: acquired, backend_pid: 71 }], rowCount: 1 } }
      if (text.includes('pg_locks')) return { rows: [{ backend_pid: 71, held }], rowCount: 1 }
      if (text.includes('pg_advisory_unlock')) { locked = false; return { rows: [{ unlocked: true }], rowCount: 1 } }
      if (text.startsWith('INSERT INTO gugu_im_run_delivery')) { writes++; return { rows: [], rowCount: owned ? 1 : 0 } }
      if (text.startsWith('SELECT d.cursor')) return { rows: owned ? [{ cursor }] : [], rowCount: owned ? 1 : 0 }
      if (text.startsWith('INSERT INTO gugu_im_delivery_receipts')) {
        writes++
        if (!owned) return { rows: [], rowCount: 0 }
        const key = String(params[3]), previous = data.get(key)
        if (previous && previous.fingerprint !== params[4]) return { rows: [], rowCount: 0 }
        const row = previous && previous.state !== 'rejected' ? previous : { state: 'pending', fingerprint: String(params[4]), attempt: String(params[5]) }
        data.set(key, row)
        return { rows: [{ state: row.state, attempt_id: row.attempt }], rowCount: 1 }
      }
      if (text.startsWith('UPDATE gugu_im_delivery_receipts')) {
        writes++
        const row = data.get(String(params[3]))
        if (!owned || !row || row.state !== 'pending' || row.attempt !== params[4]) return { rows: [], rowCount: 0 }
        row.state = String(params[5]); return { rows: [{ delivery_key: params[3] }], rowCount: 1 }
      }
      if (text.startsWith('UPDATE gugu_im_run_delivery')) {
        writes++
        if (!owned || cursor !== params[3]) return { rows: [], rowCount: 0 }
        cursor = Number(params[4]); return { rows: [{ cursor }], rowCount: 1 }
      }
      throw new Error('未预期查询')
    },
    release(discard?: boolean) { released = true; discarded = !!discard },
  }) as unknown as PoolClient
  return { pool: { connect: async () => client } as Pick<Pool, 'connect'>, data, client,
    get cursor() { return cursor }, get writes() { return writes }, get released() { return released }, get discarded() { return discarded },
    setOwned(value: boolean) { owned = value }, loseLock() { held = false }, fail() { failQuery = true } }
}

test('查询契约：唯一发送意图、明确拒绝可重试、受理和unknown不能重发', async () => {
  const f = queryFixture()
  await withPostgresImDeliveryStore(f.pool, identity, async receipts => {
    assert.equal(await receipts.cursor(identity), 0)
    assert.equal(await receipts.begin(identity, 'text', fingerprint), 'new')
    assert.equal(await receipts.begin(identity, 'text', fingerprint), 'pending')
    await receipts.settle(identity, 'text', 'rejected')
    assert.equal(await receipts.begin(identity, 'text', fingerprint), 'new')
    await receipts.settle(identity, 'text', 'accepted')
    assert.equal(await receipts.begin(identity, 'text', fingerprint), 'accepted')
    assert.equal(await receipts.begin(identity, 'file', fingerprint), 'new')
    await receipts.settle(identity, 'file', 'unknown')
    assert.equal(await receipts.begin(identity, 'file', fingerprint), 'unknown')
    await receipts.advance(identity, 0, 1)
    assert.equal(await receipts.cursor(identity), 1)
    await assert.rejects(receipts.advance(identity, 0, 1), ImDeliveryStoreError)
    await assert.rejects(receipts.begin(identity, 'text', 'b'.repeat(64)), ImDeliveryStoreError)
  })
  assert.equal(f.released, true); assert.equal(f.discarded, false)
})

test('查询契约：会话与运行跨scope拒绝，删除归属后不能更新收据或游标', async () => {
  const f = queryFixture()
  await withPostgresImDeliveryStore(f.pool, identity, async receipts => {
    for (const other of [{ ...identity, ownerId: '00000000-0000-4000-8000-000000000022' }, { ...identity, sessionId: '22' }, { ...identity, runId: 'other' }])
      await assert.rejects(receipts.cursor(other), error => error instanceof ImDeliveryStoreError && error.code === 'not_found')
    await receipts.begin(identity, 'text', fingerprint)
    f.setOwned(false)
    await assert.rejects(receipts.cursor(identity), ImDeliveryStoreError)
    await assert.rejects(receipts.settle(identity, 'text', 'accepted'), ImDeliveryStoreError)
    await assert.rejects(receipts.advance(identity, 0, 1), ImDeliveryStoreError)
    assert.equal(f.data.get('text')?.state, 'pending')
  })
})

test('查询契约：连接丢失与锁丢失在写前拒绝，原始错误不进入公开异常', async () => {
  for (const mode of ['event', 'lock', 'query']) {
    const f = queryFixture()
    await withPostgresImDeliveryStore(f.pool, identity, async receipts => {
      await receipts.begin(identity, 'text', fingerprint)
      const writes = f.writes
      if (mode === 'event') f.client.emit('error', new Error('合成连接中断'))
      else if (mode === 'lock') f.loseLock()
      else f.fail()
      await assert.rejects(receipts.settle(identity, 'text', 'accepted'), error => error instanceof ImDeliveryStoreError && !error.message.includes('凭据'))
      assert.equal(f.writes, writes)
      assert.equal(f.data.get('text')?.state, 'pending')
    })
    assert.equal(f.discarded, true)
  }
})

test('查询契约：借用范围结束后的旧attempt不能写入下一轮状态', async () => {
  const f = queryFixture()
  let escaped: ImDeliveryReceipts | undefined
  await withPostgresImDeliveryStore(f.pool, identity, async receipts => {
    escaped = receipts; await receipts.begin(identity, 'text', fingerprint)
  })
  const writes = f.writes
  await assert.rejects(escaped!.settle(identity, 'text', 'accepted'), error => error instanceof ImDeliveryStoreError && error.code === 'lease_lost')
  assert.equal(f.writes, writes)
  await withPostgresImDeliveryStore(f.pool, identity, async receipts => {
    assert.equal(await receipts.begin(identity, 'text', fingerprint), 'pending')
    await assert.rejects(receipts.settle(identity, 'text', 'accepted'), ImDeliveryStoreError)
  })
})

test('查询契约：没有会话归属不返回空游标，调用方错误仍释放锁', async () => {
  const f = queryFixture(); f.setOwned(false)
  await assert.rejects(withPostgresImDeliveryStore(f.pool, identity, receipts => receipts.cursor(identity)), error => error instanceof ImDeliveryStoreError && error.code === 'not_found')
  assert.equal(f.released, true)
  const failure = new Error('合成调用方错误')
  const g = queryFixture()
  await assert.rejects(withPostgresImDeliveryStore(g.pool, identity, async () => { throw failure }), error => error === failure)
  assert.equal(g.released, true)
})

test('默认模式保持并发拒绝；遗漏await仍销毁忙连接，不默许借用逃逸', async () => {
  for (const forgotAwait of [false, true]) {
    const f = queryFixture(), query = f.client.query.bind(f.client)
    let armed = false, releaseGate!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
    f.client.query = (async (text: string, params?: unknown[]) => {
      if (armed && text.includes('pg_locks')) { armed = false; entered(); await gate }
      return query(text, params)
    }) as typeof f.client.query
    let result!: Promise<{ value: unknown } | { error: unknown }>
    try {
      await withPostgresImDeliveryStore(f.pool, identity, async receipts => {
        armed = true
        result = receipts.cursor(identity).then(value => ({ value }), error => ({ error }))
        await reached
        await assert.rejects(receipts.cursor(identity), error => error instanceof ImDeliveryStoreError && error.code === 'conflict')
        if (!forgotAwait) { releaseGate(); assert.deepEqual(await result, { value: 0 }) }
      })
      assert.equal(f.discarded, forgotAwait)
      if (forgotAwait) {
        releaseGate()
        const failed = await result
        assert.ok('error' in failed && failed.error instanceof ImDeliveryStoreError && failed.error.code === 'lease_lost')
      }
    } finally { releaseGate(); await result }
  }
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PostgreSQL：真实锁互斥、重启恢复、attempt和scope隔离', {
  skip: !pgUrl && '未运行：显式设置 GUGU_IM_GATEWAY_TEST_DATABASE_URL 后在随机schema验收；query替身不证明PG持久化',
}, async () => {
  const { Pool } = await import('pg')
  const schema = `im_delivery_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
    // 合成前置表只表达当前生产字段类型，绝不读取真实用户会话。
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id))')
    await pool.query('INSERT INTO users(id) VALUES($1),($2)', [identity.ownerId, '00000000-0000-4000-8000-000000000022'])
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES(21,$1),(22,$2)', [identity.ownerId, '00000000-0000-4000-8000-000000000022'])
    await pool.query(await readFile(new URL('../../../src/modules/im/gateway/delivery-schema.sql', import.meta.url), 'utf8'))
    const database = pool
    await withPostgresImDeliveryStore(database, identity, async receipts => {
      await assert.rejects(withPostgresImDeliveryStore(database, identity, async () => {}), error => error instanceof ImDeliveryStoreError && error.code === 'busy')
      assert.equal(await receipts.begin(identity, 'accepted', fingerprint), 'new')
      await receipts.settle(identity, 'accepted', 'accepted')
      assert.equal(await receipts.begin(identity, 'pending', fingerprint), 'new')
      assert.equal(await receipts.begin(identity, 'unknown', fingerprint), 'new')
      await receipts.settle(identity, 'unknown', 'unknown')
      assert.equal(await receipts.begin(identity, 'retry', fingerprint), 'new')
      await receipts.settle(identity, 'retry', 'rejected')
      await receipts.advance(identity, 0, 1)
    })
    await withPostgresImDeliveryStore(database, identity, async receipts => {
      assert.equal(await receipts.cursor(identity), 1)
      assert.equal(await receipts.begin(identity, 'accepted', fingerprint), 'accepted')
      assert.equal(await receipts.begin(identity, 'pending', fingerprint), 'pending')
      assert.equal(await receipts.begin(identity, 'unknown', fingerprint), 'unknown')
      assert.equal(await receipts.begin(identity, 'retry', fingerprint), 'new')
      await receipts.settle(identity, 'retry', 'accepted')
      await assert.rejects(receipts.begin(identity, 'accepted', 'b'.repeat(64)), ImDeliveryStoreError)
      await assert.rejects(receipts.advance(identity, 0, 1), ImDeliveryStoreError)
    })
    await withPostgresImDeliveryStore(database, { ...identity, runId: 'other' }, async receipts => {
      assert.equal(await receipts.cursor({ ...identity, runId: 'other' }), 0)
      assert.equal(await receipts.begin({ ...identity, runId: 'other' }, 'accepted', fingerprint), 'new')
    })
    await assert.rejects(withPostgresImDeliveryStore(database, { ...identity, sessionId: '22' }, receipts => receipts.cursor({ ...identity, sessionId: '22' })), ImDeliveryStoreError)
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
