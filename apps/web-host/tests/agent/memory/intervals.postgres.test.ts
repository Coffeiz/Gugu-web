import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { clearWebReflectionIntervals, createPostgresWebReflectionIntervals } from '../../../src/modules/agent/memory/reflection/intervals.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Web 反思冻结闲置区间，重启和失租后保持原窗口，并隔离后来消息', {
  skip: !url && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `reflection_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const owner = randomUUID(), other = randomUUID()
  let clock = Date.now()
  const open = () => createPostgresWebReflectionIntervals({ pool, now: () => new Date(clock), modelScope: () => 'synthetic', secretKey: 'synthetic-candidate-secret' })
  const pending = open()
  async function enqueue(seq: number, ownerId = owner) {
    return pending.enqueue({
      identity: { ownerId, sessionId: '10', runId: `run-${seq}` },
      userMessageId: String(seq), modelIdentity: 'synthetic-model', accessScopeHash: 'synthetic-scope',
      userMessage: '请整理合成资料', usedTools: false,
    })
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await migratePostgres(pool, 'apply')
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    for (const id of [owner, other])
      await pool.query('INSERT INTO users(id,username,email,hashed_password) VALUES($1::uuid,$1::uuid::text,$1::uuid::text,\'synthetic\')', [id])
    await pool.query("INSERT INTO conversation_sessions(id,user_id,execution_state) VALUES(10,$1,'idle')", [owner])
    for (const seq of [1, 2, 3, 4, 5, 6])
      await pool.query("INSERT INTO conversation_messages(id,session_id,conversation_seq,role,run_id) VALUES($1::integer,10,$1::integer,'user',$2)", [seq, `run-${seq}`])
    assert.equal(await enqueue(1, other), false)
    assert.equal(await enqueue(1), true)
    assert.equal(await enqueue(1), false)
    clock += 179_999
    assert.equal(await pending.claim(), null)
    assert.equal(await enqueue(2), true)
    clock += 180_000
    const raced = await Promise.all([pending.claim(), open().claim()])
    const first = raced.find(batch => batch !== null)
    assert.equal(raced.filter(Boolean).length, 1)
    assert.ok(first)
    assert.deepEqual(first.turns.map(turn => turn.seq), ['1', '2'])
    assert.equal(await enqueue(3), true)
    assert.equal(await first.retry(30_000), true)
    assert.equal(await open().claim(), null)
    clock += 30_000
    const recovered = await open().claim()
    assert.equal(recovered?.batchId, first.batchId)
    assert.equal(await first.complete(), false)
    assert.equal(await recovered?.split(), true)
    const split = await open().claim()
    assert.deepEqual(split?.turns.map(turn => turn.seq), ['1'])
    assert.equal(await split?.complete(), true)
    const tail = await open().claim()
    assert.deepEqual(tail?.turns.map(turn => turn.seq), ['2'])
    assert.equal(await tail?.complete(), true)
    assert.equal(await open().claim(), null)
    clock += 150_000
    const later = await open().claim()
    assert.deepEqual(later?.turns.map(turn => turn.seq), ['3'])
    clock += 180_000
    const replacement = await open().claim()
    assert.equal(replacement?.batchId, later?.batchId)
    assert.equal(await later?.complete(), false)
    assert.equal(await replacement?.complete(), true)
    assert.equal((await pool.query('SELECT completed_through FROM web_reflection_intervals')).rows[0]?.completed_through, '3')
    assert.equal(await enqueue(4), true)
    assert.equal(await enqueue(5), true)
    assert.equal(await enqueue(6), true)
    const identity = { ownerId: owner, sessionId: '10', runId: 'compress' }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await open().stageCompaction(client, identity, ['4'])
      await client.query('ROLLBACK')
    } finally { client.release() }
    assert.equal(await open().claim(), null, '压缩回滚不得提前触发')
    await open().stageCompaction(pool, { ...identity, ownerId: other }, ['4'])
    await open().stageCompaction(pool, identity, ['5'])
    assert.equal(await open().claim(), null, '跨账号及非连续覆盖不领取')
    const plan = await open().prepareCompaction(identity, ['4'])
    assert.deepEqual(plan?.userIds, ['4'])
    const output = {
      daily: '合成候选',
      profile_add: [{ type: 'preference', text: '偏好清茶' }],
      pattern_add: [{ kind: 'observed', text: '先列提纲再写正文', importance: 3 }],
    }
    const transaction = await pool.connect()
    try {
      await transaction.query('BEGIN')
      await open().stageCompaction(transaction, identity, ['4'])
      await plan!.stage(transaction, { profile_remove: ['旧偏好'], summary: '旧摘要' }, '失效证据')
      await plan!.stage(transaction, output, '合成证据')
      await transaction.query('COMMIT')
    } finally { transaction.release() }
    assert.doesNotMatch(JSON.stringify((await pool.query('SELECT pending FROM web_reflection_intervals')).rows), /合成候选/)
    const compacted = await open().claim()
    assert.deepEqual(compacted?.turns.map(turn => turn.seq), ['4'])
    assert.deepEqual(compacted?.compactionCandidate, { output, evidence: '合成证据' })
    await open().stageCompaction(pool, identity, ['5'])
    assert.equal(await compacted?.retry(1000), true)
    assert.equal(await open().claim(), null, '新压缩不得跳过旧失败区间')
    clock += 1000
    const compactedRetry = await open().claim()
    assert.equal(compactedRetry?.batchId, compacted?.batchId)
    assert.equal(await compactedRetry?.complete(), true)
    const nextCompacted = await open().claim()
    assert.deepEqual(nextCompacted?.turns.map(turn => turn.seq), ['5'])
    assert.equal(await nextCompacted?.complete(), true)
    assert.equal(await open().claim(), null, '最新受保护回合继续等待 TTL')
    await pool.query('UPDATE conversation_sessions SET last_message_seq=7 WHERE id=10')
    clock += 180_000
    const interrupted = await open().claim()
    assert.ok(interrupted)
    await clearWebReflectionIntervals(pool, owner)
    assert.equal(await interrupted.isCurrent(), false)
    assert.equal(await interrupted.complete(), false)
    await pool.query("INSERT INTO conversation_messages(id,session_id,conversation_seq,role,run_id) VALUES(7,10,7,'user','run-7'),(8,10,8,'user','run-8')")
    assert.equal(await enqueue(7), false, '清除前启动的回合不能重新登记')
    assert.equal(await enqueue(8), true, '清除后的新回合可以登记')
    assert.equal(await open().claim(), null)
    await pool.query('DELETE FROM conversation_sessions WHERE id=10')
    assert.equal((await pool.query('SELECT 1 FROM web_reflection_intervals')).rowCount, 0)
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
