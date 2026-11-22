import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, vi } from 'vitest'
import type { RunEvent, RunIdentity } from '../../src/agent/models.js'
import { createImRunDelivery, createImRunDeliveryRecovery, ImRunDeliveryBlocked } from '../../src/im/run-delivery.js'
import type { ImDeliveryResult, ImRunDeliveryPorts } from '../../src/im/run-delivery.js'
import { fixture, identity } from '../agent/run/fixtures.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('恢复专用入口仅消费正式outbox，不需要Runner且重复扫描不重发', async () => {
  const f = deliveryFixture([event(1, 'final', { text: '恢复结果', status: 'completed' })])
  const { runner: _runner, ...ports } = f.ports
  const recovery = createImRunDeliveryRecovery(ports)
  await recovery.recover(identity)
  await recovery.recover(identity)
  assert.equal(f.starts, 0)
  assert.equal(f.cursor, 1)
  assert.deepEqual(f.sent.map(item => item.value), ['恢复结果'])
  const revoked = deliveryFixture([event(1, 'final', { text: '撤权后禁止投递', status: 'completed' })])
  revoked.setAuthorized(false)
  const { runner: _unused, ...revokedPorts } = revoked.ports
  await assert.rejects(createImRunDeliveryRecovery(revokedPorts).recover(identity), ImRunDeliveryBlocked)
  assert.equal(revoked.sent.length, 0)
})
function event(sequence: number, type: RunEvent['type'], payload: RunEvent['payload'] = {}, round = 1): RunEvent {
  return { identity, id: `event-${sequence}`, sequence, round, type, payload }
}
function deliveryFixture(events: RunEvent[]) {
  let cursor = 0
  let starts = 0
  let drained = false
  let authorized = true
  let outcome: ImDeliveryResult = 'accepted'
  const receipts = new Map<string, { fingerprint: string; state: 'pending' | ImDeliveryResult }>()
  const sent: { kind: string; value: unknown; deliveryId: string }[] = []
  const ports: ImRunDeliveryPorts<unknown> = {
    // 序列用例只替换事件源；真实Runner用例在下方覆盖此端口。
    runner: { start: async function* () { starts++; try { yield* events } finally { drained = true } } as unknown as ImRunDeliveryPorts<unknown>['runner']['start'] },
    events: { readAfter: async (_identity, after) => events.filter(item => item.sequence > after) },
    receipts: {
      cursor: async () => cursor,
      begin: async (_identity, key, fingerprint) => {
        const previous = receipts.get(key)
        if (previous && previous.fingerprint !== fingerprint) throw new Error('投递内容冲突')
        if (previous && previous.state !== 'rejected') return previous.state
        receipts.set(key, { fingerprint, state: 'pending' }); return 'new'
      },
      settle: async (_identity, key, result) => { receipts.get(key)!.state = result },
      advance: async (_identity, expected, next) => { assert.equal(cursor, expected); cursor = next },
    },
    digest,
    authorize: async () => authorized,
    sender: {
      text: async input => { sent.push({ kind: 'text', value: input.text, deliveryId: input.deliveryId }); return outcome },
      artifact: async input => { sent.push({ kind: 'artifact', value: input.artifact, deliveryId: input.deliveryId }); return outcome },
      interaction: async input => { sent.push({ kind: 'interaction', value: input.event.payload, deliveryId: input.deliveryId }); return outcome },
    },
  }
  return { ports, sent, receipts, get cursor() { return cursor }, get starts() { return starts }, get drained() { return drained },
    setAuthorized(value: boolean) { authorized = value }, setOutcome(value: ImDeliveryResult) { outcome = value } }
}

test('Shell 提示按动作显示并兼容已提交的旧回执', async () => {
  const display = { shellActivity: { action: 'search', target: '合成内部目录' },
    toolInput: { command: 'rg synthetic src' }, toolLabelOverride: '通用 Shell 标签' }
  const events = [
    event(1, 'tool_done', { name: 'shell', status: 'success', display }),
    event(2, 'tool_done', { name: 'shell', status: 'success', display }),
    event(3, 'tool_done', { name: 'shell', status: 'error', display }),
  ]
  const f = deliveryFixture(events)
  f.receipts.set('tool-notice:1', { fingerprint: digest('✅ shell完成'), state: 'accepted' })
  const notices: string[] = []
  const recovery = createImRunDeliveryRecovery({
    ...f.ports,
    sender: { ...f.ports.sender, async toolNotice({ text }) { notices.push(text); return 'accepted' } },
  })
  await recovery.recover(identity)
  assert.deepEqual(notices, ['✅ 搜索内容完成', '⚠️ 搜索内容未完成'])
  assert.equal(f.cursor, 3)
})

