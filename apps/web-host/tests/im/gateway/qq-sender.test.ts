import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderHttpRequest } from '@gugu/core/providers'
import { createQqClient, QqApiError } from '../../../src/modules/im/gateway/platforms/qq/client.js'
import { buildQqKeyboard, formatQqInteractionFallback, createQqSender, splitQqGroupMentions, type QqSequencePort } from '../../../src/modules/im/gateway/platforms/qq/sender.js'

function fixture() {
  const calls: { path: string; body: Record<string, unknown> }[] = [], counters = new Map<string, number>(), sequenceCalls: unknown[] = [], waits: number[] = []
  const sequences: QqSequencePort = {
    nextPassive: async input => { sequenceCalls.push(input); const key = `${input.botId}:${input.messageId}`, value = (counters.get(key) ?? 0) + 1; counters.set(key, value); return value },
    nextStream: async input => { sequenceCalls.push(input); const value = (counters.get('stream') ?? 0) + 1; counters.set('stream', value); return value },
  }
  let handler = async (path: string): Promise<Record<string, unknown>> => path.endsWith('/stream_messages') ? { stream_msg_id: 'stream_synthetic' } : { id: `message_${calls.length}` }
  const sender = createQqSender({ botId: '41', sequences, sanitizeText: text => text, sleep: async ms => { waits.push(ms) }, client: { call: async (_method, path, args) => { calls.push({ path, body: structuredClone(args?.body ?? {}) }); return handler(path) } } })
  return { sender, calls, counters, sequenceCalls, sequences, waits, setHandler(value: typeof handler) { handler = value } }
}
const target = { id: 'synthetic-user', chatType: 'c2c' as const, messageId: 'inbound-synthetic' }

test('QQ原生键盘明确拒绝后若已撤权，不降级发送文本或宣称交互成功',async()=>{
  const f=fixture();let allowed=true
  f.setHandler(async()=>{allowed=false;throw new QqApiError('message',400,400)})
  const result=await f.sender.interaction(target,{prompt_id:7,options:[{id:'yes',label:'继续',token:'opaque-token'}]},undefined,async()=>allowed)
  assert.equal(result.outcome,'rejected');assert.equal(result.delivery,'none');assert.equal(f.calls.length,1)
})

test('QQ普通文字、媒体和独立流首帧共享被动序列，TTL为70分钟', async () => {
  const f = fixture()
  await f.sender.text(target, '普通回复')
  await f.sender.media(target, { fileInfo: 'real-uploaded-synthetic-file-info', image: true })
  const stream = f.sender.privateStream(target)
  await stream.finish('流式回复')
  assert.deepEqual(f.calls.map(call => call.body.msg_seq), [1, 2, 3])
  assert.ok(f.sequenceCalls.every(input => (input as Record<string, unknown>).ttlSeconds === 4200))
  assert.deepEqual(f.calls[0]!.body, { msg_type: 2, markdown: { content: '普通回复' }, msg_seq: 1, msg_id: 'inbound-synthetic' })
  assert.deepEqual(f.calls[1]!.body, { msg_type: 7, media: { file_info: 'real-uploaded-synthetic-file-info' }, msg_seq: 2, msg_id: 'inbound-synthetic' })
  assert.equal(f.calls[2]!.body.input_state, 10)
  assert.equal(f.calls[2]!.body.content_raw, '流式回复\n')
})

test('QQ明确被动ID失效才主动fallback，Markdown权限拒绝可纯文本降级', async () => {
  const f = fixture()
  f.setHandler(async () => { if (f.calls.length === 1) throw new QqApiError('message', 400, 40034005); return { id: 'active-message' } })
  assert.equal((await f.sender.text(target, '合成正文')).outcome, 'accepted')
  assert.equal(f.calls[0]!.body.msg_id, target.messageId)
  assert.equal(f.calls[1]!.body.msg_id, undefined)
  const markdown = fixture()
  markdown.setHandler(async () => { if (markdown.calls.length === 1) throw new QqApiError('message', 400, 50056); return { id: 'plain-message' } })
  assert.equal((await markdown.sender.text(target, '合成正文')).outcome, 'accepted')
  assert.deepEqual(markdown.calls.map(call => call.body.msg_type), [2, 0])
  assert.deepEqual(markdown.calls.map(call => call.body.msg_seq), [1, 2])
})

