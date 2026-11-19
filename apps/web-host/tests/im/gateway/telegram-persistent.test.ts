import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool } from 'pg'
import type { RunEvent } from '@gugu/core/agent'
import { createImRunDeliveryRecovery } from '@gugu/core/im/run-delivery'
import { createTelegramBotApi } from '../../../src/modules/im/gateway/telegram-api.js'
import { createTelegramSender } from '../../../src/modules/im/gateway/telegram-sender.js'
import { createPersistentTelegramProjection } from '../../../src/modules/im/gateway/telegram-persistent.js'
import { withPostgresImDeliveryStore, type ImDeliverySession } from '../../../src/modules/im/gateway/delivery-store.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000094', sessionId: '1', runId: 'synthetic-telegram-stream' }
const target = { chatId: '12345', chatType: 'c2c' as const, replyToMessageId: '9' }
const secretKey = 'synthetic-telegram-projection-key'
const url = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const event = (sequence: number, type: RunEvent['type'], payload: RunEvent['payload'] = {}): RunEvent => ({ id: `synthetic-${sequence}`, identity, sequence, round: 1, type, payload })
function platform() {
  let clock = 20000, number = 0, allowed = true
  const calls: { method: string; body: Buffer }[] = []
  let fail: ((method: string) => number | null) | undefined
  const api = createTelegramBotApi({ transport: { async request(request) {
    const method = new URL(request.url).pathname.split('/').at(-1)!, body = Buffer.from(request.body as Uint8Array)
    calls.push({ method, body })
    const code = fail?.(method)
    return { status: code ?? 200, headers: {}, body: (async function* () {
      yield Buffer.from(JSON.stringify(code ? { ok: false, error_code: code, description: 'synthetic-private-error' }
        : { ok: true, result: method === 'sendMessageDraft' ? true : { message_id: ++number } }))
    })(), async cancel() {} }
  } } })
  const sender = createTelegramSender({ api, token: '123456:synthetic_telegram_bot_token_123', now: () => clock, sleep: async ms => { clock += ms } })
  return { sender, calls, api, now: () => clock, tick(ms: number) { clock += ms }, authorize: async () => allowed,
    revoke() { allowed = false }, fail(callback: typeof fail) { fail = callback } }
}
/** 明确的内存收据/CAS替身；平台协议编码与sender使用生产实现。 */
function memory() {
  let version = 0, state: unknown = null, cursor = 0
  const keys = new Map<string, { fingerprint: string; state: 'pending' | 'accepted' | 'unknown' | 'rejected' }>()
  let failAccepted = false
  const receipts: ImDeliverySession = {
    async cursor() { return cursor }, async advance(_identity, expected, next) { assert.equal(cursor, expected); cursor = next },
    async begin(_identity, key, fingerprint) {
      const previous = keys.get(key)
      if (previous) { assert.equal(previous.fingerprint, fingerprint); return previous.state === 'rejected' ? 'new' : previous.state }
      keys.set(key, { fingerprint, state: 'pending' }); return 'new'
    },
    async settle(_identity, key, value) { keys.get(key)!.state = value },
    projection: {
      platform: 'telegram', async read() { return { version, state: structuredClone(state) } },
      async checkpoint(expected, next) { assert.equal(version, expected); state = structuredClone(next); return ++version },
      async accepted(key, expected, next) {
        if (failAccepted) throw new Error('合成原子提交故障')
        assert.equal(version, expected); assert.equal(keys.get(key)?.state, 'pending')
        keys.get(key)!.state = 'accepted'; state = structuredClone(next); return ++version
      },
    },
  }
  return { receipts, failAccepted() { failAccepted = true }, state: () => state }
}
const create = (m: ReturnType<typeof memory>, p: ReturnType<typeof platform>, extra: Partial<Parameters<typeof createPersistentTelegramProjection>[0]> = {}) =>
  createPersistentTelegramProjection({ identity, target, policyVersion: 'synthetic-v1', receipts: m.receipts, sender: p.sender, authorize: p.authorize, now: p.now, ...extra })
const push = (stream: ReturnType<typeof createPersistentTelegramProjection>, value: RunEvent) => stream.project({ identity, event: value, deliveryId: `stream:${value.sequence}` })
const texts = (p: ReturnType<typeof platform>) => p.calls.filter(call => call.method === 'sendMessage').map(call => JSON.parse(call.body.toString()).text as string)