test('抓取网页提示使用中文名称，并跳过已投递的旧回执', async () => {
  const f = deliveryFixture([
    event(1, 'tool_done', { name: 'http_get', status: 'success' }),
    event(2, 'tool_done', { name: 'http_get', status: 'success' }),
  ])
  f.receipts.set('tool-notice:1', { fingerprint: digest('✅ http_get完成'), state: 'accepted' })
  const notices: string[] = []
  const recovery = createImRunDeliveryRecovery({
    ...f.ports,
    sender: { ...f.ports.sender, async toolNotice({ text }) { notices.push(text); return 'accepted' } },
  })
  await recovery.recover(identity)
  assert.deepEqual(notices, ['✅ 抓取网页完成'])
  assert.equal(f.cursor, 2)
})

test('工具完成提示在文本流边界后发送，失败或恢复不影响最终正文', async () => {
  const events = [
    event(1, 'tool_call', { name: 'get_current_time', input: '私有参数' }),
    event(2, 'tool_done', { name: 'get_current_time', status: 'success', result: '私有结果' }),
    event(3, 'tool_done', { name: 'choose_no_reply', status: 'success' }),
    event(4, 'final', { status: 'completed', text: '最终正文' }),
  ]
  const f = deliveryFixture(events)
  const messages: string[] = []
  const recovery = createImRunDeliveryRecovery({
    ...f.ports,
    stream: { async project({ event }) { messages.push(event.type); return 'accepted' } },
    sender: { ...f.ports.sender, async toolNotice({ text }) { messages.push(text); return 'unknown' } },
  })
  await recovery.recover(identity)
  await recovery.recover(identity)
  assert.deepEqual(messages, ['tool_call', 'tool_done', '✅ 获取当前时间完成', 'tool_done', 'final'])
  assert.equal(f.cursor, 4)
  assert.equal(f.receipts.get('tool-notice:2')?.state, 'unknown')
})

test('关闭中间回复时，实时和恢复投递仅发送最终正文及必要交互', async () => {
  const events = [
    event(1, 'round_end', { text: '中间正文' }),
    event(2, 'interaction_required', { interactionId: 'prompt', kind: 'question', toolCallId: 'call' }),
    event(3, 'round_end', { text: '最终正文' }, 2),
    event(4, 'final', { status: 'completed', text: '最终正文' }, 2),
  ]
  for (const recovery of [false, true]) {
    const f = deliveryFixture(events)
    const ports = { ...f.ports, showIntermediateReplies: false }
    if (recovery) await createImRunDeliveryRecovery(ports).recover(identity)
    else await createImRunDelivery(ports).start(identity)
    assert.deepEqual(f.sent.map(({ kind }) => kind), ['interaction', 'text'])
    assert.equal(f.sent[1]?.value, '最终正文')
    assert.equal(f.cursor, 4)
  }
})

test('accepted携带证据同settle交Host，真实final仅提升相同正文且不重复发送', async () => {
  const f = deliveryFixture([event(1,'round_end',{text:'已送正文'}),event(2,'final',{text:'已送正文',status:'completed'})])
  const evidence = {v:1,platformMessageIds:['native-synthetic']}
  const settled: unknown[] = [], confirmed: unknown[] = []
  const original = f.ports.receipts.settle
  f.ports.sender.text = async input => { f.sent.push({kind:'text',value:input.text,deliveryId:input.deliveryId}); return {outcome:'accepted',evidence} }
  f.ports.receipts.settle = async (...args) => { settled.push(args); await original(...args) }
  f.ports.receipts.confirmFinal = async (...args) => { confirmed.push(args) }
  await createImRunDelivery(f.ports).start(identity)
  assert.equal(f.sent.length,1)
  assert.deepEqual(settled,[[identity,'round:1:text','accepted',evidence,{eventType:'round_end',sequence:1,final:false}]])
  assert.deepEqual(confirmed,[[identity,'round:1:text',digest('已送正文'),{eventType:'final',sequence:2,final:true}]])
  await createImRunDelivery(f.ports).recover(identity)
  assert.equal(f.sent.length,1)
  assert.equal(confirmed.length,1)
})

