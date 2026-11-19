import assert from 'node:assert/strict'
import test from 'node:test'
import { connectWechatPolling, type WechatPollingOptions } from '../../../src/modules/im/gateway/platforms/wechat/polling.js'

const message = (token = 'context-synthetic', extra: Record<string, unknown> = {}) => ({
  message_type: 1, from_user_id: 'wx-synthetic', context_token: token, create_time_ms: 123,
  item_list: [{ type: 1, text_item: { text: '合成入站' } }], ...extra,
})
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  assert.ok(check(), '预期微信轮询状态没有出现')
}
function fixture(batches: Record<string, unknown>[], extra: Partial<WechatPollingOptions> = {}) {
  const controller = new AbortController(), cursors: string[] = [], stored: Record<string, unknown>[] = [], order: string[] = [], reports: string[] = []
  let waiting = false, closed = 0
  const options: WechatPollingOptions = {
    botId: '41', ownerId: 'owner-synthetic', signal: controller.signal,
    api: {
      notifyStart: async () => { order.push('start'); return { ret: 0 } },
      notifyStop: async signal => { assert.equal(signal?.aborted, false); order.push('stop-notify'); return { ret: 0 } },
      getUpdates: async (cursor = '', signal) => {
        cursors.push(cursor)
        if (batches.length) return batches.shift()!
        waiting = true
        return new Promise((_, reject) => { if (signal?.aborted) reject(new Error('合成取消')); else signal?.addEventListener('abort', () => reject(new Error('合成取消')), { once: true }) })
      },
      close: async () => { order.push('close'); closed++ },
    },
    preflight: async () => { order.push('preflight'); return 'enqueue' },
    materialize: async () => { order.push('media'); return ['synthetic-attach-id'] },
    enqueue: async payload => { order.push('enqueue'); stored.push(structuredClone(payload)) },
    report: event => reports.push(event), ...extra,
  }
  return { options, controller, cursors, stored, order, reports, waiting: () => waiting, closed: () => closed }
}

test('微信真实parser只接受用户消息，透传context并采用可信Bot身份和响应游标', async () => {
  const f = fixture([{ msgs: [message('ignored', { message_type: 2 }), message('trusted-context', { owner_user_id: 'forged-owner' })], get_updates_buf: 'cursor-next' }])
  const connection = await connectWechatPolling(f.options)
  await until(f.waiting)
  assert.equal(f.stored.length, 1)
  assert.equal(f.stored[0]!.owner_user_id, 'owner-synthetic')
  assert.equal(f.stored[0]!.channel_id, '41')
  assert.equal(f.stored[0]!.context_token, 'trusted-context')
  assert.deepEqual(f.cursors, ['', 'cursor-next'])
  await connection.stop()
  assert.deepEqual(f.order, ['start', 'preflight', 'enqueue', 'stop-notify', 'close'])
  assert.equal(f.closed(), 1)
})

test('微信凭据预检早于媒体下载且已消费消息不产生下载、暂存或入队', async () => {
  const f = fixture([{ msgs: [message('context-media', { item_list: [{ type: 2, image_item: { aeskey: 'synthetic-key', media: { encrypt_query_param: 'synthetic-cdn' } } }] })] }], {
    preflight: async (payload, pendingMedia) => { assert.equal(payload.attachments.length, 0); assert.equal(pendingMedia, true); return 'consumed' },
  })
  const connection = await connectWechatPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(f.order, ['start'])
  assert.equal(f.stored.length, 0)
  await connection.stop()
})

test('微信引用图片在预检后由Host物化，入队仅真实附件ID而不携带AES或CDN描述', async () => {
  const f = fixture([{ msgs: [message('context-quote', { item_list: [{ type: 1, text_item: { text: '请看引用' }, ref_msg: { message_item: { type: 2, image_item: { aeskey: 'synthetic-key', media: { full_url: 'https://cdn.example.invalid/synthetic' } } } } }] })] }])
  f.options.materialize = async (items, payload) => {
    f.order.push('media')
    assert.equal(items[0]!.source, 'quote'); assert.equal(items[0]!.kind, 'image')
    assert.equal(payload.quoted_text, '[图片消息]')
    return ['real-staged-synthetic-id']
  }
  const connection = await connectWechatPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(f.order, ['start', 'preflight', 'media', 'enqueue'])
  assert.deepEqual(f.stored[0]!.attachments, ['real-staged-synthetic-id'])
  assert.equal(JSON.stringify(f.stored).includes('synthetic-key'), false)
  assert.equal(JSON.stringify(f.stored).includes('cdn.example.invalid'), false)
  await connection.stop()
})