test('QQ5xx、超时与缺消息ID均UNKNOWN不盲目主动重发', async () => {
  for (const mode of ['server', 'timeout', 'missing']) {
    const f = fixture()
    f.setHandler(async () => { if (mode === 'missing') return {}; throw mode === 'server' ? new QqApiError('message', 503) : new Error('synthetic-secret') })
    assert.deepEqual(await f.sender.text(target, '合成正文'), { outcome: 'unknown', platformMessageIds: [] })
    assert.equal(f.calls.length, 1)
  }
})

test('QQ群mention独立Markdown且正文主动，已确认mention后失败不重复提醒', async () => {
  assert.deepEqual(splitQqGroupMentions('@sender @known @stranger <@other>', 'sender', ['known']), {
    mention: '<qqbot-at-user id="sender" /><qqbot-at-user id="known" /><qqbot-at-user id="other" />', body: '@stranger',
  })
  const f = fixture(), group = { id: 'synthetic-group', chatType: 'group' as const, messageId: 'group-inbound', mentionUserId: 'sender' }
  f.setHandler(async () => { if (f.calls.length === 2) throw new QqApiError('message', 503); return { id: 'mention-id' } })
  assert.deepEqual(await f.sender.text(group, '@sender 正文'), { outcome: 'unknown', platformMessageIds: ['mention-id'] })
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0]!.body.msg_type, 2)
  assert.deepEqual(f.calls[0]!.body.markdown, { content: '<qqbot-at-user id="sender" />' })
  assert.equal(f.calls[0]!.body.msg_id, 'group-inbound')
  assert.equal(f.calls[1]!.body.msg_id, undefined)
  assert.equal(f.calls[1]!.body.content, '正文')
})

test('QQ私聊流排队等首帧stream_msg_id，仅确认实际发送帧且DONE关闭后才成功', async () => {
  const f = fixture()
  let release!: () => void, firstStarted = false
  f.setHandler(async () => { if (f.calls.length === 1) { firstStarted = true; await new Promise<void>(resolve => { release = resolve }) } return { stream_msg_id: 'stream_synthetic' } })
  const stream = f.sender.privateStream(target)
  stream.push('前缀\n')
  const first = stream.flush()
  await until(() => firstStarted)
  stream.push('新的完整行\n尾部')
  const second = stream.flush()
  assert.equal(f.calls.length, 1)
  release()
  await first
  await second
  assert.equal(stream.state().lastSentText, '前缀\n新的完整行\n')
  const final = await stream.finish('前缀\n新的完整行\n尾部')
  assert.equal(final.outcome, 'accepted'); assert.equal(final.closed, true)
  assert.deepEqual(f.calls.map(call => call.body.index), [0, 1, 2])
  assert.deepEqual(f.calls.map(call => call.body.msg_seq), [1, 1, 1])
  assert.equal(f.calls[0]!.body.stream_msg_id, undefined)
  assert.equal(f.calls[1]!.body.stream_msg_id, 'stream_synthetic')
  assert.equal(f.calls[2]!.body.input_state, 10)
  assert.equal(f.calls[2]!.body.content_raw, '前缀\n新的完整行\n尾部\n')
  await stream.finish('不可重发'); assert.equal(f.calls.length, 3)
})

test('QQ流500ms只发完整行，空白不创建流且active stream独立持久序列', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), stream = f.sender.privateStream({ id: target.id, chatType: 'c2c' })
  stream.push('   ')
  context.mock.timers.tick(1000)
  assert.equal(f.calls.length, 0)
  stream.push('完整行\n未完行')
  context.mock.timers.tick(499)
  assert.equal(f.calls.length, 0)
  context.mock.timers.tick(1)
  await until(() => f.calls.length === 1)
  await stream.finish()
  assert.equal(f.calls[0]!.body.content_raw, '   完整行\n')
  assert.deepEqual(f.sequenceCalls[0], { botId: '41', ttlSeconds: 600 })
})

test('QQ已确认前缀不可回写，只关闭已见前缀但仍报告不完整交付', async () => {
  const f = fixture(), stream = f.sender.privateStream(target)
  stream.push('已确认前缀\n'); await stream.flush()
  const result = await stream.finish('修改前缀后的定稿')
  assert.deepEqual(result, { outcome: 'unknown', platformMessageIds: ['stream_synthetic'], closed: true, reason: 'prefix-mismatch' })
  assert.deepEqual(f.calls.map(call => call.body.content_raw), ['已确认前缀\n', '已确认前缀\n'])
  assert.equal(f.calls[1]!.body.input_state, 10)
})