test('非法证据按unknown冻结，投递持久化失败不推进游标或恢复重发', async () => {
  const f = deliveryFixture([event(1,'final',{text:'正文',status:'completed'})])
  f.ports.sender.text = async () => ({outcome:'accepted',evidence:{invalid:undefined} as never})
  await assert.rejects(createImRunDelivery(f.ports).start(identity),ImRunDeliveryBlocked)
  assert.equal(f.receipts.get('round:1:text')!.state,'unknown')
  assert.equal(f.cursor,0)
  const g = deliveryFixture([event(1,'final',{text:'正文',status:'completed'})])
  g.ports.receipts.settle = async () => { throw new Error('合成提交故障') }
  await assert.rejects(createImRunDelivery(g.ports).start(identity),/合成提交故障/u)
  assert.equal(g.receipts.get('round:1:text')!.state,'pending')
  await assert.rejects(createImRunDelivery(g.ports).recover(identity),ImRunDeliveryBlocked)
  assert.equal(g.sent.length,1)
})

test('流式空正文的静默completed仅为控制终态，不登记final回复事实', async () => {
  const f=deliveryFixture([event(1,'final',{status:'completed',text:''})]),settled:unknown[]=[]
  const original=f.ports.receipts.settle
  f.ports.receipts.settle=async(...args)=>{settled.push(args[4]);await original(...args)}
  await createImRunDelivery({...f.ports,stream:{async project(){return 'accepted'}}}).start(identity)
  assert.deepEqual(settled,[{eventType:'final',sequence:1,final:false}])
  assert.equal(f.sent.length,0)
})

test('平台流投影独占正文且与交互/附件共用串行收据，recover不启动Runner或重发', async () => {
  const events = [event(1, 'token', { text: '正文' }), event(2, 'round_end', { text: '正文' }),
    event(3, 'interaction_required', { interactionId: 'prompt', kind: 'question', toolCallId: 'call', input: '不应透传的字段' }),
    event(4, 'interaction_resolved', { interactionId: 'prompt', status: 'answered', value: '不得进入平台流的凭据或回答' }),
    event(5, 'tool_done', { toolCallId: 'call', status: 'success' }), event(6, 'run_resumed'), event(7, 'final', { text: '正文', status: 'completed' })]
  const f = deliveryFixture(events), projected: RunEvent[] = []
  const ports: ImRunDeliveryPorts<unknown> = { ...f.ports, stream: { async project(input) { projected.push(input.event); return 'accepted' } } }
  const delivery = createImRunDelivery(ports)
  await delivery.start(identity)
  assert.equal(f.starts, 1)
  assert.equal(projected.length, 7)
  assert.deepEqual(projected[2]!.payload, { interactionId: 'prompt', kind: 'question', toolCallId: 'call' })
  assert.deepEqual(projected[3]!.payload, { interactionId: 'prompt', status: 'answered' })
  assert.deepEqual(f.sent.map(value => value.kind), ['interaction'])
  await delivery.recover(identity)
  assert.equal(f.starts, 1)
  assert.equal(projected.length, 7)
})

test('子 Agent 派单保留 QQ 正文收尾信号，工具正文和状态提示不外发', async () => {
  const f = deliveryFixture([event(1, 'round_end', { text: '我重新派一个任务。' }),
    event(2, 'tool_call', { name: 'agent_message', toolCallId: 'private-call' }),
    event(3, 'tool_done', { name: 'agent_message', status: 'success', result: '内部结果' })])
  const projected: RunEvent[] = []
  await createImRunDelivery({ ...f.ports, stream: { async project({ event }) {
    projected.push(event)
    return 'accepted'
  } }, sender: { ...f.ports.sender, async toolNotice() {
    assert.fail('内部工具状态不应外发')
  } } }).start(identity)
  assert.deepEqual(projected.map(({ type, payload }) => ({ type, payload })), [
    { type: 'round_end', payload: { text: '我重新派一个任务。' } },
    { type: 'tool_call', payload: {} },
  ])
})

test('流式操作unknown仍排空业务事件，pending恢复不重复调用流端口', async () => {
  const f = deliveryFixture([event(1, 'token', { text: '正文' }), event(2, 'final', { text: '正文', status: 'completed' })])
  let calls = 0
  const ports: ImRunDeliveryPorts<unknown> = { ...f.ports, stream: { async project() { calls++; return 'unknown' } } }
  const delivery = createImRunDelivery(ports)
  await assert.rejects(delivery.start(identity), ImRunDeliveryBlocked)
  assert.equal(f.drained, true)
  await assert.rejects(delivery.recover(identity), ImRunDeliveryBlocked)
  assert.equal(calls, 1)
  assert.equal(f.starts, 1)
  assert.deepEqual(f.sent, [])
})

