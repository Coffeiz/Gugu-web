import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderHttpRequest } from '@gugu/core/providers'
import type { RunEvent } from '@gugu/core/agent'
import { buildFeishuStreamingCard, createFeishuRunEventProjector, type FeishuStreamEvent } from '@gugu/gateway/feishu'
import { FeishuPresentation, type FeishuToolSummaryPolicy } from '@gugu/gateway/feishu'
import { createFeishuClient, FeishuApiError } from '@gugu/gateway/feishu'
import { createFeishuStreamingSender } from '../../../../src/modules/im/gateway/platforms/feishu/streaming.js'

async function* stream(...events: FeishuStreamEvent[]) { yield* events }
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
const identity = { ownerId: 'synthetic-owner', sessionId: 'synthetic-session', runId: 'synthetic-run' }
function runEvent(type: RunEvent['type'], payload: RunEvent['payload'], sequence = 1): RunEvent { return { type, payload, identity, id: `event-${sequence}`, sequence, round: 1 } }
const clean = (text: string) => text.replaceAll('synthetic-secret', '[已脱敏]')
function fixture() {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  let time = 0, identifiers = 0
  let handler = async (_path: string): Promise<Record<string, unknown>> => ({ code: 0, data: { card_id: 'card_synthetic', message_id: 'om_synthetic' } })
  const writer = createFeishuStreamingSender({ client: { call: async (method, path, args) => { calls.push({ method, path, body: args?.body }); return handler(path) } }, now: () => time, generateId: () => `uuid-${++identifiers}` })
  return { writer, calls, tick(ms: number) { time += ms }, setHandler(value: typeof handler) { handler = value } }
}

test('飞书流式200ms或30个Unicode字符触发patch，结束前消费完生成器且共享sequence', async () => {
  const f = fixture(), seen: string[] = []
  async function* events(): AsyncIterable<FeishuStreamEvent> {
    yield { type: 'token', text: '😀'.repeat(29) }
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0)
    yield { type: 'token', text: 'a' }
    assert.equal(f.calls.filter(call => call.path.includes('/elements/')).length, 1)
    f.tick(199)
    yield { type: 'token', text: 'b' }
    assert.equal(f.calls.filter(call => call.path.includes('/elements/')).length, 1)
    f.tick(1)
    yield { type: 'token', text: 'c' }
    assert.equal(f.calls.filter(call => call.path.includes('/elements/')).length, 2)
    yield { type: 'final', text: '最终回复' }
    seen.push('exhausted')
  }
  const result = await f.writer.send('oc_synthetic', events())
  assert.deepEqual(result, { outcome: 'accepted', platformMessageIds: ['om_synthetic'], visible: true, cardId: 'card_synthetic', final: { type: 'final', text: '最终回复' } })
  assert.deepEqual(seen, ['exhausted'])
  assert.deepEqual(f.calls[1]!.body, { receive_id: 'oc_synthetic', msg_type: 'interactive', content: '{"type":"card","data":{"card_id":"card_synthetic"}}' })
  const edits = f.calls.filter(call => call.method === 'PUT' || call.method === 'PATCH')
  assert.deepEqual(edits.map(call => call.body!.sequence), [1, 2, 3, 4, 5])
  assert.deepEqual(edits.slice(0, 4).map(call => call.body!.uuid), ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4'])
  assert.deepEqual(JSON.parse(String(edits[3]!.body!.settings)), { config: { streaming_mode: false, summary: { content: '最终回复' } } })
  const card = JSON.parse(String((edits[4]!.body!.card as Record<string, unknown>).data))
  assert.equal(card.header.title.content, '咕咕')
  assert.equal(card.config.streaming_mode, false)
  assert.equal(card.body.elements[0].content, '最终回复')
})