test('QQ首帧结果不明不能重开流，DONE失败永不把已见正文当成功', async () => {
  for (const firstFails of [true, false]) {
    const f = fixture()
    f.setHandler(async () => { if (firstFails || f.calls.at(-1)!.body.input_state === 10) throw new QqApiError('stream', 503); return { stream_msg_id: 'stream_synthetic' } })
    const stream = f.sender.privateStream(target)
    stream.push('完整正文\n'); await stream.flush()
    const result = await stream.finish('完整正文\n尾部')
    assert.equal(result.outcome, 'unknown'); assert.equal(result.closed, false)
    // 已知stream ID的同index关闭帧按Python最多重试3次，不重新创建首帧。
    assert.equal(f.calls.length, firstFails ? 1 : 5)
    assert.deepEqual(f.waits, firstFails ? [] : [500, 1000, 2000])
    if (!firstFails) for (const retry of f.calls.slice(2)) assert.deepEqual(retry.body, f.calls[1]!.body)
  }
})

test('QQ上游拒绝定稿时仅关闭已确认前缀，未知中间帧后仍尝试DONE排空', async () => {
  const rejected = fixture(), stream = rejected.sender.privateStream(target)
  rejected.setHandler(async () => {
    if (rejected.calls.at(-1)!.body.input_state === 10 && String(rejected.calls.at(-1)!.body.content_raw).includes('被拒尾部')) throw new QqApiError('stream', 400, 40034028)
    return { stream_msg_id: 'stream_synthetic' }
  })
  stream.push('已确认\n'); await stream.flush()
  const result = await stream.finish('已确认\n被拒尾部')
  assert.equal(result.outcome, 'unknown'); assert.equal(result.closed, true)
  assert.equal(rejected.calls.at(-1)!.body.content_raw, '已确认\n')
  assert.deepEqual(rejected.calls.map(call => call.body.index), [0, 1, 1])
  const transient = fixture(), another = transient.sender.privateStream(target)
  transient.setHandler(async () => { if (transient.calls.length === 2) throw new QqApiError('stream', 503); return { stream_msg_id: 'stream_synthetic' } })
  another.push('前缀\n'); await another.flush()
  another.push('后续\n'); await another.flush()
  assert.equal((await another.finish('前缀\n后续\n尾部')).closed, true)
  assert.equal(transient.calls.at(-1)!.body.input_state, 10)
  assert.equal(transient.calls.at(-1)!.body.stream_msg_id, 'stream_synthetic')
})

test('QQ已知流瞬时失败以相同stream ID/index/body有限重放，确认后才推进index', async () => {
  for (const error of [new QqApiError('stream', 503), new QqApiError('stream'), new QqApiError('stream', 429, 50002), new QqApiError('stream', 200, 50001, 'FAILED_CONFIRMED')]) {
    const f = fixture(), stream = f.sender.privateStream(target)
    f.setHandler(async () => { if (f.calls.length === 2) throw error; return { stream_msg_id: 'stream_synthetic' } })
    stream.push('已确认前缀\n'); await stream.flush()
    stream.push('追加行\n'); await stream.flush()
    const result = await stream.finish()
    assert.equal(result.outcome, 'accepted')
    assert.equal(result.closed, true)
    assert.deepEqual(f.calls.map(call => call.body.index), [0, 1, 1, 2])
    assert.deepEqual(f.calls[2]!.body, f.calls[1]!.body)
    assert.equal(f.calls[2]!.body.stream_msg_id, 'stream_synthetic')
    assert.equal(f.calls.filter(call => !call.body.stream_msg_id).length, 1)
    assert.deepEqual(f.waits, [error.statusCode === 429 ? 1000 : 500])
    assert.equal(f.sequenceCalls.length, 1)
  }
})