test('非法交互身份在流卡关闭等平台动作前拒绝', async () => {
  const f = deliveryFixture([event(1, 'interaction_required', { interactionId: 'prompt', kind: 'credential' })])
  let calls = 0
  const ports: ImRunDeliveryPorts<unknown> = { ...f.ports, stream: { async project() { calls++; return 'accepted' } } }
  await assert.rejects(createImRunDelivery(ports).start(identity))
  assert.equal(calls, 0)
})

test('真实Harness产生的token/工具/终态只经单一流投影消费，恢复不再执行Provider', async () => {
  const runner = fixture(), observed: RunEvent[] = [], f = deliveryFixture(observed), projected: string[] = []
  const ports: ImRunDeliveryPorts<unknown> = { ...f.ports,
    runner: { start: (async function* (id, options) {
      const iterator = runner.harness.start(id, options)
      while (true) { const item = await iterator.next(); if (item.done) return item.value; observed.push(item.value); yield item.value }
    }) as ImRunDeliveryPorts<unknown>['runner']['start'] },
    stream: { async project(input) { projected.push(input.event.type); return 'accepted' } },
  }
  const delivery = createImRunDelivery(ports)
  await delivery.start(identity)
  assert.ok(projected.includes('token')); assert.ok(projected.includes('final'))
  assert.deepEqual(f.sent, [])
  const before = observed.length, sends = projected.length
  await delivery.recover(identity)
  assert.equal(observed.length, before); assert.equal(projected.length, sends)
})

test('外部调度选择的resume事件直接投递，不另起Run；平台失败排空后仍保留Runner原错误', async () => {
  const events = [event(1, 'round_end', { text: '恢复中的回复' }), event(2, 'final', { status: 'completed', text: '恢复中的回复' })]
  const f = deliveryFixture(events)
  await createImRunDelivery(f.ports).consume(identity, (async function* () { yield* events })())
  assert.equal(f.starts, 0)
  assert.equal(f.cursor, 2)
  assert.deepEqual(f.sent.map(value => value.value), ['恢复中的回复'])
  const failing = deliveryFixture(events)
  failing.setOutcome('unknown')
  const original = new Error('合成Runner故障')
  let continued = false
  await assert.rejects(createImRunDelivery(failing.ports).consume(identity, (async function* () {
    yield events[0]!
    continued = true
    throw original
  })()), error => error === original)
  assert.equal(continued, true)
  assert.equal(failing.starts, 0)
  assert.equal(failing.receipts.size, 1)
})

test('真实Runner经Provider替身产生持久事件，正文只发一次，恢复不重新请求模型', async () => {
  const runner = fixture()
  const observed: RunEvent[] = []
  const f = deliveryFixture(observed)
  const harness = runner.harness
  f.ports.runner.start = async function* (id, options) {
    const iterator = harness.start(id, options)
    while (true) {
      const item = await iterator.next()
      if (item.done) return item.value
      observed.push(item.value)
      yield item.value
    }
  }
  const delivery = createImRunDelivery(f.ports)
  await delivery.start(identity)
  assert.deepEqual(f.sent.map(item => item.value), ['合成回复'])
  assert.equal(runner.histories.length, 1)
  assert.equal(observed.at(-1)?.type, 'final')
  const requests = vi.mocked(runner.ports.provider.stream).mock.calls.length
  await delivery.recover(identity)
  assert.equal(vi.mocked(runner.ports.provider.stream).mock.calls.length, requests)
  assert.equal(f.sent.length, 1)
})

test('多轮正文、文件与终态累计附件逐项去重，不发送token和内部诊断', async () => {
  const artifact = { type: 'attachment_ref', attach_id: 'synthetic-attachment' }
  const f = deliveryFixture([
    event(1, 'token', { text: '预览' }), event(2, 'round_end', { text: '第一轮' }),
    event(3, 'tool_done', { artifact, result: { private: '不应发送' } }),
    event(4, 'provider_diagnostic', { private: '不应发送' }), event(5, 'round_end', { text: '第二轮' }, 2),
    event(6, 'final', { status: 'completed', text: '第二轮', files: [artifact] }, 2),
  ])
  const delivery = createImRunDelivery(f.ports)
  await delivery.start(identity)
  assert.deepEqual(f.sent.map(item => item.kind), ['text', 'artifact', 'text'])
  assert.deepEqual(f.sent.filter(item => item.kind === 'text').map(item => item.value), ['第一轮', '第二轮'])
  await delivery.recover(identity)
  assert.equal(f.sent.length, 3)
})