test('飞书可见卡片更新或关闭失败保持unknown，完整消费但绝不重复全文', async () => {
  for (const failure of ['patch', 'settings', 'final']) {
    const f = fixture()
    f.setHandler(async path => {
      if (failure === 'patch' && path.includes('/elements/') || failure === 'settings' && path.endsWith('/settings') || failure === 'final' && path.endsWith('/card_synthetic')) throw new Error('synthetic-private-content')
      return { code: 0, data: { card_id: 'card_synthetic', message_id: 'om_synthetic' } }
    })
    let consumed = false
    async function* events(): AsyncIterable<FeishuStreamEvent> { yield { type: 'token', text: 'x'.repeat(30) }; yield { type: 'final', text: '最终回复' }; consumed = true }
    const result = await f.writer.send('oc_synthetic', events())
    assert.equal(result.outcome, 'unknown')
    assert.equal(result.visible, true)
    assert.equal(consumed, true)
    assert.equal(f.calls.filter(call => call.path.includes('/im/v1/messages?')).length, 1)
    assert.equal(JSON.stringify(result).includes('synthetic-private-content'), false)
  }
})

test('飞书不可见且确定拒绝才普通fallback，创建超时和消息ID未知禁止重发', async () => {
  for (const mode of ['create-rejected', 'bridge-rejected', 'create-timeout', 'bridge-missing']) {
    const f = fixture()
    f.setHandler(async path => {
      if (path.endsWith('/cards') && mode === 'create-rejected') throw new FeishuApiError('card', 403)
      if (path.endsWith('/cards') && mode === 'create-timeout') throw new Error('synthetic-token')
      const body = f.calls.at(-1)!.body
      if (path.includes('/messages?') && String(body!.content).includes('"type":"card"')) {
        if (mode === 'bridge-rejected') throw new FeishuApiError('message', 400, 200380)
        if (mode === 'bridge-missing') return { code: 0, data: {} }
      }
      return { code: 0, data: { card_id: 'card_synthetic', message_id: 'om_synthetic' } }
    })
    const result = await f.writer.send('oc_synthetic', stream({ type: 'final', text: '最终回复' }))
    const rejected = mode.endsWith('rejected')
    assert.equal(result.outcome, rejected ? 'accepted' : 'unknown')
    assert.equal(f.calls.filter(call => call.path.includes('/messages?')).length, mode === 'create-rejected' ? 1 : mode === 'bridge-rejected' ? 2 : mode === 'bridge-missing' ? 1 : 0)
  }
})

test('飞书取消保留partial，文件无正文使用旧用户文案，summary按Unicode80字符限制', async () => {
  const cancelled = fixture()
  await cancelled.writer.send('oc_synthetic', stream({ type: 'token', text: '已收到的部分' }, { type: 'final', text: '', cancelled: true }))
  assert.equal(cancelled.calls.find(call => call.path.includes('/elements/'))!.body!.content, '已收到的部分')
  const files = fixture()
  await files.writer.send('oc_synthetic', stream({ type: 'final', text: '', hasFiles: true }))
  assert.equal(files.calls.find(call => call.path.includes('/elements/'))!.body!.content, '给你～')
  const long = fixture()
  await long.writer.send('oc_synthetic', stream({ type: 'final', text: '😀'.repeat(90) }))
  const settings = JSON.parse(String(long.calls.find(call => call.path.endsWith('/settings'))!.body!.settings))
  assert.equal(settings.config.summary.content, '😀'.repeat(77) + '...')
})

test('飞书未建立可见卡片时遵守隐藏中间回复和取消空正文', async () => {
  const hidden = fixture()
  hidden.setHandler(async path => {
    if (path.endsWith('/cards')) throw new FeishuApiError('card', 403)
    return { code: 0, data: { message_id: 'om_fallback' } }
  })
  await hidden.writer.send('oc_synthetic', stream({ type: 'token', text: '不可展示的中间文本' }), { showIntermediateReplies: false })
  const body = hidden.calls.find(call => call.path.includes('/messages?'))!.body!
  assert.equal(String(body.content).includes('不可展示的中间文本'), false)
  assert.equal(String(body.content).includes('嗯~在的，你说～'), true)
  const cancelled = fixture()
  cancelled.setHandler(async () => { throw new FeishuApiError('card', 403) })
  assert.equal((await cancelled.writer.send('oc_synthetic', stream({ type: 'final', text: '', cancelled: true }))).outcome, 'rejected')
  assert.equal(cancelled.calls.length, 1)
})