test('微信仅unsupported媒体且无text/真实附件时不启动Agent，非法暂存结果不可入队', async () => {
  for (const invalid of [false, true]) {
    const f = fixture([{ msgs: [message('context-unsupported', { item_list: [{ type: 4, file_item: { file_name: '合成附件' } }] })], get_updates_buf: 'next' }], {
      materialize: async () => invalid ? [''] : [], sleep: async () => {},
    })
    const connection = await connectWechatPolling(f.options)
    await until(f.waiting)
    assert.equal(f.stored.length, 0)
    assert.deepEqual(f.cursors, invalid ? ['', ''] : ['', 'next'])
    assert.equal(f.reports.includes('poll-unavailable'), invalid)
    await connection.stop()
  }
})

test('微信入队失败保持当前响应游标，重复前半批由必需持久去重避免重复Agent运行', async () => {
  const batch = { msgs: [message('first'), message('second')], get_updates_buf: 'committed' }
  const waits: number[] = [], unique = new Set<string>()
  let fail = true
  const f = fixture([batch, batch], { sleep: async ms => { waits.push(ms) }, enqueue: async payload => {
    if (payload.context_token === 'second' && fail) { fail = false; throw new Error('合成数据库失败') }
    unique.add(payload.context_token)
  } })
  const connection = await connectWechatPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(f.cursors, ['', '', 'committed'])
  assert.deepEqual(waits, [3000])
  assert.deepEqual([...unique], ['first', 'second'])
  await connection.stop()
})

test('微信启动通知失败不阻断轮询，停止通知失败仍关闭资源且诊断仅固定码', async () => {
  const f = fixture([])
  f.options.api.notifyStart = async () => { throw new Error('synthetic-secret-token') }
  f.options.api.notifyStop = async signal => { assert.equal(signal?.aborted, false); throw new Error('synthetic-context-token') }
  const connection = await connectWechatPolling(f.options)
  await until(f.waiting)
  await connection.stop()
  assert.deepEqual(f.reports, ['start-notify-unavailable', 'stop-notify-unavailable'])
  assert.equal(f.closed(), 1)
})

test('微信停止等待正在进行的入队排空，不在取消后处理后续消息', async () => {
  let release!: () => void
  let enqueueStarted = false, stopFinished = false
  const f = fixture([{ msgs: [message('first'), message('second')] }], { enqueue: async () => {
    enqueueStarted = true
    await new Promise<void>(resolve => { release = resolve })
  } })
  const connection = await connectWechatPolling(f.options)
  await until(() => enqueueStarted)
  const stopped = connection.stop().then(() => { stopFinished = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(stopFinished, false)
  assert.equal(f.closed(), 0)
  release()
  await stopped
  assert.equal(f.order.filter(event => event === 'preflight').length, 1)
  assert.equal(f.closed(), 1)
})

test('微信停止通知使用独立五秒边界，超时后终止通知并关闭客户端', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture([])
  let notifying = false, notificationAborted = false
  f.options.api.notifyStop = async signal => {
    assert.equal(signal?.aborted, false)
    notifying = true
    return new Promise((_, reject) => {
      signal!.addEventListener('abort', () => { notificationAborted = true; reject(new Error('合成超时')) }, { once: true })
    })
  }
  const connection = await connectWechatPolling(f.options)
  await until(f.waiting)
  const stopped = connection.stop()
  await until(() => notifying)
  context.mock.timers.tick(4_999)
  assert.equal(f.closed(), 0)
  assert.equal(notificationAborted, false)
  context.mock.timers.tick(1)
  await stopped
  assert.equal(notificationAborted, true)
  assert.equal(f.closed(), 1)
  assert.deepEqual(f.reports, ['stop-notify-unavailable'])
})
test('typing ticket在秘密预检/媒体后才获取，真实值按用户缓存并仅加入可入队payload', async () => {
  const f = fixture([{ msgs: [message('control'), message('first'), message('second')] }])
  const order: string[] = []
  f.options.preflight = async payload => { order.push(`preflight:${payload.message_id}`); return payload.message_id === 'control' ? 'consumed' : 'enqueue' }
  f.options.api.getConfig = async (user, context) => { order.push(`config:${context}`); assert.equal(user, 'wx-synthetic'); return { ret: 0, typing_ticket: 'synthetic-ticket' } }
  const connection = await connectWechatPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(order, ['preflight:control', 'preflight:first', 'config:first', 'preflight:second'])
  assert.equal(f.stored.length, 2); assert.ok(f.stored.every(payload => payload.typing_ticket === 'synthetic-ticket'))
  await connection.stop()
})
