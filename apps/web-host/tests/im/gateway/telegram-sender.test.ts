import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTelegramBotApi, TelegramApiError } from '../../../src/modules/im/gateway/telegram-api.js'
import { createTelegramSender } from '../../../src/modules/im/gateway/telegram-sender.js'
import type { TelegramCallOptions } from '../../../src/modules/im/gateway/telegram-api.js'

function fixture(results: (unknown | Error)[] = []) {
  let now = 0
  const waits: number[] = []
  const calls: { method: string; payload: Record<string, unknown> | undefined; files: TelegramCallOptions['files'] }[] = []
  const sender = createTelegramSender({ token: 'synthetic-token', now: () => now,
    sleep: async ms => { waits.push(ms); now += ms },
    api: { async call(_token, method, options) {
      calls.push({ method, payload: options?.payload, files: options?.files })
      const result = results.length ? results.shift() : { message_id: calls.length }
      if (result instanceof Error) throw result
      return result
    } },
  })
  return { sender, calls, waits }
}
const target = { chatId: '9', chatType: 'c2c' as const }

test('Telegram分片保持UTF16边界、首块引用、末块键盘与全部消息ID', async () => {
  const f = fixture()
  const keyboard = { inline_keyboard: [[{ text: '确认', callback_data: 'synthetic-action' }]] }
  const result = await f.sender.text({ ...target, replyToMessageId: '8' }, '😀'.repeat(3_000), { replyMarkup: keyboard })
  assert.equal(result.outcome, 'accepted')
  assert.equal(result.platformMessageIds.length, 2)
  // Python 出站将引用 ID 转为整数，Telegram Bot API 也使用整数契约。
  assert.equal(f.calls[0]!.payload?.reply_to_message_id, 8)
  assert.equal(f.calls[1]!.payload?.reply_to_message_id, undefined)
  assert.equal(f.calls[0]!.payload?.reply_markup, undefined)
  assert.deepEqual(f.calls[1]!.payload?.reply_markup, keyboard)
  assert.equal(f.calls.map(call => call.payload?.text).join(''), '😀'.repeat(3_000))
  assert.deepEqual(f.waits, [1_000])
})

test('Telegram群与bot限流串行，429遵循Retry-After且最多三次', async () => {
  const f = fixture([new TelegramApiError('sendMessage', 429, 429, 2), { message_id: 1 }, { message_id: 2 }])
  const [first, second] = await Promise.all([
    f.sender.text({ chatId: '-8', chatType: 'group' }, '第一条'),
    f.sender.text({ chatId: '-8', chatType: 'group' }, '第二条'),
  ])
  assert.equal(first.outcome, 'accepted')
  assert.equal(second.outcome, 'accepted')
  assert.deepEqual(f.waits, [3_000, 3_000])
  const retries = fixture(Array.from({ length: 4 }, () => new TelegramApiError('sendMessage', 429, 429, 1)))
  assert.equal((await retries.sender.text(target, '合成消息')).outcome, 'rejected')
  assert.equal(retries.calls.length, 3)
})

test('Telegram网络未知结果、缺失消息ID及部分分片成功均不盲目重试', async () => {
  const f = fixture([new Error('合成敏感异常')])
  assert.deepEqual(await f.sender.text(target, '合成消息'), { outcome: 'unknown', platformMessageIds: [] })
  assert.equal(f.calls.length, 1)
  const missing = fixture([{}])
  assert.equal((await missing.sender.text(target, '合成消息')).outcome, 'unknown')
  const partial = fixture([{ message_id: 1 }, new TelegramApiError('sendMessage', 400, 400)])
  assert.deepEqual(await partial.sender.text(target, '中'.repeat(5_000)), { outcome: 'unknown', platformMessageIds: ['1'] })
})

test('Telegram图片仅确定400才改发文档，超限拒绝且引用失败不重复发', async () => {
  const f = fixture([new TelegramApiError('sendPhoto', 400, 400), { message_id: 3 }])
  assert.equal((await f.sender.file(target, new Uint8Array([1, 2]), '../合成图片.png')).outcome, 'accepted')
  assert.deepEqual(f.calls.map(call => call.method), ['sendPhoto', 'sendDocument'])
  assert.equal(f.calls[0]!.files?.photo?.name, '合成图片.png')
  const unknown = fixture([new Error('超时')])
  assert.equal((await unknown.sender.file(target, new Uint8Array([1]), '图片.png')).outcome, 'unknown')
  assert.equal(unknown.calls.length, 1)
  assert.equal((await unknown.sender.file(target, new Uint8Array(50_000_001), '文件.bin')).outcome, 'rejected')
})

test('Telegram私聊draft不替代最终消息，群聊不发送draft', async () => {
  const f = fixture()
  assert.equal(await f.sender.draft({ chatId: '-8', chatType: 'group' }, '预览', 1), false)
  assert.equal(f.calls.length, 0)
  assert.equal(await f.sender.draft(target, '预览', 1), true)
  assert.equal((await f.sender.text(target, '最终消息')).outcome, 'accepted')
  assert.deepEqual(f.calls.map(call => call.method), ['sendMessageDraft', 'sendMessage'])
})

test('Telegram真实sender经过API请求编码和Markdown投影，transport使用合成响应', async () => {
  const bodies: Record<string, unknown>[] = []
  const api = createTelegramBotApi({ transport: { async request(request) {
    assert.ok(request.body instanceof Uint8Array)
    bodies.push(JSON.parse(new TextDecoder().decode(request.body)))
    return { status: 200, headers: {}, body: (async function* () {
      yield new TextEncoder().encode(JSON.stringify({ ok: true, result: { message_id: 9 } }))
    })(), async cancel() {} }
  } } })
  const sender = createTelegramSender({ token: `12345:${'x'.repeat(20)}`, api })
  assert.equal((await sender.text(target, '**合成回复**')).outcome, 'accepted')
  assert.equal(bodies[0]!.parse_mode, 'MarkdownV2')
  assert.equal(bodies[0]!.text, '*合成回复*')
  await sender.drain()
  await api.close()
})

test('Telegram原生按钮复用限流与Markdown，429等待后撤权不再发HTTP且token超限不发送',async()=>{
  const f=fixture([new TelegramApiError('sendMessage',429,429,1)])
  let checks=0
  const result=await f.sender.interaction(target,{prompt_id:7,title:'合成选择',options:[{id:'yes',label:'继续',token:'opaque-token'}]},undefined,async()=>++checks===1)
  assert.equal(result.outcome,'unknown');assert.equal(f.calls.length,1);assert.equal(checks,2)
  assert.deepEqual(f.calls[0]!.payload?.reply_markup,{inline_keyboard:[[{text:'继续',callback_data:'7:opaque-token'}]]})
  assert.equal((await f.sender.interaction(target,{prompt_id:7,options:[{token:'x'.repeat(64)}]})).outcome,'rejected')
  assert.equal(f.calls.length,1)
})