test('Telegram持久预览不冒充正式回复；重建后final只发送一次并保留原draftId', async () => {
  const m = memory(), p = platform(); let stream = create(m, p)
  try {
    assert.equal(await push(stream, event(1, 'token', { text: '合成首段' })), 'accepted')
    const draftId = JSON.parse(p.calls[0]!.body.toString()).draft_id
    assert.equal(texts(p).length, 0)
    await stream.close(); stream = create(m, p); p.tick(2000)
    assert.equal(await push(stream, event(2, 'token', { text: '与尾段' })), 'accepted')
    assert.equal(JSON.parse(p.calls.at(-1)!.body.toString()).draft_id, draftId)
    assert.equal(await push(stream, event(3, 'round_end', { text: '合成首段与尾段' })), 'accepted')
    assert.equal(texts(p).length, 0)
    const final = event(4, 'final', { text: '合成首段与尾段', status: 'completed' })
    assert.equal(await push(stream, final), 'accepted'); assert.equal(await push(stream, final), 'accepted')
    assert.equal(texts(p).length, 1)
  } finally { await stream.close(); await p.api.close() }
})

test('草稿明确失败仅禁预览，仍需正式final；工具只投可信摘要而非原始result', async () => {
  const m = memory(), p = platform(); p.fail(method => method === 'sendMessageDraft' ? 400 : null)
  const stream = create(m, p, { toolSummary: { chatType: 'p2p', includeDetails: false, sanitize: text => text } })
  try {
    await push(stream, event(1, 'token', { text: '预览正文' }))
    await push(stream, event(2, 'tool_done', { name: 'read_file', toolCallId: 'synthetic-tool', status: 'completed', result: { private: 'synthetic-credential-do-not-send' } }))
    await push(stream, event(3, 'final', { text: '正式回复', status: 'completed' }))
    assert.equal(p.calls.filter(call => call.method === 'sendMessageDraft').length, 1)
    assert.equal(texts(p).length, 1); assert.ok(texts(p)[0]!.includes('read\\_file'))
    assert.doesNotMatch(JSON.stringify(p.calls), /synthetic-credential-do-not-send/)
  } finally { await stream.close(); await p.api.close() }
})

test('Python分轮基线：隐藏中间轮只正式发送最终轮，开启时保留全轮及精简工具摘要', async () => {
  for (const showIntermediateReplies of [false, true]) {
    const m = memory(), p = platform(), stream = create(m, p, { showIntermediateReplies,
      toolSummary: { chatType: 'p2p', includeDetails: false, sanitize: text => text } })
    try {
      const values = [event(1, 'token', { text: '中间过程' }), event(2, 'round_end', { text: '中间过程' }),
        event(3, 'token', { text: '最终回复' }), event(4, 'round_end', { text: '最终回复' }),
        event(5, 'tool_done', { name: 'lookup', status: 'success', result: { raw: '不得外发结果' } }),
        event(6, 'final', { text: '最终回复', status: 'completed' })]
      for (const value of values) { p.tick(1100); assert.equal(await push(stream, value), 'accepted') }
      assert.equal(texts(p).length, 1)
      assert.match(texts(p)[0]!, /最终回复/); assert.match(texts(p)[0]!, /lookup完成/)
      if (showIntermediateReplies) assert.match(texts(p)[0]!, /中间过程/)
      else assert.doesNotMatch(texts(p)[0]!, /中间过程/)
      assert.doesNotMatch(JSON.stringify(p.calls), /不得外发结果/)
      const drafts = p.calls.filter(value => value.method === 'sendMessageDraft').map(value => JSON.parse(value.body.toString()))
      assert.equal(new Set(drafts.map(value => value.draft_id)).size, 1)
      assert.ok(drafts.some(value => value.text.includes('中间过程\n\n最终回复')))
    } finally { await stream.close(); await p.api.close() }
  }
})

