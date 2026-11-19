import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { enqueueAgentRunLocked } from '../../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createImHostScans } from '../../../src/modules/im/gateway/host-scans.js'
import { createImProductionFixture } from './production.fixtures.js'
import { createPostgresImConversationStore } from '../../../src/modules/im/gateway/conversation-postgres.js'
import { registerAgentRunStartupLocked } from '../../../src/modules/agent-sessions/persistence/agent-run-startup-postgres.js'

const secret = 'synthetic-scan-secret', owner = '11111111-1111-4111-8111-111111111111'
type Row = { user_id: string; session_id: number; run_id: string; nonce: Buffer; payload: Buffer; scan_sequence: string }
let sequence = 0
async function row(session: number, source: 'web' | 'im', run = `run-${session}`): Promise<Row> {
  let saved!: Row
  // 只替换SQL读写；仍使用正式enqueue的加密/AAD与扫描的严格v3解密。真实候选SQL由bootstrap验收。
  const client = { async query(sql: string, values: unknown[]) {
    if (sql.startsWith('INSERT INTO agent_run_dispatch')) saved = { user_id: owner, session_id: session, run_id: run,
      nonce: values[3] as Buffer, payload: values[4] as Buffer, scan_sequence: String(++sequence) }
    return { rows: [{}], rowCount: 1 }
  } } as unknown as PoolClient
  const base = { userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) }
  await enqueueAgentRunLocked(client, secret, { ownerId: owner, sessionId: String(session), runId: run }, source === 'web'
    ? { ...base, v: 2, source } : { ...base, v: 3, source, im: { platform: 'telegram', botId: '1', chatType: 'c2c', chatId: null, platformUserId: '202' } }, 3600)
  return saved
}
const pool = (rows: Row[]) => ({ query: async (_sql: string, values: string[]) => {
  const selected = rows.filter(row => BigInt(row.scan_sequence) > BigInt(values[0]!))
  return { rows: selected, rowCount: selected.length }
} }) as unknown as Pick<Pool, 'query'>

test('恢复扫描只调度真实IM，按会话去重和有界并发，close等待已运行任务排空', async () => {
  const rows = await Promise.all([row(9, 'web'), row(1, 'im'), row(1, 'im', 'same-session-next'), row(2, 'im'), row(3, 'im')])
  const started: string[] = [], finish: Array<() => void> = []
  const scans = createImHostScans({ pool: pool(rows), secretKey: secret, concurrency: 2,
    async kick(_owner, session) { started.push(session); await new Promise<void>(resolve => finish.push(resolve)) }, recover: async () => {} })
  await scans.scanDispatch(new AbortController().signal); await scans.scanDispatch(new AbortController().signal)
  assert.deepEqual(started, ['1', '2']); assert.equal(scans.health().active, 2)
  let closed = false; const closing = scans.close().then(() => { closed = true })
  await Promise.resolve(); assert.equal(closed, false)
  finish.forEach(done => done()); await closing
  await scans.scanDispatch(new AbortController().signal); assert.deepEqual(started, ['1', '2'])
})

test('后台调度失败转成固定健康错误，不能泄漏任务异常；下一轮仍能恢复', async () => {
  let fail = true, count = 0
  const scans = createImHostScans({ pool: pool([await row(1, 'im')]), secretKey: secret,
    async kick() { count++; if (fail) throw new Error('synthetic-private-task') }, recover: async () => {} })
  await scans.scanDispatch(new AbortController().signal)
  await new Promise<void>(resolve => setImmediate(resolve))
  await assert.rejects(scans.scanDispatch(new AbortController().signal), { message: 'IM 调度后台执行失败' })
  fail = false
  await scans.scanDispatch(new AbortController().signal) // 空页回卷，不声称已成功执行。
  await scans.scanDispatch(new AbortController().signal)
  await scans.close(); assert.equal(count, 2)
})

test('出站恢复验证来源，一项失败仍处理后续项，取消后不继续派发且错误不带正文', async () => {
  const recovered: string[] = [], controller = new AbortController()
  const scans = createImHostScans({ pool: pool(await Promise.all([row(9, 'web'), row(1, 'im'), row(2, 'im')])), secretKey: secret,
    kick: async () => {}, async recover(identity) { recovered.push(identity.sessionId); if (identity.sessionId === '1') throw new Error('synthetic-private-delivery') } })
  await assert.rejects(scans.recoverDeliveries(controller.signal), { message: 'IM 出站恢复尚未完成' })
  assert.deepEqual(recovered, ['1', '2'])
  controller.abort(); await assert.rejects(scans.recoverDeliveries(controller.signal)); assert.deepEqual(recovered, ['1', '2'])
  await scans.close()
})