test('发送被拒绝仍驱动Runner完成，恢复仅补未完成投递', async () => {
  const f = deliveryFixture([event(1, 'round_end', { text: '答复' }), event(2, 'final', { status: 'completed', text: '答复' })])
  f.setOutcome('rejected')
  const delivery = createImRunDelivery(f.ports)
  await assert.rejects(delivery.start(identity), error => error instanceof ImRunDeliveryBlocked && error.reason === 'rejected')
  assert.equal(f.drained, true)
  assert.equal(f.cursor, 0)
  f.setOutcome('accepted')
  await delivery.recover(identity)
  assert.equal(f.starts, 1)
  assert.equal(f.sent.length, 2)
  assert.equal(f.cursor, 2)
})

test('网络结果不明及崩溃遗留pending均不自动重发', async () => {
  for (const pending of [false, true]) {
    const f = deliveryFixture([event(1, 'round_end', { text: '答复' })])
    if (pending) f.receipts.set('round:1:text', { fingerprint: digest('答复'), state: 'pending' })
    else f.ports.sender.text = async () => { throw new Error('含敏感上游响应') }
    const delivery = createImRunDelivery(f.ports)
    await assert.rejects(delivery.start(identity), error => error instanceof ImRunDeliveryBlocked && !error.message.includes('敏感'))
    await assert.rejects(delivery.recover(identity), ImRunDeliveryBlocked)
    assert.equal(f.sent.length, 0)
    assert.equal(f.cursor, 0)
  }
})

test('每条投递重新复核权限，撤权后的消息保留且不停止真实业务', async () => {
  const f = deliveryFixture([event(1, 'round_end', { text: '第一轮' }), event(2, 'round_end', { text: '第二轮' }, 2)])
  const send = f.ports.sender.text
  f.ports.sender.text = async input => { const result = await send(input); f.setAuthorized(false); return result }
  await assert.rejects(createImRunDelivery(f.ports).start(identity), error => error instanceof ImRunDeliveryBlocked && error.reason === 'unauthorized')
  assert.deepEqual(f.sent.map(item => item.value), ['第一轮'])
  assert.equal(f.cursor, 1)
  assert.equal(f.drained, true)
})

test('事件身份和连续序列异常拒绝投递，重复已消费事件无副作用', async () => {
  const identities: RunIdentity[] = [{ ...identity, ownerId: 'other' }, { ...identity, sessionId: 'other' }, { ...identity, runId: 'other' }]
  for (const other of identities) {
    const f = deliveryFixture([{ ...event(1, 'round_end', { text: '答复' }), identity: other }])
    await assert.rejects(createImRunDelivery(f.ports).start(identity), /身份不匹配/)
    assert.equal(f.sent.length, 0)
  }
  const gap = deliveryFixture([event(2, 'round_end', { text: '答复' })])
  await assert.rejects(createImRunDelivery(gap.ports).recover(identity), /序列缺失/)
  const duplicate = event(1, 'round_end', { text: '答复' })
  const f = deliveryFixture([duplicate, duplicate, event(2, 'final', { status: 'completed', text: '答复' })])
  await createImRunDelivery(f.ports).start(identity)
  assert.equal(f.sent.length, 1)
})

test('投递停止信号不关闭Runner，Runner错误不被投递错误吞掉', async () => {
  const f = deliveryFixture([event(1, 'round_end', { text: '答复' })])
  const controller = new AbortController(); controller.abort()
  await assert.rejects(createImRunDelivery(f.ports).start(identity, undefined, controller.signal), ImRunDeliveryBlocked)
  assert.equal(f.drained, true)
  assert.equal(f.sent.length, 0)
  const failure = new Error('运行存储失败')
  f.ports.runner.start = async function* () { yield event(1, 'round_end', { text: '答复' }); throw failure }
  f.setOutcome('rejected')
  await assert.rejects(createImRunDelivery(f.ports).start(identity), error => error === failure)
})