test('图表渲染失败保留完整围栏源码，拒绝群聊配置且错误不包含平台材料', async () => {
  const m = memory(), p = platform()
  assert.throws(() => create(m, p, { target: { chatId: '-12345', chatType: 'group' } }), /未配置/)
  const stream = create(m, p, { renderCharts: async () => { throw Error('synthetic-render-private') } })
  try {
    const source = '```latex\nx^2\n```'
    await push(stream, event(1, 'token', { text: source }))
    await push(stream, event(2, 'final', { text: source, status: 'completed' }))
    assert.equal(p.calls.filter(value => value.method === 'sendPhoto').length, 0)
    assert.ok(texts(p)[0]!.includes('latex')); assert.doesNotMatch(JSON.stringify(p.calls), /synthetic-render-private/)
  } finally { await stream.close(); await p.api.close() }
})

test('真实受限Mermaid/TeX renderer→PNG→Telegram multipart，未替换renderer或图片字节', async () => {
  const m = memory(), p = platform(), stream = create(m, p)
  try {
    const text = '流程\n```mermaid\ngraph TD\n A-->B\n```\n公式\n```latex\nx^2+1\n```\n完毕'
    assert.equal(await push(stream, event(1, 'token', { text })), 'accepted')
    assert.equal(await push(stream, event(2, 'final', { text, status: 'completed' })), 'accepted')
    const images = p.calls.filter(value => value.method === 'sendPhoto')
    assert.equal(images.length, 2, JSON.stringify({
      mermaidFallback: texts(p).some(text => text.includes('mermaid')),
      texFallback: texts(p).some(text => text.includes('latex')),
    }))
    for (const image of images) assert.ok(image.body.includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    assert.deepEqual(p.calls.filter(value => value.method !== 'sendMessageDraft').map(value => value.method),
      ['sendMessage', 'sendPhoto', 'sendMessage', 'sendPhoto', 'sendMessage'])
  } finally { await stream.close(); await p.api.close() }
})

test('真实协议图表严格正文→图片→尾文；未知图片结果不退回源码、不重发前缀', async () => {
  for (const unknown of [false, true]) {
    const m = memory(), p = platform(); if (unknown) p.fail(method => method === 'sendPhoto' ? 503 : null)
    const stream = create(m, p, { renderCharts: async () => [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])] })
    try {
      const input = event(1, 'token', { text: '图前\n```mermaid\ngraph TD; A-->B\n```\n图后' })
      assert.equal(await push(stream, input), unknown ? 'unknown' : 'accepted')
      if (unknown) {
        const count = p.calls.length; assert.equal(await push(stream, input), 'unknown'); assert.equal(p.calls.length, count)
      } else await push(stream, event(2, 'final', { text: input.payload.text, status: 'completed' }))
      const actual = p.calls.filter(call => call.method !== 'sendMessageDraft')
      assert.deepEqual(actual.map(call => call.method), unknown ? ['sendMessage', 'sendPhoto'] : ['sendMessage', 'sendPhoto', 'sendMessage'])
      assert.doesNotMatch(texts(p).join(''), /mermaid|graph TD/)
      assert.match(texts(p)[0]!, /图前/)
      if (!unknown) assert.match(texts(p)[1]!, /图后/)
    } finally { await stream.close(); await p.api.close() }
  }
})

test('正式发送接受但状态提交失败后inflight阻止再次发送；跨目标配置拒绝恢复', async () => {
  const m = memory(), p = platform(); let stream = create(m, p)
  try {
    await push(stream, event(1, 'token', { text: '提交失败正文' }))
    m.failAccepted()
    await assert.rejects(push(stream, event(2, 'final', { text: '提交失败正文', status: 'completed' })), /原子提交/)
    await stream.close(); stream = create(m, p)
    assert.equal(await push(stream, event(2, 'final', { text: '提交失败正文', status: 'completed' })), 'unknown')
    assert.equal(texts(p).length, 1)
    const foreign = create(m, p, { target: { chatId: '67890', chatType: 'c2c' } })
    try { await assert.rejects(push(foreign, event(3, 'token', { text: '不得投递' })), /状态无效/) } finally { await foreign.close() }
  } finally { await stream.close(); await p.api.close() }
})

test('interaction暂停→tool_done→再次等待→run_resumed→final保持合法事件顺序与正文不重复', async () => {
  const m = memory(), p = platform(), stream = create(m, p)
  try {
    const events = [event(1, 'token', { text: '问题前正文' }), event(2, 'interaction_required'), event(3, 'tool_done', { name: 'ask' }),
      event(4, 'interaction_required'), event(5, 'run_resumed'), event(6, 'token', { text: '回答后正文' }), event(7, 'final', { text: '回答后正文', status: 'completed' })]
    for (const value of events) assert.equal(await push(stream, value), 'accepted')
    assert.equal(texts(p).length, 2)
    assert.match(texts(p)[0]!, /问题前正文/); assert.match(texts(p)[1]!, /回答后正文/)
  } finally { await stream.close(); await p.api.close() }
})

