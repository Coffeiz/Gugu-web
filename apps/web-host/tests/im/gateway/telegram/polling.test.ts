import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectTelegramPolling, type TelegramPollingOptions } from '@gugu/gateway/telegram'

const message = (id: number, extra: Record<string, unknown> = {}) => ({ update_id: id,
  message: { message_id: id, date: 100, chat: { id: 9, type: 'private' }, from: { id: 9, first_name: '小北' }, text: '合成消息', ...extra } })
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  assert.ok(check(), '预期轮询状态没有出现')
}
function fixture(batches: unknown[], extra: Partial<TelegramPollingOptions> = {}) {
  const signal = new AbortController()
  const calls: { method: string; payload: Record<string, unknown> | undefined }[] = []
  const saved: { id: number; payload: Record<string, unknown> | null }[] = []
  let cursor: number | null = 10
  let closed = 0, waiting = false
  const options: TelegramPollingOptions = {
    botId: '7', ownerId: 'owner-a', token: 'synthetic-token', signal: signal.signal,
    api: {
      async call(_token, method, options) {
        calls.push({ method, payload: options?.payload })
        if (method === 'getMe') return { id: 99, username: 'gugu_bot' }
        if (method === 'getWebhookInfo') return { url: '' }
        if (batches.length) return batches.shift()
        waiting = true
        return new Promise((_, reject) => {
          if (options?.signal?.aborted) reject(new Error('已取消'))
          else options?.signal?.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
        })
      },
      close() { closed++ },
    },
    inbox: { async cursor() { return cursor }, async commit(id, payload) { saved.push({ id, payload }); cursor = id } },
    async preflight() { return 'enqueue' }, async callback() { return true },
    ...extra,
  }
  return { options, calls, saved, waiting: () => waiting, closed: () => closed }
}

test('Telegram 真实解析器按update顺序入站，忽略编辑并从持久游标继续', async () => {
  const f = fixture([[
    message(13), { update_id: 12, edited_message: message(12).message }, message(11),
  ]])
  const connection = await connectTelegramPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(f.saved.map(item => item.id), [11, 12, 13])
  assert.equal(f.saved[0]!.payload?.platform, 'telegram')
  assert.equal(f.saved[0]!.payload?.owner_user_id, 'owner-a')
  assert.equal(f.saved[1]!.payload, null)
  assert.deepEqual(f.calls.filter(item => item.method === 'getUpdates').map(item => item.payload?.offset), [11, 14])
  await connection.stop()
  assert.equal(f.closed(), 1)
})

test('Telegram 凭据/取消预检消费后不进入Agent普通队列', async () => {
  let preflight = 0
  const f = fixture([[message(11)]], { async preflight(payload) {
    preflight++; assert.equal(payload.platform_user_id, '9'); return 'consumed'
  } })
  const connection = await connectTelegramPolling(f.options)
  await until(f.waiting)
  assert.equal(preflight, 1)
  assert.deepEqual(f.saved, [{ id: 11, payload: null }])
  await connection.stop()
})

test('Telegram callback临时失败不推进游标、不越过失败事件处理后续消息', async () => {
  const waits: number[] = []
  const callback = { update_id: 11, callback_query: { id: 'query-a' } }
  let attempts = 0
  const f = fixture([[callback, message(12)], [callback, message(12)]], {
    async callback() { return ++attempts > 1 }, async sleep(ms) { waits.push(ms) },
  })
  const connection = await connectTelegramPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(f.calls.filter(item => item.method === 'getUpdates').map(item => item.payload?.offset), [11, 11, 13])
  assert.deepEqual(f.saved.map(item => item.id), [11, 12])
  assert.equal(f.saved[0]!.payload, null)
  assert.deepEqual(waits, [1000])
  await connection.stop()
})

test('Telegram Redis临时失败只重新轮询，不伪造成功游标', async () => {
  const f = fixture([[message(11)], [message(11)]], { async sleep() {} })
  let fail = true
  const commit = f.options.inbox.commit
  f.options.inbox.commit = async (id, payload) => { if (fail) { fail = false; throw new Error('合成故障') }; await commit(id, payload) }
  const connection = await connectTelegramPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(f.saved.map(item => item.id), [11])
  assert.deepEqual(f.calls.filter(item => item.method === 'getUpdates').map(item => item.payload?.offset), [11, 11, 12])
  await connection.stop()
})

test('Telegram 非法事件ID拒绝整批且退避，不越过损坏事件推进游标', async () => {
  const waits: number[] = []
  const reports: string[] = []
  const f = fixture([[message(12), { update_id: '11', message: message(11).message }], [message(11)]], {
    async sleep(ms) { waits.push(ms) }, report(event) { reports.push(event) },
  })
  const connection = await connectTelegramPolling(f.options)
  await until(f.waiting)
  assert.deepEqual(waits, [1000])
  assert.deepEqual(reports, ['poll-unavailable'])
  assert.deepEqual(f.saved.map(item => item.id), [11])
  assert.deepEqual(f.calls.filter(item => item.method === 'getUpdates').map(item => item.payload?.offset), [11, 11, 12])
  await connection.stop()
})

test('Telegram 存在webhook即拒绝轮询并关闭API，不自动删除webhook', async () => {
  const f = fixture([])
  const call = f.options.api.call
  f.options.api.call = async (token, method, options) => method === 'getWebhookInfo'
    ? { url: 'https://example.invalid/webhook' } : call(token, method, options)
  await assert.rejects(connectTelegramPolling(f.options), /启动失败/)
  assert.equal(f.closed(), 1)
  assert.equal(f.calls.some(item => item.method === 'getUpdates' || item.method === 'deleteWebhook'), false)
})
test('媒体暂存未配置或变更owner时不提交游标，不将平台媒体描述当附件入队', async () => {
  for (const materialize of [undefined, async (payload: Parameters<NonNullable<TelegramPollingOptions['materialize']>>[0]) => ({ ...payload, owner_user_id: 'other-owner', attachments: [], quoted_attachments: [] })]) {
    const waits: number[] = []
    const f = fixture([[message(11, { photo: [{ file_id: 'synthetic-file', width: 1, height: 1 }] })], []], { materialize, sleep: async ms => { waits.push(ms) } })
    const connection = await connectTelegramPolling(f.options)
    await until(f.waiting)
    assert.deepEqual(f.saved, []); assert.deepEqual(waits, [1000])
    assert.ok(f.calls.filter(call => call.method === 'getUpdates').every(call => call.payload?.offset === 11))
    await connection.stop()
  }
})