test('飞书yield token后业务异常在卡片尽可能收尾后原样传播，区别于平台unknown', async () => {
  for (const cleanupFails of [false, true]) {
    const f = fixture(), businessError = new Error('合成业务生成器失败')
    if (cleanupFails) f.setHandler(async path => {
      if (path.includes('/elements/') || path.endsWith('/settings') || path.endsWith('/card_synthetic')) throw new FeishuApiError('card', 503)
      return { code: 0, data: { card_id: 'card_synthetic', message_id: 'om_synthetic' } }
    })
    async function* failed(): AsyncIterable<FeishuStreamEvent> { yield { type: 'token', text: '已有部分' }; throw businessError }
    await assert.rejects(f.writer.send('oc_synthetic', failed()), error => {
      assert.equal(error, businessError, '收尾失败不得吞掉或替换原业务异常')
      assert.equal(f.calls.some(call => call.path.endsWith('/settings')), true)
      assert.equal(f.calls.at(-1)!.method, 'PUT')
      assert.equal(f.calls.at(-1)!.path, '/open-apis/cardkit/v1/cards/card_synthetic')
      const card = JSON.parse(String((f.calls.at(-1)!.body!.card as Record<string, unknown>).data))
      assert.equal(card.config.streaming_mode, false)
      assert.equal(card.body.elements[0].content, '已有部分')
      return true
    })
    assert.equal(f.calls.filter(call => call.path.includes('/messages?')).length, 1, '业务异常不得导致重复发送全文')
  }
})

test('飞书未建立可见卡片时业务生成器异常仍原样传播，不能用文本fallback掩盖', async () => {
  const f = fixture(), businessError = new Error('合成未可见业务失败')
  f.setHandler(async () => { throw new FeishuApiError('card', 403) })
  async function* failed(): AsyncIterable<FeishuStreamEvent> { yield { type: 'token', text: '部分结果' }; throw businessError }
  await assert.rejects(f.writer.send('oc_synthetic', failed()), error => error === businessError)
  assert.equal(f.calls.length, 1)
})

test('飞书流式协议通过真实client与合成HTTP transport执行create/bridge/update/close', async () => {
  const requests: ProviderHttpRequest[] = []
  const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport: { request: async request => {
    requests.push(request)
    const path = new URL(request.url).pathname
    const data = path.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }
      : path.endsWith('/cards') ? { code: 0, data: { card_id: 'card_synthetic' } }
        : path.endsWith('/messages') ? { code: 0, data: { message_id: 'om_synthetic' } } : { code: 0, data: {} }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })(), cancel: async () => {} }
  } } })
  try {
    const result = await createFeishuStreamingSender({ client, generateId: () => 'synthetic-uuid' }).send('ou_synthetic', stream({ type: 'final', text: '最终正文' }))
    assert.equal(result.outcome, 'accepted')
    assert.deepEqual(requests.map(request => request.method), ['POST', 'POST', 'POST', 'PUT', 'PATCH', 'PUT'])
    const create = JSON.parse(Buffer.from(requests[1]!.body as Uint8Array).toString())
    assert.equal(create.type, 'card_json')
    assert.deepEqual(JSON.parse(create.data), buildFeishuStreamingCard('咕咕正在想…'))
    assert.equal(requests[1]!.headers['content-type'], 'application/json; charset=utf-8')
    const updates = requests.slice(3).map(request => JSON.parse(Buffer.from(request.body as Uint8Array).toString()))
    assert.deepEqual(updates.map(body => body.sequence), [1, 2, 3])
    assert.equal(new URL(requests[2]!.url).searchParams.get('receive_id_type'), 'open_id')
  } finally { await client.close() }
})

