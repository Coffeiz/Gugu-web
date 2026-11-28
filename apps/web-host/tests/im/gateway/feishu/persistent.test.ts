import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool } from 'pg'
import { createAgentRunner, projectPersistentToolResult, type AgentRunnerPorts, type InteractionResolution, type RunCheckpoint, type RunEvent } from '@gugu/core/agent'
import { createImRunDelivery, ImRunDeliveryBlocked } from '@gugu/core/im/run-delivery'
import type { ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import { createFeishuClient } from '@gugu/gateway/feishu'
import { createPersistentFeishuProjection } from '../../../../src/modules/im/gateway/platforms/feishu/persistent.js'
import { withPostgresImDeliveryStore, type ImDeliverySession } from '../../../../src/modules/im/gateway/delivery/store.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000096', sessionId: '1', runId: 'synthetic-feishu-run' }
const secretKey = 'synthetic-feishu-projection-secret'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const event = (sequence: number, type: RunEvent['type'], payload: RunEvent['payload'] = {}): RunEvent => ({ id: `event-${sequence}`, identity, sequence, round: 1, type, payload })
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
const url = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
async function database(work: (pool: Pool) => Promise<void>) {
  const { Pool } = await import('pg'), schema = `im_feishu_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url }), pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid)')
    await pool.query('INSERT INTO users VALUES($1)', [identity.ownerId])
    await pool.query('INSERT INTO conversation_sessions VALUES(1,$1),(2,$1)', [identity.ownerId])
    await pool.query(imGatewaySql.delivery)
    await work(pool)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
}
function platform() {
  const requests: { path: string; body: Buffer }[] = []
  let cards = 0, messages = 0, images = 0, fail: ((path: string) => boolean) | null = null
  const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport: { async request(request) {
    const path = new URL(request.url).pathname, body = Buffer.from(request.body as Uint8Array)
    if (!path.includes('/auth/')) requests.push({ path, body })
    if (fail?.(path)) return { status: 503, headers: {}, body: (async function* () { yield Buffer.from('{"synthetic-secret":"never-public"}') })(), cancel: async () => {} }
    const data = path.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }
      : path.endsWith('/cards') ? { code: 0, data: { card_id: `card_${++cards}` } }
        : path.endsWith('/messages') ? { code: 0, data: { message_id: `om_${++messages}` } }
          : path.endsWith('/images') ? { code: 0, data: { image_key: `img_${++images}` } } : { code: 0 }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })(), cancel: async () => {} }
  } } })
  return { client, requests, fail(value: typeof fail) { fail = value } }
}

/** 明确的内存RunStore/租约/业务上下文/交互激活端口；事件循环与coordinator使用真实Harness。 */
async function interactionEvents(kind: 'question' | 'credential', status: InteractionResolution['status'], queued = false) {
  let state: RunCheckpoint<string[]> | null = null, fence = 0, activeFence = 0, providerCalls = 0, presented = 0
  const pending = new Map<string, RunEvent>(), events: RunEvent[] = []
  const calls = [{ id: 'normal', name: 'read_public', input: {} }, { id: 'first', name: 'ask', input: {} }, ...(queued ? [{ id: 'second', name: 'ask_next', input: {} }] : [])]
  const ports: AgentRunnerPorts<string[]> = {
    clock: { now: () => '2026-01-01T00:00:00Z' },
    store: {
      async read() { return state }, async create(value, _lease, committed) { assert.equal(state, null); state = structuredClone(value); committed.forEach(value => pending.set(value.id, value)) },
      async commit(change) { assert.equal(state?.version, change.expectedVersion); state = structuredClone(change.checkpoint); change.events.forEach(value => pending.set(value.id, value)) },
      async pendingEvents() { return [...pending.values()].sort((a, b) => a.sequence - b.sequence) }, async acknowledgeEvents(_id, ids) { ids.forEach(id => pending.delete(id)) },
    },
    leases: { async acquire() { activeFence = ++fence; return { token: `synthetic-${fence}`, fence } }, async assert(_id, lease) { assert.equal(lease.fence, activeFence) }, async release() { activeFence = 0 } },
    cancellation: { async isRequested() { return false }, async request() {}, async notify() {}, async subscribe() { return () => {} } },
    provider: { async *stream() { providerCalls++; if (providerCalls === 1) { yield { type: 'token', text: '交互前正文' }; yield { type: 'complete', text: '交互前正文', calls } }
      else { yield { type: 'token', text: '恢复后的正文' }; yield { type: 'complete', text: '恢复后的正文', calls: [] } } } },
    context: { assertIdentity(_id, context) { assert.equal(context[0], '合成可信上下文') }, async prepare() { return ['合成可信上下文'] }, async checkpointToolResult(_scope, value) { return value }, async restoreToolResult(_scope, value) { return value },
      async afterRound(context) { return context }, async afterTool(context) { return context }, async resumeInteraction(context) { return context }, async recoverOverflow(context) { return { context, applied: false } }, async afterUsage(context) { return { context, applied: false } } },
    tools: { async plan() { return { mode: 'parallel', maxConcurrency: 3 } }, async dispatch(call) {
      return call.id === 'normal' ? { kind: 'completed', successful: true, mutated: false, value: { body: '公开业务结果' } }
        : { kind: 'waiting', interaction: { id: `prompt-${call.id}`, kind: call.id === 'first' ? kind : 'question', toolCall: call } }
    }, async reconcile() { return { kind: 'unknown' } } },
    interactions: { async activate(_id, request) { return request } }, execution: { async execute() { throw Error('不应运行进程') } }, reply: { async evaluate() { return 'accept' } },
    sanitizeText: text => text, createStreamSanitizer: () => ({ feed: text => text, flush: () => '' }), presentError: () => ({ code: 'failed', text: '运行未完成' }),
    async presentToolResult(value) { presented++; return projectPersistentToolResult(value) }, async publish() {}, diagnose() {},
  }
  async function collect(source: AsyncIterable<RunEvent>) { for await (const value of source) events.push(value) }
  const harness = createAgentRunner(ports)
  await collect(harness.start(identity))
  await collect(harness.resume(identity, { interactionId: 'prompt-first', receiptId: 'synthetic-first', status, value: kind === 'credential' ? 'synthetic-credential-value-must-not-leak' : '合成问题答案' }))
  if (queued && status === 'answered') await collect(harness.resume(identity, { interactionId: 'prompt-second', receiptId: 'synthetic-second', status: 'answered', value: '合成第二答案' }))
  assert.ok(presented > 0)
  assert.doesNotMatch(JSON.stringify(events), /synthetic-credential-value-must-not-leak/)
  return { events, providerCalls }
}

test('持久流必须提供实际加密store，不能只用普通receipt接口假装完成', () => {
  assert.throws(() => createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'v1', receipts: {} as ImDeliverySession,
    client: { async call() { throw Error('不得请求') } }, authorize: async () => true }), /未配置/)
})

test('真实PG/飞书HTTP替身：只在最终可见card关闭确认后返回正文证据，重建投影不重发；关闭未知不产事实', { skip: !url && '需要显式隔离PG' }, async () => {
  const scope = { ownerId: identity.ownerId, platform: 'feishu' as const, botId: '42', chatType: 'group' as const, chatId: 'oc_synthetic', platformUserId: 'ou_synthetic_member' }
  const proof = { scope, recipient: scope.chatId, async source() { return { sourceEventIds: ['1800000000000-1'], sourceMessageIds: ['om_inbound'], sourceEventIdsComplete: true } } }
  for (const fail of [false, true]) await database(async pool => {
    const p = platform()
    try {
      await withPostgresImDeliveryStore(pool, identity, async receipts => {
        const create = () => createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'evidence-v1', receipts,
          client: p.client, authorize: async () => true, acceptedEvidence: proof })
        let stream = create()
        assert.equal(await stream.project({ identity, event: event(1, 'token', { text: '已投递的合成正文' }), deliveryId: 'token' }), 'accepted')
        if (fail) p.fail(path => path.includes('/cardkit/') && !path.endsWith('/cards'))
        const finalEvent = event(2, 'final', { text: '已投递的合成正文', status: 'completed' })
        const acknowledgement = await stream.project({ identity, event: finalEvent, deliveryId: 'final' })
        if (fail) assert.equal(acknowledgement, 'unknown')
        else {
          assert.equal(typeof acknowledgement, 'object')
          const accepted = acknowledgement as { outcome: string; evidence: Record<string, unknown> }
          assert.equal(accepted.outcome, 'accepted'); assert.equal(accepted.evidence.text, '已投递的合成正文')
          assert.equal(accepted.evidence.contentHash, createHash('sha256').update('已投递的合成正文').digest('hex'))
          assert.deepEqual(accepted.evidence.platformMessageIds, ['om_1']); assert.deepEqual(accepted.evidence.sourceEventIds, ['1800000000000-1'])
        }
        const count = p.requests.length; stream = create()
        assert.deepEqual(await stream.project({ identity, event: finalEvent, deliveryId: 'final' }), acknowledgement)
        assert.equal(p.requests.length, count)
      }, { secretKey })
    } finally { await p.client.close() }
  })
})

test('真实Harness回答/取消/过期/中止及排队问题按实际coordinator顺序投递，credential值不进入私聊详情', {
  skip: !url && '需隔离PG，Harness的RunStore/上下文/租约端口明确为内存替身', timeout: 30000,
}, async () => {
  for (const kind of ['question', 'credential'] as const) for (const status of ['answered', 'cancelled', 'expired', 'aborted'] as const) await database(async pool => {
    const actual = await interactionEvents(kind, status, status === 'answered'), p = platform()
    try {
      const types = actual.events.map(value => value.type)
      const resolved = types.indexOf('interaction_resolved')
      assert.ok(resolved >= 0)
      assert.equal(types[resolved + 1], 'tool_done', '真实coordinator先tool_done，不能要求run_resumed先来')
      await withPostgresImDeliveryStore(pool, identity, async receipts => {
        const delivery = createImRunDelivery({ runner: { start() { assert.fail('应消费实际Harness已提交事件，不重启') } },
          events: { async readAfter(_id, after) { return actual.events.filter(value => value.sequence > after) } }, receipts, digest, authorize: async () => true,
          stream: createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'explicit-synthetic-format-v1', receipts, client: p.client, authorize: async () => true,
            toolSummary: { chatType: 'p2p', includeDetails: true, sanitize: text => text.replace(/<think>[\s\S]*?<\/think>/g, '') } }),
          sender: { async text() { assert.fail('不应旁路发送正文') }, async artifact() { return 'accepted' }, async interaction() { return 'accepted' } },
        })
        await delivery.consume(identity, (async function* () { yield* actual.events })())
        const before = p.requests.length
        await delivery.recover(identity)
        assert.equal(p.requests.length, before)
        const saved = (await receipts.projection!.read()).state as any
        assert.equal(saved.stage, 'finished')
        assert.equal(saved.segment, status === 'answered' ? 1 : 0, '排队问题不能提前开卡或同回答开两次segment')
      }, { secretKey })
      assert.equal(p.requests.filter(value => value.path.endsWith('/messages')).length, status === 'answered' ? 2 : 1)
      assert.doesNotMatch(p.requests.map(value => value.body.toString()).join(''), /synthetic-credential-value-must-not-leak/)
      assert.equal(actual.providerCalls, status === 'answered' ? 2 : 1)
    } finally { await p.client.close() }
  })
})

test('真实client token刷新后与普通fallback两次HTTP之间都重新授权，撤权不发业务或第二条文本', {
  skip: !url && '需隔离PG验证fallback持久意图', timeout: 30000,
}, async () => database(async pool => {
  let allowed = true, race = true
  const sent: string[] = []
  const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport: { async request(request) {
    const path = new URL(request.url).pathname
    let status = 200, data: Record<string, unknown>
    if (path.includes('/auth/')) { if (race) allowed = false; data = { code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 } }
    else if (path.endsWith('/cards')) { status = 403; data = { code: 1 } }
    else { const body = JSON.parse(Buffer.from(request.body as Uint8Array).toString()); sent.push(body.msg_type); allowed = false; status = 400; data = { code: 1 } }
    return { status, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })(), cancel: async () => {} }
  } } })
  try {
    await assert.rejects(client.call('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', { body: { receive_id: 'oc_synthetic', msg_type: 'text', content: '{}' }, authorize: async () => allowed }))
    assert.deepEqual(sent, [], 'auth刷新等待期间撤权不能发第一条业务HTTP')
    race = false; allowed = true
    await withPostgresImDeliveryStore(pool, identity, async receipts => {
      const stream = createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'v1', receipts, client, authorize: async () => allowed })
      assert.equal(await stream.project({ identity, deliveryId: 'token', event: event(1, 'token', { text: '合成正文' }) }), 'accepted')
      assert.equal(await stream.project({ identity, deliveryId: 'final', event: event(2, 'final', { text: '合成正文', status: 'completed' }) }), 'rejected')
      assert.deepEqual(sent, ['interactive'], 'interactive明确拒绝后撤权也不能发送纯text回退')
    }, { secretKey })
  } finally { await client.close() }
}))

test('真实PG加密流投影→真实Feishu client，图表/工具/交互segment与recover不重发正文或重跑Provider', {
  skip: !url && '需显式隔离PG；内存收据不能验证原子提交与恢复', timeout: 30000,
}, async () => database(async pool => {
  const p = platform(), source = '```mermaid\ngraph LR; A-->B\n```'
  const events = [event(1, 'run_started'), event(2, 'token', { text: '合成正文\n' + source + '\n' }), event(3, 'round_end', { text: '合成正文\n' + source }),
    event(4, 'tool_done', { name: 'search', toolCallId: 'call', status: 'success', result: 'synthetic-private-result' }),
    event(5, 'interaction_required', { interactionId: 'prompt', kind: 'question', toolCallId: 'ask' }), event(6, 'run_resumed'),
    event(7, 'token', { text: '恢复尾文' }), event(8, 'final', { text: '恢复尾文', status: 'completed' })]
  let providerStarts = 0, interactions = 0
  async function run(recover: boolean) { await withPostgresImDeliveryStore(pool, identity, async receipts => {
    const stream = createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'v1', receipts, client: p.client,
      authorize: async () => true, renderCharts: async () => [png], toolSummary: { chatType: 'group', sanitize: text => text } })
    const delivery = createImRunDelivery({ runner: { start: (async function* () { providerStarts++; yield* events }) as unknown as ImRunDeliveryPorts<unknown>['runner']['start'] }, events: { async readAfter(_id, after) { return events.filter(item => item.sequence > after) } },
      receipts, digest, authorize: async () => true, stream, sender: { async text() { assert.fail('流式正文不能从普通sender再次发送') }, async artifact() { return 'accepted' }, async interaction() { interactions++; return 'accepted' } } })
    if (recover) await delivery.recover(identity); else await delivery.start(identity)
  }, { secretKey }) }
  try {
    await run(false)
    assert.equal(providerStarts, 1); assert.equal(interactions, 1)
    assert.equal(p.requests.filter(item => item.path.endsWith('/messages')).length, 2, 'waiting之后实际resume才创建下一segment')
    assert.equal(p.requests.filter(item => item.path.endsWith('/images')).length, 1)
    const before = p.requests.length
    await run(true)
    assert.equal(p.requests.length, before); assert.equal(providerStarts, 1); assert.equal(interactions, 1)
    const row = (await pool.query('SELECT version,nonce,payload FROM gugu_im_platform_projection')).rows[0]
    assert.equal(row.nonce.length, 12); assert.equal(row.payload.includes(Buffer.from('合成正文')), false)
    assert.equal(row.payload.includes(Buffer.from('synthetic-private-result')), false)
    await withPostgresImDeliveryStore(pool, identity, async receipts => {
      const saved = await receipts.projection!.read()
      assert.equal((saved.state as any).stage, 'finished'); assert.equal((saved.state as any).segment, 1); assert.equal((saved.state as any).eventSequence, 8)
      assert.equal((saved.state as any).cardId, 'card_2')
    }, { secretKey })
    const editBodies = p.requests.filter(item => /\/card_\d/.test(item.path)).map(item => JSON.parse(item.body.toString()))
    assert.ok(editBodies.every(item => Number.isSafeInteger(item.sequence) && item.sequence > 0))
    assert.doesNotMatch(editBodies.map(item => JSON.stringify(item)).join(''), /synthetic-private-result/)
  } finally { await p.client.close() }
}))

test('平台发送未知或成功后DB中断均保留pending，重建recover不再建卡/桥接/全文发送', {
  skip: !url && '需显式隔离PG故障注入', timeout: 30000,
}, async () => {
  for (const mode of ['create', 'bridge', 'update', 'close', 'commit'] as const) await database(async pool => {
    const p = platform(), events = [event(1, 'token', { text: 'x'.repeat(40) }), event(2, 'final', { status: 'completed', text: '最终合成正文' })]
    let started = 0, drained = false
    if (mode !== 'commit') p.fail(path => mode === 'create' ? path.endsWith('/cards') : mode === 'bridge' ? path.endsWith('/messages') : mode === 'close' ? path.endsWith('/settings') : path.includes('/elements/'))
    async function run(recover: boolean) { await withPostgresImDeliveryStore(pool, identity, async receipts => {
      const actual = receipts.projection!
      const injected: ImDeliverySession = mode === 'commit' ? { ...receipts, projection: { ...actual, async accepted() { throw Error('synthetic-commit-failure') } } } : receipts
      const delivery = createImRunDelivery({ runner: { start: (async function* () { started++; try { yield* events } finally { drained = true } }) as unknown as ImRunDeliveryPorts<unknown>['runner']['start'] }, events: { async readAfter(_id, after) { return events.filter(item => item.sequence > after) } },
        receipts, digest, authorize: async () => true,
        stream: createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'v1', receipts: injected, client: p.client, authorize: async () => true }),
        sender: { async text() { assert.fail('不得回退重发全文') }, async artifact() { return 'accepted' }, async interaction() { return 'accepted' } } })
      if (recover) await delivery.recover(identity); else await delivery.start(identity)
    }, { secretKey }) }
    try {
      await assert.rejects(run(false), ImRunDeliveryBlocked)
      assert.equal(drained, true)
      const before = p.requests.length
      p.fail(null)
      await assert.rejects(run(true), ImRunDeliveryBlocked)
      assert.equal(p.requests.length, before); assert.equal(started, 1)
      await withPostgresImDeliveryStore(pool, identity, async receipts => {
        const stream = createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'v1', receipts, client: p.client, authorize: async () => true })
        const saved = await receipts.projection!.read()
        assert.equal((saved.state as any).inflight.sequence, mode === 'close' ? 2 : 1)
        const accumulated = (saved.state as any).accumulated
        assert.equal(await stream.project({ identity, event: events[0]!, deliveryId: 'same-event' }), 'unknown')
        assert.equal(await stream.project({ identity, event: events[1]!, deliveryId: 'next-event' }), 'unknown')
        assert.equal(await stream.project({ identity, event: event(3, 'token', { text: '禁止越过的后续消息' }), deliveryId: 'future-event' }), 'unknown')
        assert.equal(((await receipts.projection!.read()).state as any).accumulated, accumulated, '半事件不能重复append或跳过旧unknown')
      }, { secretKey })
      assert.equal(p.requests.length, before, '直接调用平台端口也不能绕旧bridge或element未知重发')
      const rows = (await pool.query('SELECT state FROM gugu_im_delivery_receipts')).rows
      assert.ok(rows.some(row => row.state === 'unknown' || row.state === 'pending'))
    } finally { await p.client.close() }
  })
})

test('真实PG操作accepted与state CAS同事务，版本/密钥/作用域/大小不符拒绝且撤权不请求平台', {
  skip: !url && '需显式隔离PG', timeout: 30000,
}, async () => database(async pool => {
  const p = platform()
  try {
    await withPostgresImDeliveryStore(pool, identity, async receipts => {
      assert.equal(await receipts.begin(identity, 'op', digest('body')), 'new')
      assert.equal(await receipts.projection!.accepted('op', 0, { v: 1, synthetic: 'confidential' }), 1)
      assert.equal(await receipts.begin(identity, 'op', digest('body')), 'accepted')
      assert.equal(await receipts.begin(identity, 'wrong-version', digest('body')), 'new')
      await assert.rejects(receipts.projection!.accepted('wrong-version', 0, {}))
      assert.equal((await receipts.projection!.read()).version, 1)
      const row = (await pool.query("SELECT state FROM gugu_im_delivery_receipts WHERE delivery_key='wrong-version'")).rows[0]
      assert.equal(row.state, 'pending', 'CAS失败不得只提交accepted而丢失state')
      await assert.rejects(receipts.projection!.checkpoint(1, { value: 'x'.repeat(1048576) }))
    }, { secretKey })
    await assert.rejects(withPostgresImDeliveryStore(pool, identity, receipts => receipts.projection!.read(), { secretKey: 'different-synthetic-key' }))
    await withPostgresImDeliveryStore(pool, identity, async receipts => {
      const stream = createPersistentFeishuProjection({ identity, receiveId: 'oc_synthetic', policyVersion: 'v1', receipts, client: p.client, authorize: async () => true })
      await assert.rejects(stream.project({ identity, deliveryId: 'bad-shape', event: event(1, 'token', { text: '不得投递' }) }), /状态无效/)
      assert.equal(p.requests.length, 0)
    }, { secretKey })
    const other = { ...identity, sessionId: '2', runId: 'other-synthetic-run' }
    await withPostgresImDeliveryStore(pool, other, async receipts => {
      assert.deepEqual(await receipts.projection!.read(), { version: 0, state: null })
      await pool.query(`INSERT INTO gugu_im_platform_projection(user_id,session_id,run_id,platform,version,nonce,payload)
        SELECT user_id,2,$1,platform,version,nonce,payload FROM gugu_im_platform_projection WHERE session_id=1 AND run_id=$2`, [other.runId, identity.runId])
      await assert.rejects(receipts.projection!.read(), '密文不能挪到同owner的其他session/Run使用')
    }, { secretKey })
    await withPostgresImDeliveryStore(pool, { ...identity, runId: 'denied-run' }, async receipts => {
      const stream = createPersistentFeishuProjection({ identity: { ...identity, runId: 'denied-run' }, receiveId: 'oc_synthetic', policyVersion: 'v1', receipts, client: p.client, authorize: async () => false })
      assert.equal(await stream.project({ identity: { ...identity, runId: 'denied-run' }, event: { ...event(1, 'token', { text: '不可投递' }), identity: { ...identity, runId: 'denied-run' } }, deliveryId: 'id' }), 'rejected')
      assert.equal(p.requests.length, 0)
    }, { secretKey })
    await pool.query('UPDATE gugu_im_platform_projection SET version=version+1')
    await assert.rejects(withPostgresImDeliveryStore(pool, identity, receipts => receipts.projection!.read(), { secretKey }))
  } finally { await p.client.close() }
}))