test('15秒草稿保活与事件串行；close排空，撤权后不续期且不发正式正文', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  const m = memory(), p = platform(), stream = create(m, p)
  try {
    await push(stream, event(1, 'token', { text: '工具等待预览' }))
    p.tick(15000); context.mock.timers.tick(15000)
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    assert.equal(p.calls.filter(call => call.method === 'sendMessageDraft').length, 2)
    p.revoke(); p.tick(15000); context.mock.timers.tick(15000)
    await new Promise(resolve => setImmediate(resolve)); await stream.close()
    assert.equal(p.calls.filter(call => call.method === 'sendMessageDraft').length, 2)
    assert.equal(texts(p).length, 0)
    assert.equal(await push(stream, event(2, 'final', { text: '不得发送', status: 'completed' })), 'rejected')
  } finally { await stream.close(); await p.api.close(); context.mock.timers.reset() }
})

test('草稿429限流等待中撤权不再HTTP，预览结果不替代正式投递授权', async () => {
  const m = memory(), p = platform()
  let calls = 0, allowed = true
  const sender = createTelegramSender({ token: 'synthetic', now: p.now, sleep: async () => { allowed = false }, api: {
    async call() { calls++; const { TelegramApiError } = await import('../../../src/modules/im/gateway/telegram-api.js'); throw new TelegramApiError('sendMessageDraft', 429, 429, 1) },
  } })
  const stream = create(m, p, { sender, authorize: async () => allowed })
  try {
    assert.equal(await push(stream, event(1, 'token', { text: '撤权后不得续发' })), 'rejected')
    assert.equal(calls, 1)
    assert.equal(await push(stream, event(2, 'final', { text: '撤权后不得续发', status: 'completed' })), 'rejected')
    assert.equal(calls, 1)
  } finally { await stream.close(); await p.api.close() }
})

test('真实Telegram API在transport准备后HTTP前复核，文本/图片/draft均不能跨撤权窗口发请求', async () => {
  const p = platform()
  try {
    for (const kind of ['text', 'file', 'draft']) {
      let first = true
      const authorize = async () => { if (first) { first = false; return true }; return false }
      if (kind === 'text') assert.equal((await p.sender.text(target, '不得发送', { authorize })).outcome, 'rejected')
      else if (kind === 'file') assert.equal((await p.sender.file(target, new Uint8Array([1]), 'synthetic.png', undefined, authorize)).outcome, 'rejected')
      else assert.equal(await p.sender.draft(target, '不得预览', 9, undefined, authorize), false)
    }
    assert.equal(p.calls.length, 0)
  } finally { await p.api.close() }
})

test('真实PG明确403零正式副作用可恢复原final，零Provider重跑且parser不重复追加', { skip: !url && '需要显式隔离PG' }, async () => {
  await database(async pool => {
    const p = platform(), events = [event(1, 'token', { text: '恢复的首段' }), event(2, 'token', { text: '与尾段' }),
      event(3, 'final', { text: '恢复的首段与尾段', status: 'completed' })]
    p.fail(method => method === 'sendMessage' ? 403 : null)
    try {
      for (let restart = 0; restart < 2; restart++) {
        if (restart) p.fail(undefined)
        await withPostgresImDeliveryStore(pool, identity, async receipts => {
          const stream = createPersistentTelegramProjection({ identity, target, policyVersion: 'v1', receipts, sender: p.sender, authorize: p.authorize, now: p.now })
          try {
            const delivery = createImRunDeliveryRecovery({ receipts, stream, digest, authorize: p.authorize,
              events: { async readAfter(_identity, sequence) { return events.filter(value => value.sequence > sequence) } },
              sender: { async text() { throw Error('不得旁路正文') }, async artifact() { throw Error('无附件') }, async interaction() { throw Error('无交互') } } })
            if (!restart) await assert.rejects(delivery.recover(identity))
            else await delivery.recover(identity)
          } finally { await stream.close() }
        }, { secretKey, platform: 'telegram' })
      }
      assert.deepEqual(texts(p), ['恢复的首段与尾段', '恢复的首段与尾段'])
      const cursor = await pool.query('SELECT cursor FROM gugu_im_run_delivery'); assert.equal(Number(cursor.rows[0].cursor), 3)
    } finally { await p.api.close() }
  })
})