test('RunEvent图表投影识别分片顶层围栏，跳过内嵌示例、未闭合与超限且原文不变', async () => {
  const requests: { type: string; source: string }[] = []
  const projector = createFeishuRunEventProjector({ renderCharts: async request => { requests.push(...request.charts); return [png] } })
  const source = '```mermaid\ngraph LR\n A-->B\n```'
  const text = '````markdown\n```mermaid\nignored\n```\n````\n图前\n' + source + '\n```tex\nx^2\n```\n'
  const results: FeishuStreamEvent[] = []
  for (const part of [...text]) results.push(...await projector.push(runEvent('token', { text: part })))
  results.push(...await projector.push(runEvent('final', { text, status: 'completed', files: [] })))
  assert.deepEqual(requests, [{ type: 'mermaid', source: 'graph LR\n A-->B\n' }, { type: 'math', source: 'x^2\n' }])
  assert.equal(results.filter(event => event.type === 'token').map(event => event.text).join(''), text)
  assert.deepEqual(results.filter(event => event.type === 'chart_image').map(event => event.source), [source, '```tex\nx^2\n```'])
  const unclosed = createFeishuRunEventProjector({ renderCharts: async () => { assert.fail('未闭合/超限不应调用renderer') } })
  await unclosed.push(runEvent('token', { text: '```latex\n' + 'x'.repeat(20001) + '\n```\n```mermaid\nunclosed' }))
  const last = await unclosed.push(runEvent('final', { text: 'canonical', status: 'cancelled' }))
  assert.deepEqual(last, [{ type: 'final', text: 'canonical', cancelled: true, hasFiles: false }])
})

test('图表renderer失败或非PNG不生成伪图片，final无末尾换行也能完成合法图表', async () => {
  for (const renderCharts of [async () => { throw new Error('synthetic-secret') }, async () => [new Uint8Array([1, 2])], async () => [null]]) {
    const projector = createFeishuRunEventProjector({ renderCharts })
    const result = await projector.push(runEvent('token', { text: '```mermaid\ngraph LR\n A-->B\n```\n' }))
    assert.deepEqual(result, [{ type: 'token', text: '```mermaid\ngraph LR\n A-->B\n```\n' }])
  }
  const projector = createFeishuRunEventProjector({ renderCharts: async () => [png] })
  await projector.push(runEvent('token', { text: '```latex\nx\n```' }))
  const final = await projector.push(runEvent('final', { text: '```latex\nx\n```' }))
  assert.equal(final[0]!.type, 'chart_image')
})

test('群聊工具仅完成状态，同call更新一个折叠组，不展示输入结果或工具执行中', () => {
  const summary = new FeishuPresentation({ chatType: 'group', sanitize: clean })
  assert.equal(summary.tool({ type: 'tool_call', toolCallId: 'a', name: 'search', input: 'synthetic-secret', status: 'running' }), false)
  assert.equal(summary.tool({ type: 'tool_done', toolCallId: 'a', name: 'search', result: 'synthetic-secret', status: 'success' }), true)
  summary.tool({ type: 'tool_done', toolCallId: 'a', name: 'search', result: 'private-output', status: 'waiting' })
  summary.tool({ type: 'tool_done', toolCallId: 'b', name: 'send_file', result: { delivery_status: 'unknown' }, status: 'success' })
  const panels = summary.elements()
  assert.equal(panels.length, 1)
  assert.deepEqual((panels[0]!.header as any).title, { tag: 'plain_text', content: '🛠 工具摘要 (2)' })
  assert.equal(panels[0]!.expanded, false)
  assert.deepEqual((panels[0]!.elements as any[]).map(value => value.content), ['⏸️ search：任务已暂停，等待确认', '⚠️ 文件发送结果未确认，请先检查是否收到'])
  assert.doesNotMatch(JSON.stringify(panels), /synthetic-secret|private-output/)
  const malformedPolicy = new FeishuPresentation({ chatType: 'group', includeDetails: true, sanitize: clean } as unknown as FeishuToolSummaryPolicy)
  malformedPolicy.tool({ type: 'tool_done', name: 'tool', status: 'success', result: 'private-output' })
  assert.doesNotMatch(JSON.stringify(malformedPolicy.elements()), /private-output/, '运行时群聊策略同样拒绝误开详情')
})

