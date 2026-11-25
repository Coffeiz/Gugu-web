import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { attentionMessageFromPayload } from '@gugu/core/im/attention/message'
import { migratePostgres } from '@gugu/database/postgres'
import { Pool } from 'pg'
import { createPostgresRedisImAttentionSnapshot } from '../../../../src/modules/im/gateway/attention/snapshot.js'
import { createImInboundEnvelope } from '../../../../src/modules/im/gateway/inbound/envelope.js'
import { createPostgresImIngress } from '../../../../src/modules/im/gateway/inbound/ingress.js'
import { createPostgresImInbox } from '../../../../src/modules/im/gateway/inbound/postgres-queue.js'
import { createNodeImWorker } from '../../../../src/modules/im/gateway/worker.js'

const databaseUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('PostgreSQL 收件跨 worker 重启续接，过期领取不能确认且原消息只登记一个 Run', {
  skip: !databaseUrl && '需要隔离 PostgreSQL', timeout: 30000,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl })
  const schema = `im_queue_${randomUUID().replaceAll('-', '')}`
  const newPool = () => new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  let pool = newPool()
  let worker: ReturnType<typeof createNodeImWorker> | undefined
  const secretKey = randomUUID()
  const ownerId = randomUUID()
  const binding = { ownerId, botId: '71', platform: 'qq' as const }
  const envelope = createImInboundEnvelope(secretKey)
  const payload = { platform: 'qq', owner_user_id: ownerId, bot_id: binding.botId, channel_id: binding.botId,
    chat_type: 'c2c', platform_user_id: 'synthetic-owner', message_id: 'synthetic-101',
    platform_message_id: 'synthetic-101', text: '合成入站恢复', attachments: [] }
  const diagnostics: unknown[] = []
  const until = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await predicate()) return
      await delay(25)
    }
    assert.fail(diagnostics.map(String).join('\n') || '后台收件尚未完成')
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await migratePostgres(pool, 'apply')
    await pool.query("INSERT INTO users(id,username,email,hashed_password) VALUES($1,'synthetic','synthetic@example.test','synthetic')", [ownerId])
    await pool.query(`INSERT INTO user_bots(id,user_id,platform,name,app_id,app_secret,enabled,owner_platform_user_id)
      VALUES($1,$2,'qq','合成','synthetic-bot','synthetic',true,'synthetic-owner')`, [binding.botId, ownerId])
    const inbox = createPostgresImInbox(pool, secretKey)
    const queued = await inbox.enqueue(binding, envelope.sealAdmitted(binding, payload))
    assert.ok(queued)
    const rowId = queued.split('-')[1]!
    const original = randomUUID()
    const consumption = inbox.consume(new AbortController().signal)
    assert.equal(await consumption.claimInbound(rowId, original, 60), 'claimed')
    assert.equal(await consumption.claimInbound(rowId, randomUUID(), 60), 'busy')
    const ingressOptions = {
      secretKey, attachments: { mode: 'text-only' as const }, supportedPlatforms: () => ['qq'],
      preflight: async (): Promise<never> => assert.fail('可信准入不能重新执行控制'),
      model: { async accessVersion() { return 'a'.repeat(64) } }, memoryEnabled: async () => false,
      notify: async () => {}, diagnose: () => {},
    }
    const ingress = createPostgresImIngress({ ...ingressOptions, pool })
    const signal = new AbortController().signal
    assert.equal(await ingress.prepareAdmitted(binding, payload, queued, signal), true)
    await ingress.handleBatch(binding, [{ eventId: queued, payload }], signal)
    const originalRuns = (await pool.query('SELECT run_id FROM agent_run_dispatch')).rows
    assert.equal(originalRuns.length, 1)
    // 模拟进程在 Run 事务提交后、确认队列之前退出。重新建池并让旧租约过期。
    await pool.end()
    pool = newPool()
    await pool.query("UPDATE gugu_im_inbound_queue SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [rowId])
    const reopened = createPostgresImInbox(pool, secretKey)
    assert.equal(await reopened.consume(signal).settleInbound(rowId, original), false)
    assert.equal(await reopened.enqueue(binding, envelope.sealAdmitted(binding, payload)), null)
    worker = createNodeImWorker({ secretKey, inbound: reopened, ingress: createPostgresImIngress({ ...ingressOptions, pool }),
      batchDelayMs: 1, concurrency: 1, ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true },
      diagnose: (code, error) => diagnostics.push(error ?? code) })
    await worker.start()
    await until(async () => (await pool.query('SELECT settled_at FROM gugu_im_inbound_queue WHERE id=$1', [rowId])).rows[0]?.settled_at != null)
    assert.deepEqual((await pool.query('SELECT run_id FROM agent_run_dispatch')).rows, originalRuns)
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM conversation_messages WHERE role='user'")).rows[0].n, 1)

    await worker.stop()
    worker = undefined
    await pool.query("UPDATE gugu_im_inbound_queue SET settled_at=clock_timestamp()-interval '31 minutes' WHERE id=$1", [rowId])
    await reopened.clearCompletedPayloads()
    assert.equal((await pool.query('SELECT payload FROM gugu_im_inbound_queue WHERE id=$1', [rowId])).rows[0].payload, null)
    assert.equal(await reopened.enqueue(binding, envelope.sealAdmitted(binding, payload)), null)
    await pool.query("UPDATE user_bots SET group_chat_enabled=true WHERE id=71")
    const groupId = 'synthetic-group'
    const session = await pool.query<{ id: number }>(`INSERT INTO conversation_sessions (user_id,source,bot_id,chat_id,chat_type)
      VALUES($1,'qq','71',$2,'group') RETURNING id`, [ownerId, groupId])
    const history = { ...payload, chat_type: 'group', chat_id: groupId, message_id: 'history-event', platform_message_id: 'history-message' }
    const historyId = await reopened.enqueue(binding, envelope.sealAdmitted(binding, history))
    assert.ok(historyId)
    const watermarkMs = Number(historyId.split('-')[0]) + 1
    const current = attentionMessageFromPayload(`${watermarkMs}-0`, { ...history, platform_message_id: 'current-message' })
    const snapshot = createPostgresRedisImAttentionSnapshot({ pool, secretKey, postgresInbox: true,
      redis: { async sendCommand() { assert.fail('新队列的注意力窗口不读 Redis') } },
      acceptedFacts: { async read() { return [] } },
    })
    const group = await snapshot.load({ scope: { ...binding, groupId }, sessionId: session.rows[0]!.id,
      messages: [current], watermarkMs }, signal)
    assert.deepEqual(group.messages.map(message => message.eventId), [historyId, current.eventId])

    const telegram = { ...binding, platform: 'telegram' as const, botId: '72' }
    await pool.query(`INSERT INTO user_bots(id,user_id,platform,name,app_id,app_secret,enabled)
      VALUES($1,$2,'telegram','合成','synthetic-telegram','synthetic',true)`, [telegram.botId, ownerId])
    const telegramInbox = reopened.telegram(telegram, { cursor: async () => 90 })
    assert.equal(await telegramInbox.cursor(), 90)
    const telegramPayload = { ...payload, platform: 'telegram', bot_id: '72', channel_id: '72', message_id: '91' }
    await pool.query("ALTER TABLE gugu_im_inbound_queue ADD CONSTRAINT synthetic_no_telegram CHECK(platform <> 'telegram')")
    await assert.rejects(telegramInbox.commit(91, telegramPayload))
    assert.equal(await telegramInbox.cursor(), 90, '入队失败时不得推进 Telegram 游标')
    await pool.query('ALTER TABLE gugu_im_inbound_queue DROP CONSTRAINT synthetic_no_telegram')
    await telegramInbox.commit(91, telegramPayload)
    await telegramInbox.commit(91, telegramPayload)
    assert.equal(await reopened.telegram(telegram, { cursor: async () => assert.fail('已提交游标无需回读 Redis') }).cursor(), 91)
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM gugu_im_inbound_queue WHERE platform='telegram'")).rows[0].n, 1)
  } finally {
    await worker?.stop()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