test('真实PG公平扫描：129条同会话不挡其他会话，33条unknown出站不挡后续且不推进坏收据cursor', {
  skip: !(process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL && process.env.GUGU_IM_FIXTURE_PYTHON) && '需显式隔离PG及离线ORM解释器', timeout: 120000,
}, async () => {
  const f = await createImProductionFixture({ python: process.env.GUGU_IM_FIXTURE_PYTHON! })
  try {
    const binding = { ownerId: f.ownerId, platform: 'telegram' as const, botId: f.botId }, anchors: { sessionId: number; runId: string }[] = []
    // 准入授权和任务执行是显式端口替身；持久会话/锚点/密封收据/派发密文与扫描SQL全部实际运行。
    const conversations = createPostgresImConversationStore({ pool: f.pool, secretKey: f.secretKey,
      authorize: async () => true, classify: async () => 'reply', attachments: { mode: 'text-only' } })
    for (let i = 1; i <= 130; i++) {
      const sender = i === 130 ? '303' : '202'
      await conversations.persist(binding, { platform: 'telegram', owner_user_id: f.ownerId, bot_id: f.botId, channel_id: f.botId,
        chat_type: 'c2c', chat_id: null, platform_user_id: sender, message_id: String(i), platform_message_id: String(i), text: '合成积压消息' }, {
        mode: 'dispatch', eventId: `${i}-0`, async onDispatch(client, anchor) {
          const runId = randomUUID(), identity = { ownerId: f.ownerId, sessionId: String(anchor.sessionId), runId }
          await registerAgentRunStartupLocked(client, identity)
          await enqueueAgentRunLocked(client, f.secretKey, identity, { v: 3, source: 'im', userMessageId: anchor.messageId,
            locale: null, origin: null, accessVersion: 'a'.repeat(64), im: { platform: 'telegram', botId: f.botId, chatType: 'c2c', chatId: null, platformUserId: sender } }, 3600)
          anchors.push({ sessionId: anchor.sessionId, runId }); return runId
        },
      })
    }
    const kicked: string[] = [], finishes: Array<() => void> = []
    const dispatcher = createImHostScans({ pool: f.pool, secretKey: f.secretKey, concurrency: 2,
      async kick(_owner, session) { kicked.push(session); await new Promise<void>(done => finishes.push(done)) }, recover: async () => {} })
    await dispatcher.scanDispatch(new AbortController().signal)
    assert.deepEqual(kicked, [String(anchors[0]!.sessionId), String(anchors[129]!.sessionId)])
    finishes.forEach(done => done()); await dispatcher.close()
    for (const [index, anchor] of anchors.slice(0, 34).entries()) {
      await f.insert('agent_run_checkpoints', { user_id: f.ownerId, session_id: anchor.sessionId, run_id: anchor.runId,
        version: 1, sequence: 1, status: 'completed', phase: 'finalize', nonce: Buffer.alloc(12), payload: Buffer.alloc(16) })
      await f.insert('agent_run_events', { user_id: f.ownerId, session_id: anchor.sessionId, run_id: anchor.runId,
        event_id: randomUUID(), sequence: 1, nonce: Buffer.alloc(12), payload: Buffer.alloc(16) })
      await f.pool.query('INSERT INTO gugu_im_run_delivery(user_id,session_id,run_id,cursor) VALUES($1,$2,$3,0)', [f.ownerId, anchor.sessionId, anchor.runId])
      if (index < 33) await f.pool.query("INSERT INTO gugu_im_delivery_receipts VALUES($1,$2,$3,'final',$4,'unknown',$5)",
        [f.ownerId, anchor.sessionId, anchor.runId, 'a'.repeat(64), randomUUID()])
    }
    let delivered = 0
    const recovery = createImHostScans({ pool: f.pool, secretKey: f.secretKey, kick: async () => {}, async recover(identity) {
      if (identity.runId !== anchors[33]!.runId) throw new Error('合成unknown投递端口')
      delivered++
      await f.pool.query('UPDATE gugu_im_run_delivery SET cursor=1 WHERE user_id=$1 AND session_id=$2 AND run_id=$3', [identity.ownerId, identity.sessionId, identity.runId])
    } })
    await assert.rejects(recovery.recoverDeliveries(new AbortController().signal), { message: 'IM 出站恢复尚未完成' })
    assert.equal(delivered, 0)
    await assert.rejects(recovery.recoverDeliveries(new AbortController().signal), { message: 'IM 出站恢复尚未完成' })
    assert.equal(delivered, 1)
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM gugu_im_run_delivery WHERE cursor=0")).rows[0].n, 33)
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM gugu_im_delivery_receipts WHERE state='unknown'")).rows[0].n, 33)
    // 空页只回卷轮询水位；旧unknown下一轮仍复核，不被候选分页伪装成已确认。
    await recovery.recoverDeliveries(new AbortController().signal)
    await assert.rejects(recovery.recoverDeliveries(new AbortController().signal), { message: 'IM 出站恢复尚未完成' })
    assert.equal(delivered, 1)
    await recovery.close()
  } finally { await f.close() }
})