test('私聊详情按call合并、脱敏限长并隔离工具面板，取消收束执行中状态', () => {
  const summary = new FeishuPresentation({ chatType: 'p2p', includeDetails: true, sanitize: clean })
  summary.tool({ type: 'tool_call', toolCallId: 'a', name: 'search', input: { query: 'synthetic-secret' }, status: 'running' })
  summary.tool({ type: 'tool_done', toolCallId: 'a', name: 'search', result: '```\n' + 'x'.repeat(3000), status: 'success' })
  summary.tool({ type: 'tool_call', toolCallId: 'b', name: 'read', status: 'running' })
  summary.finish('', true)
  const panels = summary.elements()
  assert.equal(panels.length, 2)
  const text = JSON.stringify(panels)
  assert.doesNotMatch(text, /synthetic-secret/)
  assert.match(text, /已脱敏/)
  assert.match(text, /已停止/)
  assert.match(text, /\*\*输入\*\*/)
  assert.match(text, /\*\*结果\*\*/)
  assert.doesNotMatch(text, new RegExp('x'.repeat(1201)))
  assert.match(text, /` ` `/)
})

test('工具摘要保持回复与轮次顺序，上限24和组件cap保留省略提示', () => {
  const summary = new FeishuPresentation({ chatType: 'group', sanitize: clean })
  summary.append('开始'); summary.endRound()
  for (let i = 0; i < 30; i++) summary.tool({ type: 'tool_done', toolCallId: `call-${i}`, name: `tool-${i}`, status: 'success' })
  summary.append('后续'); summary.finish('最终', false)
  const elements = summary.elements()
  assert.equal(elements[0]!.content, '开始')
  assert.equal((elements[1]!.elements as unknown[]).length, 24)
  assert.equal(elements[2]!.content, '最终')
  assert.equal(elements[3]!.content, '_另有 6 个工具调用摘要未展示。_')
  const huge = new FeishuPresentation({ chatType: 'p2p', includeDetails: true, sanitize: clean })
  for (let i = 0; i < 24; i++) { huge.append('|a|b|\n|---|---|\n' + '|x|y|\n'.repeat(30)); huge.tool({ type: 'tool_done', name: 'tool', status: 'success' }) }
  function tags(value: any): number { return Array.isArray(value) ? value.reduce((n, item) => n + tags(item), 0) : value && typeof value === 'object' ? Number('tag' in value) + Object.values(value).reduce<number>((n, item) => n + tags(item), 0) : 0 }
  // 正文可按Python退回单markdown；工具面板不会再把巨大表格放大成无限组件。
  assert.ok(tags(huge.elements()) < 240)
})

test('图表同卡原位替换后使用新的流式元素，最终正文改写不能遗留旧图', async () => {
  const f = fixture(), source = '```mermaid\ngraph LR\n A-->B\n```'
  f.setHandler(async () => ({ code: 0, data: { card_id: 'card_synthetic', message_id: 'om_synthetic', image_key: 'img_synthetic' } }))
  const result = await f.writer.send('oc_synthetic', stream({ type: 'token', text: '图前\n' + source }, { type: 'chart_image', source, png },
    { type: 'token', text: '图后' + 'a'.repeat(30) }, { type: 'final', text: '图前\n' + source + '图后' }))
  assert.equal(result.outcome, 'accepted')
  assert.equal(f.calls.some(call => call.path.endsWith('/elements/markdown_2/content')), true)
  const cards = f.calls.filter(call => call.body?.card).map(call => JSON.parse(String((call.body!.card as any).data)))
  assert.deepEqual(cards.at(-1).body.elements.map((item: any) => item.tag), ['markdown', 'img', 'markdown'])
  assert.equal(cards.at(-1).body.elements[1].img_key, 'img_synthetic')
  assert.equal(cards.at(-1).body.elements[2].content, '图后')
  assert.equal(f.calls.filter(call => call.path.includes('/messages?')).length, 1)
  const presentation = new FeishuPresentation()
  presentation.append(source); presentation.replace(source, 'img_synthetic'); presentation.finish('已清洗的新正文', false)
  assert.deepEqual(presentation.elements(), [{ tag: 'markdown', content: '已清洗的新正文', element_id: 'markdown_1' }])
})

test('图表上传失败保留源码，原位更新未知不另发全文，工具失败仍排空并原样抛业务错误', async () => {
  const source = '```mermaid\nx\n```'
  for (const failure of ['upload', 'update']) {
    const f = fixture()
    f.setHandler(async path => {
      if (failure === 'upload' && path.endsWith('/images') || failure === 'update' && path.endsWith('/card_synthetic')) throw new Error('synthetic-secret')
      return { code: 0, data: { card_id: 'card_synthetic', message_id: 'om_synthetic', image_key: 'img_synthetic' } }
    })
    const result = await f.writer.send('oc_synthetic', stream({ type: 'token', text: source }, { type: 'chart_image', source, png }, { type: 'final', text: source }))
    assert.equal(result.outcome, failure === 'upload' ? 'accepted' : 'unknown')
    assert.equal(f.calls.filter(call => call.path.includes('/messages?')).length, 1)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/)
    if (failure === 'upload') assert.match(String((f.calls.at(-1)!.body!.card as any).data), /mermaid/)
  }
  const f = fixture(), original = new Error('业务原异常')
  async function* events(): AsyncIterable<FeishuStreamEvent> { yield { type: 'tool_done', name: 'tool', status: 'success' }; throw original }
  await assert.rejects(f.writer.send('oc_synthetic', events(), { toolSummary: { chatType: 'group', sanitize: clean } }), error => error === original)
})

test('流卡确定不可用时私聊工具详情仍文字回退，群聊回退不泄露详情', async () => {
  for (const chatType of ['p2p', 'group'] as const) {
    const f = fixture()
    f.setHandler(async path => {
      if (path.endsWith('/cards')) throw new FeishuApiError('card', 403)
      return { code: 0, data: { message_id: 'om_fallback' } }
    })
    const policy: FeishuToolSummaryPolicy = chatType === 'p2p' ? { chatType, includeDetails: true, sanitize: clean } : { chatType, sanitize: clean }
    const receipt = await f.writer.send('oc_synthetic', stream({ type: 'tool_call', toolCallId: 'a', name: 'tool', status: 'running', input: { value: 'synthetic-secret' } },
      { type: 'tool_done', toolCallId: 'a', name: 'tool', status: 'success', result: 'synthetic-private-result' }, { type: 'final', text: '最终正文' }), { toolSummary: policy })
    assert.equal(receipt.outcome, 'accepted')
    const fallback = String(f.calls.at(-1)!.body!.content)
    assert.match(fallback, /最终正文/)
    assert.doesNotMatch(fallback, /synthetic-secret/)
    if (chatType === 'p2p') { assert.match(fallback, /已脱敏/); assert.match(fallback, /synthetic-private-result/) }
    else { assert.match(fallback, /工具|tool/); assert.doesNotMatch(fallback, /synthetic-private-result/) }
  }
})

test('实际RunEvent经projector和真实client上传multipart后同卡呈现工具与图表，HTTP及renderer明确替身', async () => {
  const requests: ProviderHttpRequest[] = []
  const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport: { request: async request => {
    requests.push(request)
    const path = new URL(request.url).pathname
    const data = path.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }
      : path.endsWith('/cards') ? { code: 0, data: { card_id: 'card_synthetic' } }
        : path.endsWith('/messages') ? { code: 0, data: { message_id: 'om_synthetic' } }
          : path.endsWith('/images') ? { code: 0, data: { image_key: 'img_synthetic' } } : { code: 0 }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })(), cancel: async () => {} }
  } } })
  const source = '```mermaid\ngraph LR\n A-->B\n```'
  let traversals = 0
  async function* events(): AsyncIterable<RunEvent> {
    traversals++; yield runEvent('run_started', {})
    yield runEvent('token', { text: '前文\n' + source + '\n' }, 2)
    yield runEvent('round_end', {}, 3)
    yield runEvent('tool_call', { toolCallId: 'call', name: 'search', status: 'running' }, 4)
    yield runEvent('tool_done', { toolCallId: 'call', name: 'search', status: 'success', result: 'synthetic-secret' }, 5)
    yield runEvent('token', { text: '尾文' }, 6)
    yield runEvent('final', { text: '尾文', status: 'completed', files: [] }, 7)
  }
  try {
    const receipt = await createFeishuStreamingSender({ client }).sendRun('oc_synthetic', events(), { renderCharts: async () => [png], toolSummary: { chatType: 'group', sanitize: clean } })
    assert.equal(receipt.outcome, 'accepted'); assert.equal(traversals, 1)
    assert.equal(requests.filter(request => new URL(request.url).pathname.endsWith('/messages')).length, 1)
    const upload = requests.find(request => new URL(request.url).pathname.endsWith('/images'))!
    assert.match(upload.headers['content-type']!, /^multipart\/form-data; boundary=/)
    assert.equal(Buffer.from(upload.body as Uint8Array).includes(Buffer.from(png)), true)
    const updates = requests.filter(request => request.method === 'PUT' || request.method === 'PATCH').map(request => JSON.parse(Buffer.from(request.body as Uint8Array).toString()))
    assert.deepEqual(updates.map(body => body.sequence), updates.map((_body, index) => index + 1))
    const card = JSON.parse(updates.at(-1).card.data)
    assert.deepEqual(card.body.elements.map((element: any) => element.tag), ['markdown', 'img', 'markdown', 'collapsible_panel', 'markdown'])
    assert.equal(card.body.elements.at(-1).content, '尾文')
    assert.doesNotMatch(JSON.stringify(card), /synthetic-secret|```mermaid/)
  } finally { await client.close() }
})