test('QQ首帧明确限流或50001可同帧重试，缺ID成功响应不可当成瞬时错误重开', async () => {
  for (const code of [50001, 50002]) {
    const f = fixture(), stream = f.sender.privateStream(target)
    f.setHandler(async () => { if (f.calls.length === 1) throw new QqApiError('stream', code === 50002 ? 429 : 200, code, 'FAILED_CONFIRMED'); return { stream_msg_id: 'stream_synthetic' } })
    assert.equal((await stream.finish('合成正文')).closed, true)
    assert.deepEqual(f.calls[0]!.body, f.calls[1]!.body)
    assert.equal(f.sequenceCalls.length, 1)
  }
  const f = fixture(), stream = f.sender.privateStream(target)
  f.setHandler(async () => ({}))
  stream.push('完整行\n'); await stream.flush()
  assert.equal((await stream.finish()).outcome, 'unknown')
  assert.equal(f.calls.length, 1)
})

test('QQ序列存储不可用时fail closed且不同Bot计数隔离，不使用本地序列兜底', async () => {
  const f = fixture()
  const sender = createQqSender({ botId: '42', client: { call: async () => { throw new Error('不应请求平台') } },
    sequences: { nextPassive: async () => { throw new Error('synthetic-redis-secret') }, nextStream: async () => { throw new Error('synthetic-redis-secret') } }, sanitizeText: text => text })
  assert.deepEqual(await sender.text(target, '合成正文'), { outcome: 'unknown', platformMessageIds: [] })
  assert.equal((await sender.privateStream(target).finish('合成正文')).outcome, 'unknown')
  assert.equal(f.calls.length, 0)
  await f.sender.text({ ...target, messageId: 'ROBOT1.0_synthetic.reply=id' }, '合成正文')
  assert.equal(f.calls[0]!.body.msg_id, 'ROBOT1.0_synthetic.reply=id')
  assert.equal((f.sequenceCalls[0] as Record<string, unknown>).botId, '41')
})

test('QQ真实client经合成transport完成鉴权、原生文本与stream协议发送', async () => {
  const requests: ProviderHttpRequest[] = [], f = fixture()
  const client = createQqClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', sandbox: false, transport: { request: async request => {
    requests.push(request)
    const data = request.url.includes('/getAppAccessToken') ? { access_token: 'synthetic-access', expires_in: 7200 }
      : request.url.endsWith('/stream_messages') ? { stream_msg_id: 'stream_real_client' } : { id: 'message_real_client' }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })(), cancel: async () => {} }
  } } })
  try {
    const sender = createQqSender({ botId: '41', client, sequences: f.sequences, sanitizeText: text => text })
    await sender.text(target, '[链接](gugu://private/path)')
    await sender.privateStream(target).finish('合成流正文')
    assert.equal(requests.length, 3)
    assert.equal(new URL(requests[0]!.url).hostname, 'bots.qq.com')
    assert.equal(new URL(requests[1]!.url).hostname, 'api.sgroup.qq.com')
    assert.deepEqual(JSON.parse(Buffer.from(requests[1]!.body as Uint8Array).toString()), { msg_type: 2, msg_seq: 1, markdown: { content: '链接' }, msg_id: 'inbound-synthetic' })
    assert.deepEqual(JSON.parse(Buffer.from(requests[2]!.body as Uint8Array).toString()), { input_mode: 'replace', input_state: 10, content_type: 'markdown', content_raw: '合成流正文\n', msg_seq: 2, index: 0, msg_id: 'inbound-synthetic', event_id: 'inbound-synthetic' })
  } finally { await client.close() }
})