async function database(work: (pool: Pool) => Promise<void>) {
  const { Pool } = await import('pg'), schema = `im_tg_projection_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url }), pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid)')
    await pool.query('INSERT INTO users VALUES($1)', [identity.ownerId]); await pool.query('INSERT INTO conversation_sessions VALUES(1,$1)', [identity.ownerId])
    await pool.query(await readFile(new URL('../../../src/modules/im/gateway/delivery-schema.sql', import.meta.url), 'utf8'))
    await work(pool)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
}

test('真实PG加密投影→共享持久outbox recover→实际Telegram协议：重启不重发且无需Provider', { skip: !url && '需要显式隔离PG' }, async () => {
  await database(async pool => {
    const p = platform(), events = [event(1, 'token', { text: '密封合成正文' }), event(2, 'final', { text: '密封合成正文', status: 'completed' })]
    try {
      for (let restart = 0; restart < 2; restart++) await withPostgresImDeliveryStore(pool, identity, async receipts => {
        const stream = createPersistentTelegramProjection({ identity, target, policyVersion: 'v1', receipts, sender: p.sender, authorize: p.authorize, now: p.now })
        try {
          const delivery = createImRunDeliveryRecovery({ receipts, stream, digest, authorize: p.authorize,
            events: { async readAfter(_identity, sequence) { return events.filter(value => value.sequence > sequence) } },
            sender: { async text() { throw Error('不得旁路正文') }, async artifact() { throw Error('无附件') }, async interaction() { throw Error('无交互') } } })
          await delivery.recover(identity)
        } finally { await stream.close() }
      }, { secretKey, platform: 'telegram' })
      assert.equal(texts(p).length, 1)
      const read = await pool.query('SELECT platform,payload FROM gugu_im_platform_projection')
      assert.equal(read.rows[0].platform, 'telegram'); assert.equal(Buffer.from(read.rows[0].payload).includes(Buffer.from('密封合成正文')), false)
      const cursor = await pool.query('SELECT cursor FROM gugu_im_run_delivery'); assert.equal(Number(cursor.rows[0].cursor), 2)
    } finally { await p.api.close() }
  })
})

test('真实PG半事件：正式HTTP未知或接受后原子提交失败，重建Core恢复不再发送或重放文本', { skip: !url && '需要显式隔离PG' }, async () => {
  for (const failCommit of [false, true]) await database(async pool => {
    const p = platform(), events = [event(1, 'token', { text: '半事件合成正文' }), event(2, 'final', { text: '半事件合成正文', status: 'completed' })]
    if (!failCommit) p.fail(method => method === 'sendMessage' ? 503 : null)
    try {
      for (let restart = 0; restart < 2; restart++) await withPostgresImDeliveryStore(pool, identity, async receipts => {
        if (!restart && failCommit) {
          const projection = receipts.projection!
          receipts.projection = { ...projection, async accepted(key, version, state) {
            if (key.endsWith(':text')) throw new Error('合成提交失败')
            return projection.accepted(key, version, state)
          } }
        }
        const stream = createPersistentTelegramProjection({ identity, target, policyVersion: 'v1', receipts, sender: p.sender, authorize: p.authorize, now: p.now })
        try {
          const delivery = createImRunDeliveryRecovery({ receipts, stream, digest, authorize: p.authorize,
            events: { async readAfter(_identity, sequence) { return events.filter(value => value.sequence > sequence) } },
            sender: { async text() { throw Error('不得旁路正文') }, async artifact() { throw Error('无附件') }, async interaction() { throw Error('无交互') } } })
          await assert.rejects(delivery.recover(identity))
          assert.equal(p.calls.filter(call => call.method === 'sendMessage').length, 1)
        } finally { await stream.close() }
      }, { secretKey, platform: 'telegram' })
      const cursor = await pool.query('SELECT cursor FROM gugu_im_run_delivery'); assert.equal(Number(cursor.rows[0].cursor), 1)
      const row = await pool.query("SELECT state FROM gugu_im_delivery_receipts WHERE delivery_key='stream:2'")
      assert.equal(row.rows[0].state, 'unknown')
    } finally { await p.api.close() }
  })
})

test('真实PG保活与Core外层begin交错不丢投递：同连接SQL排队、原draft续期后final继续', { skip: !url && '需要显式隔离PG' }, async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  try {
    await database(async pool => {
      const p = platform()
      let releaseGate!: () => void, entered!: () => void, arm = false
      const gate = new Promise<void>(resolve => { releaseGate = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
      const wrappedPool = { async connect() {
        const client = await pool.connect(), query = client.query.bind(client), release = client.release.bind(client)
        client.query = (async (text: string, params?: unknown[]) => {
          if (arm && text.startsWith('INSERT INTO gugu_im_delivery_receipts') && params?.[3] === 'stream:2') {
            arm = false; entered(); await gate
          }
          return query(text, params)
        }) as typeof client.query
        client.release = error => { client.query = query; client.release = release; release(error) }
        return client
      } } as Pick<Pool, 'connect'>
      try {
        await withPostgresImDeliveryStore(wrappedPool, identity, async receipts => {
          const stream = createPersistentTelegramProjection({ identity, target, policyVersion: 'v1', receipts, sender: p.sender, authorize: p.authorize, now: p.now })
          let events = [event(1, 'token', { text: '保活并发正文' })]
          const delivery = createImRunDeliveryRecovery({ receipts, stream, digest, authorize: p.authorize,
            events: { async readAfter(_identity, sequence) { return events.filter(value => value.sequence > sequence) } },
            sender: { async text() { throw Error('不得旁路正文') }, async artifact() { throw Error('无附件') }, async interaction() { throw Error('无交互') } } })
          try {
            await delivery.recover(identity)
            events = [...events, event(2, 'final', { text: '保活并发正文', status: 'completed' })]
            arm = true
            const final = delivery.recover(identity)
            await reached
            p.tick(15000); context.mock.timers.tick(15000)
            await new Promise(resolve => setImmediate(resolve))
            releaseGate(); await final
            assert.equal(p.calls.filter(call => call.method === 'sendMessageDraft').length, 2)
            assert.equal(texts(p).length, 1); assert.equal(await receipts.cursor(identity), 2)
          } finally { releaseGate(); await stream.close() }
        }, { secretKey, platform: 'telegram' })
      } finally { releaseGate(); await p.api.close() }
    })
  } finally { context.mock.timers.reset() }
})

test('真实PG Telegram回调提前结束仍排空已排队SQL，再释放连接；关闭后借用不可操作', { skip: !url && '需要显式隔离PG' }, async () => {
  await database(async pool => {
    let releaseGate!: () => void, entered!: () => void, released = false, finished = false
    const gate = new Promise<void>(resolve => { releaseGate = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
    const pending: Promise<unknown>[] = []
    let escaped!: ImDeliverySession
    const wrappedPool = { async connect() {
      const client = await pool.connect(), query = client.query.bind(client), release = client.release.bind(client)
      client.query = (async (text: string, params?: unknown[]) => {
        if (text.startsWith('INSERT INTO gugu_im_delivery_receipts') && params?.[3] === 'drain') { entered(); await gate }
        return query(text, params)
      }) as typeof client.query
      client.release = error => { released = true; client.query = query; client.release = release; release(error) }
      return client
    } } as Pick<Pool, 'connect'>
    const work = withPostgresImDeliveryStore(wrappedPool, identity, async receipts => {
      escaped = receipts
      pending.push(receipts.begin(identity, 'drain', digest('synthetic')))
      pending.push(receipts.cursor(identity))
    }, { secretKey, platform: 'telegram' }).then(() => { finished = true })
    try {
      await reached
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(released, false); assert.equal(finished, false)
      releaseGate(); await work
      assert.deepEqual(await Promise.all(pending), ['new', 0])
      assert.equal(released, true)
      await assert.rejects(escaped.cursor(identity))
      const row = await pool.query("SELECT state FROM gugu_im_delivery_receipts WHERE delivery_key='drain'")
      assert.equal(row.rows[0].state, 'pending')
    } finally { releaseGate(); await work; await Promise.allSettled(pending) }
  })
})