test('默认正式renderer真实栅格化Mermaid与LaTeX并经飞书client上传有效尺寸PNG，只有平台HTTP替身', async () => {
  const images: { width: number; height: number }[] = [], cards: any[] = []
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport: { request: async request => {
    const path = new URL(request.url).pathname
    const body = Buffer.from(request.body as Uint8Array)
    if (path.endsWith('/images')) {
      const offset = body.indexOf(signature)
      assert.ok(offset >= 0, 'multipart必须包含真实PNG字节')
      images.push({ width: body.readUInt32BE(offset + 16), height: body.readUInt32BE(offset + 20) })
    } else if (request.method === 'PUT' && !path.includes('/elements/')) {
      const payload = JSON.parse(body.toString())
      if (payload.card) cards.push(JSON.parse(payload.card.data))
    }
    const data = path.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }
      : path.endsWith('/cards') ? { code: 0, data: { card_id: 'card_synthetic' } }
        : path.endsWith('/messages') ? { code: 0, data: { message_id: 'om_synthetic' } }
          : path.endsWith('/images') ? { code: 0, data: { image_key: `img_real_${images.length}` } } : { code: 0 }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })(), cancel: async () => {} }
  } } })
  const source = '图示\n```mermaid\nflowchart LR; A --> B\n```\n公式\n```latex\nx^2 + y^2\n```\n完毕'
  async function* events(): AsyncIterable<RunEvent> { yield runEvent('token', { text: source }); yield runEvent('final', { text: source, status: 'completed' }, 2) }
  try {
    const receipt = await createFeishuStreamingSender({ client }).sendRun('oc_synthetic', events())
    assert.equal(receipt.outcome, 'accepted')
    assert.equal(images.length, 2)
    assert.ok(images.every(image => image.width > 0 && image.height > 0 && image.width * image.height <= 5_000_000))
    const elements: any[] = cards.at(-1).body.elements
    assert.deepEqual(elements.filter(element => element.tag === 'img').map(element => element.img_key), ['img_real_1', 'img_real_2'])
    assert.doesNotMatch(JSON.stringify(elements), /```mermaid|```latex/)
    assert.match(JSON.stringify(elements), /图示|公式|完毕/)
  } finally { await client.close() }
})