async function until(check: () => boolean) {
  for (let index = 0; index < 100; index++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  assert.ok(check(), 'QQ出站状态未达到预期')
}

test('QQ可信统一prompt投影为互斥单次按钮，确认/取消token不进入文本说明', async () => {
  const f = fixture(), prompt = { prompt_id: 17, title: '发送邮件', body: '确认后继续执行当前任务。', task_paused: true,
    options: [{ id: 'confirm', label: '确认', token: 'opaque-confirm-token' }, { id: 'cancel', label: '取消', token: 'opaque-cancel-token' }] }
  const result = await f.sender.interaction(target, prompt)
  assert.deepEqual(result, { outcome: 'accepted', platformMessageIds: ['message_1'], delivery: 'native', buttonCount: 2 })
  const request = f.calls[0]!.body
  assert.equal(request.msg_id, undefined, '工具交互应使用主动消息')
  assert.equal(request.msg_type, 2)
  const text = (request.markdown as { content: string }).content
  assert.ok(text.startsWith('⏸️ 任务已暂停，等待确认。'))
  assert.ok(text.includes('请点击下方按钮；若未显示按钮，可回复选项序号或选项文字。'))
  assert.equal(text.includes('opaque-'), false)
  assert.deepEqual(request.keyboard, { content: { rows: [{ buttons: [
    { id: 'gugu-17-1', render_data: { label: '确认', visited_label: '已选择', style: 1 }, group_id: 'gugu-prompt-17', action: { type: 1, permission: { type: 2 }, click_limit: 1, data: '17:opaque-confirm-token', unsupport_tips: '请回复选项序号或选项文字' } },
    { id: 'gugu-17-2', render_data: { label: '取消', visited_label: '已选择', style: 1 }, group_id: 'gugu-prompt-17', action: { type: 1, permission: { type: 2 }, click_limit: 1, data: '17:opaque-cancel-token', unsupport_tips: '请回复选项序号或选项文字' } },
  ] }] } })
  assert.equal(JSON.stringify(request).includes('session_id'), false)
})

test('QQ按钮按40单位最多5行排列，容量不足只发送旧文本恢复说明', async () => {
  const counts = (labels: string[]) => {
    const wire = buildQqKeyboard({ prompt_id: 7, options: labels.map((label, index) => ({ id: `option-${index}`, label, token: `token-${index}` })) })
    return (wire.content as { rows: { buttons: unknown[] }[] }).rows.map(row => row.buttons.length)
  }
  assert.deepEqual(counts(['是', '否', '取消', '稍后再说']), [4])
  assert.deepEqual(counts(['是', '否', '取消', '稍后再说', '自定义']), [4, 1])
  assert.deepEqual(counts(['1（主按钮）', '2（次按钮）', '3（文字按钮）', '都没点开', '自定义回复']), [2, 2, 1])
  assert.deepEqual(counts(['继续聊费马大理石', '看下体型问题', '聊 Anthropic FLT', '看 OpenAI NS', '澳门早茶推荐', '晚安', '继续 Anthropic 细节', '看下体型 + 减肥进展', '自定义回复']), [2, 2, 2, 1, 2])
  assert.throws(() => counts(Array(11).fill('自定义回复内容很长')), RangeError)
  const f = fixture()
  const result = await f.sender.interaction(target, { prompt_id: 7, options: Array.from({ length: 11 }, (_, index) => ({ id: `option-${index}`, label: '自定义回复内容很长', token: `token-${index}` })) })
  assert.equal(result.delivery, 'text')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.body.keyboard, undefined)
  assert.equal(JSON.stringify(f.calls[0]!.body).includes('token-'), false)
})

test('QQ空选项、自定义回复和凭据入口使用旧文本，非法或已解决prompt不得变成新确认', async () => {
  const f = fixture()
  assert.equal((await f.sender.interaction(target, { prompt_id: 7, options: [] })).delivery, 'text')
  assert.ok(JSON.stringify(f.calls[0]!.body).includes('请在网页中填写后提交。'))
  const custom = formatQqInteractionFallback({ prompt_id: 7, allow_text_input: true, native_keyboard: true, options: [{ id: 'custom', label: '自定义回复' }] })
  assert.ok(custom.includes('请点击“自定义回复”后发送内容'))
  await f.sender.interaction({ ...target, chatType: 'group' }, { prompt_id: 8, title: '凭据输入', secret_fields: [{ name: 'api_key', value: 'must-not-leak' }] })
  assert.ok(JSON.stringify(f.calls.at(-1)!.body).includes('群聊不接收凭据'))
  assert.equal(JSON.stringify(f.calls.at(-1)!.body).includes('must-not-leak'), false)
  const count = f.calls.length
  assert.equal((await f.sender.interaction(target, { prompt_id: 0 })).outcome, 'rejected')
  assert.equal((await f.sender.interaction(target, { prompt_id: 7, resolved: true, options: [{ token: 'old-token' }] })).outcome, 'rejected')
  assert.equal((await f.sender.interaction(target, { prompt_id: 7, options: [{ token: 'unsafe:token' }] })).outcome, 'rejected')
  assert.equal(f.calls.length, count)
})