test('交互仅向可信sender提供标识，失败终态展示安全正文，取消不追加回复', async () => {
  const f = deliveryFixture([
    event(1, 'interaction_required', { interactionId: 'prompt-1', kind: 'confirmation', toolCallId: 'tool-1', secret: '不应透传' }),
    event(2, 'final', { status: 'failed', text: '服务暂不可用' }),
  ])
  await createImRunDelivery(f.ports).start(identity)
  assert.deepEqual(f.sent.map(item => item.value), [{ interactionId: 'prompt-1', kind: 'confirmation', toolCallId: 'tool-1' }, '服务暂不可用'])
  const cancelled = deliveryFixture([event(1, 'final', { status: 'cancelled', text: '不应发送',
    files: [{ type: 'attachment_ref', attach_id: 'cancelled-file' }] })])
  await createImRunDelivery(cancelled.ports).start(identity)
  assert.equal(cancelled.sent.length, 0)
})

test('outbox恢复连续读取生产256条分页，单次recover不能漏掉后页最终回复', async () => {
  const events = Array.from({ length: 259 }, (_, index) => event(index + 1, 'token', { text: '合成增量' }))
  events.push(event(260, 'final', { status: 'completed', text: '分页后的最终回复' }))
  const f = deliveryFixture(events)
  f.ports.events.readAfter = async (_identity, after) => events.filter(value => value.sequence > after).slice(0, 256)
  await createImRunDelivery(f.ports).recover(identity)
  assert.equal(f.cursor, 260)
  assert.deepEqual(f.sent.map(value => value.value), ['分页后的最终回复'])
  assert.equal(f.starts, 0)
})

test('恢复端口重复返回旧页时明确失败，不陷入死循环或重复回复', async () => {
  const page = [event(1, 'round_end', { text: '合成回复' })]
  const f = deliveryFixture(page)
  f.ports.events.readAfter = async () => page
  await assert.rejects(createImRunDelivery(f.ports).recover(identity), /游标未前进/)
  assert.equal(f.sent.length, 1)
})

test('制品只允许稳定授权引用，临时URL和错误列表不能混入投递', async () => {
  for (const artifact of [{ url: 'https://example.invalid/private?token=synthetic' }, { type: 'attachment_ref', attach_id: 'synthetic', localPath: '/private/file' }]) {
    const f = deliveryFixture([event(1, 'tool_done', { artifact })])
    await assert.rejects(createImRunDelivery(f.ports).recover(identity))
    assert.equal(f.sent.length, 0)
  }
  const f = deliveryFixture([event(1, 'final', { status: 'completed', text: '', files: '损坏列表' })])
  await assert.rejects(createImRunDelivery(f.ports).recover(identity), /制品列表无效/)
  assert.equal(f.cursor, 0)
})

test('发送成功后游标保存失败，重启通过已受理收据跳过重复发送', async () => {
  const f = deliveryFixture([event(1, 'round_end', { text: '答复' })])
  const advance = f.ports.receipts.advance
  f.ports.receipts.advance = async () => { throw new Error('游标事务失败') }
  const delivery = createImRunDelivery(f.ports)
  await assert.rejects(delivery.start(identity), /游标事务失败/)
  assert.equal(f.sent.length, 1)
  f.ports.receipts.advance = advance
  await delivery.recover(identity)
  assert.equal(f.sent.length, 1)
  assert.equal(f.cursor, 1)
})

test('上下文压缩提示按状态单独投递，关闭展示后无提示，恢复时不重复发送', async () => {
  const events = [
    event(1, 'compaction', { phase: 'started' }),
    event(2, 'compaction', { phase: 'completed', applied: false }),
    event(3, 'compaction', { phase: 'started' }),
    event(4, 'compaction', { phase: 'completed', applied: true }),
    event(5, 'final', { status: 'completed', text: '合成结果' }),
  ]
  const enabled = deliveryFixture(events)
  const notices: string[] = []
  enabled.ports.sender.compactionNotice = async ({ text }) => { notices.push(text); return 'accepted' }
  const delivery = createImRunDelivery(enabled.ports)
  await delivery.consume(identity, (async function* () { yield* events })())
  await delivery.consume(identity, (async function* () { yield* events })())
  assert.deepEqual(notices, ['上下文较长，正在整理后继续处理。', '本次未能整理上下文，继续处理。',
    '上下文较长，正在整理后继续处理。', '上下文整理完成。'])
  assert.deepEqual(enabled.sent.map(item => item.value), ['合成结果'])
  const disabled = deliveryFixture(events)
  await createImRunDelivery(disabled.ports).consume(identity, (async function* () { yield* events })())
  assert.deepEqual(disabled.sent.map(item => item.value), ['合成结果'])
})