test('QQ按钮平台确定拒绝才文本降级，未知发送不重复交互', async () => {
  for (const uncertain of [true, false]) {
    const f = fixture()
    f.setHandler(async () => { if (f.calls.length === 1) throw new QqApiError('message', uncertain ? 503 : 400, uncertain ? undefined : 40034012); return { id: 'fallback-id' } })
    const result = await f.sender.interaction(target, { prompt_id: 7, options: [{ id: 'cancel', label: '取消', token: 'cancel-token' }] })
    assert.equal(result.outcome, uncertain ? 'unknown' : 'accepted')
    assert.equal(f.calls.length, uncertain ? 1 : 2)
    if (!uncertain) assert.equal(f.calls[1]!.body.keyboard, undefined)
  }
})

test('QQ链接按钮使用跳转action且不带callback token，不支持链接保留旧说明', async () => {
  const f = fixture()
  const native = await f.sender.linkButtons(target, '导航', [{ id: 'web', label: '网页', url: 'https://example.test/path' }, { id: 'map', label: '地图', url: 'baidumap://map/place/detail?uid=synthetic_uid' }])
  assert.equal(native.delivery, 'native')
  assert.equal(f.calls[0]!.body.msg_id, undefined)
  const wire = f.calls[0]!.body.keyboard as { content: { rows: { buttons: { action: Record<string, unknown> }[] }[] } }
  assert.deepEqual(wire.content.rows[0]!.buttons[0]!.action, { type: 0, permission: { type: 2 }, data: 'https://example.test/path', unsupport_tips: '当前客户端不支持打开链接' })
  assert.equal(wire.content.rows[0]!.buttons[1]!.action.data, 'https://api.map.baidu.com/place/detail?uid=synthetic_uid&output=html')
  const count = f.calls.length
  assert.equal((await f.sender.linkButtons(target, '导航', [{ id: 'unsupported', label: '专用入口', url: 'customapp://page' }])).delivery, 'text')
  assert.equal(f.calls[count]!.body.keyboard, undefined)
  assert.ok(JSON.stringify(f.calls[count]!.body).includes('QQ 不支持直接打开此链接'))
  assert.equal(JSON.stringify(f.calls[count]!.body).includes('customapp://'), false)
  assert.equal((await f.sender.linkButtons(target, '导航', [{ id: 'unsafe', label: '无效', url: 'javascript:alert(1)' }])).outcome, 'rejected')
})

test('QQ真实client发送Keyboard、链接按钮与协议ACK，ACK不声称消费业务动作', async () => {
  const f = fixture(), requests: ProviderHttpRequest[] = []
  const client = createQqClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', sandbox: false, transport: { request: async request => {
    requests.push(request)
    const auth = request.url.includes('/getAppAccessToken'), ack = request.url.includes('/interactions/')
    const data = auth ? { access_token: 'synthetic-access', expires_in: 7200 } : ack ? {} : { id: `message_${requests.length}` }
    return { status: ack ? 204 : 200, headers: {}, body: (async function* () { if (!ack) yield Buffer.from(JSON.stringify(data)) })(), cancel: async () => {} }
  } } })
  try {
    const sender = createQqSender({ botId: '41', client, sequences: f.sequences, sanitizeText: text => text })
    await sender.interaction(target, { prompt_id: 7, title: '需要确认', options: [{ id: 'cancel', label: '取消', token: 'opaque-cancel' }] })
    await sender.linkButtons(target, '导航', [{ id: 'web', label: '网页', url: 'https://example.test' }])
    assert.deepEqual(await sender.ackInteraction('interaction-synthetic', 3), { outcome: 'accepted', acknowledged: true })
    assert.equal(requests.length, 4)
    const prompt = JSON.parse(Buffer.from(requests[1]!.body as Uint8Array).toString())
    assert.equal(prompt.msg_type, 2)
    assert.equal(prompt.keyboard.content.rows[0].buttons[0].action.data, '7:opaque-cancel')
    assert.equal(prompt.msg_id, undefined)
    const link = JSON.parse(Buffer.from(requests[2]!.body as Uint8Array).toString())
    assert.equal(link.keyboard.content.rows[0].buttons[0].action.type, 0)
    assert.equal(requests[3]!.method, 'PUT')
    assert.equal(new URL(requests[3]!.url).pathname, '/interactions/interaction-synthetic')
    assert.deepEqual(JSON.parse(Buffer.from(requests[3]!.body as Uint8Array).toString()), { code: 3 })
    assert.deepEqual(await sender.ackInteraction(''), { outcome: 'rejected', acknowledged: false })
    assert.equal(requests.length, 4)
  } finally { await client.close() }
})
