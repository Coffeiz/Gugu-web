import { describe,expect,it,vi } from 'vitest'
import type {
HarnessPorts,
ToolPort,
ToolResult
} from "../../../../src/agent/harness/index.js"
import { createRunHarness,HarnessError } from "../../../../src/agent/harness/index.js"
import type { Context } from '../run/fixtures.js'
import { collect,deferred,fixture,identity,toolCall } from '../run/fixtures.js'

describe('Harness 交互等待、消费与恢复', () => {
  it('普通问题回答结束等待并将答案交给上下文，tool_done不泄漏回答也不重派问题工具', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '已收到补充信息', calls: [] }]])
    f.ports.tools.dispatch = vi.fn(async () => ({ kind: 'waiting', interaction: { id: 'question-1', kind: 'question', toolCall } }) as ToolResult)
    const waiting = await collect(f.harness.start(identity))
    const resumed = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'question-1', receiptId: 'answer-1', status: 'answered', value: '合成私有回答' }))
    const tools = [...waiting.events, ...resumed.events].filter(event => event.type === 'tool_done')
    expect(tools.map(event => event.payload.status)).toEqual(['waiting', 'success'])
    expect(JSON.stringify(tools)).not.toContain('合成私有回答')
    expect(f.ports.context.resumeInteraction).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ value: '合成私有回答' }))
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(resumed.state.status).toBe('completed')
  })
  it('waiting检查点重启后以原工具参数确认续接，收据与checkpoint一起消费', async () => {
    const f = fixture([[{ type: 'complete', text: '需要确认', calls: [toolCall] }], [{ type: 'complete', text: '已经完成', calls: [] }]])
    const waiting: ToolResult = { kind: 'waiting', interaction: { id: 'prompt-synthetic', kind: 'confirmation', toolCall } }
    let attempts = 0
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ++attempts === 1 ? waiting : { kind: 'completed', value: '完成', successful: true, mutated: true })
    expect((await collect(f.harness.start(identity))).state.status).toBe('waiting')
    const version = f.records.get(f.idKey(identity))!.version
    await expect(collect(createRunHarness(f.ports).resume(identity, { interactionId: 'other-prompt', receiptId: 'receipt-synthetic', status: 'confirmed', value: null }))).rejects.toMatchObject({ code: 'conflict' })
    expect(f.records.get(f.idKey(identity))!.version).toBe(version)
    const resolution = { interactionId: 'prompt-synthetic', receiptId: 'receipt-synthetic', status: 'confirmed' as const, value: null }
    const result = await collect(createRunHarness(f.ports).resume(identity, resolution))
    expect(result.state.status).toBe('completed')
    expect(f.ports.tools.dispatch).toHaveBeenLastCalledWith(toolCall, expect.objectContaining({ resolution }))
    expect(f.receipts.has('receipt-synthetic')).toBe(true)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
    await expect(collect(f.harness.resume({ ...identity, ownerId: 'other-owner' }, resolution))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('用户取消确认先关工具气泡再另起收尾轮次，正常持久化且不再调用模型', async () => {
    const f = fixture([[{ type: 'complete', text: '先说明', calls: [toolCall] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'waiting', interaction: { id: 'prompt-synthetic', kind: 'confirmation', toolCall } }))
    await collect(f.harness.start(identity))
    const { state, events } = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'prompt-synthetic', receiptId: 'receipt-cancel', status: 'cancelled', value: null }))
    expect(state.status).toBe('completed')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual(['interaction_resolved', 'tool_done', 'round_start', 'token', 'round_end', 'final'])
    expect(events.find((event) => event.type === 'tool_done')?.payload.status).toBe('cancelled')
    expect(f.histories.at(-1)?.outcome).toBe('success')
  })

  it('Provider复用可变调用对象不能漂移已接受的工具参数或确认现场', async () => {
    const supplied = { id: 'call-mutable', name: 'lookup', input: { query: '原始合成参数', nested: { enabled: true } } }
    const f = fixture([[{ type: 'complete', text: '', calls: [supplied] }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.context.afterRound = vi.fn<HarnessPorts<Context>['context']['afterRound']>(async (context, result) => {
      supplied.input.query = '异步修改后的参数'
      supplied.input.nested.enabled = false
      supplied.name = 'other_tool'
      return [...context, `assistant:${result.text}`]
    })
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(f.ports.tools.dispatch).toHaveBeenCalledWith({ id: 'call-mutable', name: 'lookup', input: { query: '原始合成参数', nested: { enabled: true } } }, expect.anything())
  })

  it('确认端口不能用相同id/name替换原工具参数，拒绝时不再调用工具', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'waiting', interaction: { id: 'prompt-drift', kind: 'confirmation', toolCall: { ...toolCall, input: { query: '被替换的合成参数' } } } }))
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('failed')
    expect(result.state.pending).toBeNull()
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
  })

  it('确认后要求凭据进入同工具的第二个等待门，答案只进入Canonical端口不进入展示事件', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    let attempts = 0
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'waiting', interaction: { id: ++attempts === 1 ? 'confirm-synthetic' : 'credential-synthetic', kind: attempts === 1 ? 'confirmation' : 'credential', toolCall } }))
    await collect(f.harness.start(identity))
    const confirmed = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'confirm-synthetic', receiptId: 'confirm-receipt', status: 'confirmed', value: null }))
    expect(confirmed.state.pending).toMatchObject({ id: 'credential-synthetic', kind: 'credential', afterConfirmation: true })
    const answered = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'credential-synthetic', receiptId: 'credential-receipt', status: 'answered', value: { api_key: 'synthetic-private-answer' } }))
    expect(answered.state.status).toBe('completed')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(answered.events)).not.toContain('synthetic-private-answer')
    expect(f.ports.context.resumeInteraction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ id: 'credential-synthetic' }), expect.objectContaining({ value: { status: 'completed' } }))
    expect(JSON.stringify([...f.records.values()])).not.toContain('synthetic-private-answer')
    expect(JSON.stringify([...f.outbox.values()])).not.toContain('synthetic-private-answer')
    expect(JSON.stringify(f.histories)).not.toContain('synthetic-private-answer')
    expect(JSON.stringify(vi.mocked(f.ports.store.commit).mock.calls)).not.toContain('synthetic-private-answer')
  })

  it('确认后的凭据取消属于中断，不补普通确认取消的成功收尾', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    let attempts = 0
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'waiting', interaction: { id: ++attempts === 1 ? 'confirm-synthetic' : 'credential-synthetic', kind: attempts === 1 ? 'confirmation' : 'credential', toolCall } }))
    await collect(f.harness.start(identity))
    await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'confirm-synthetic', receiptId: 'confirm-receipt', status: 'confirmed', value: null }))
    const result = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'credential-synthetic', receiptId: 'credential-receipt', status: 'cancelled', value: null }))
    expect(result.state.status).toBe('cancelled')
    expect(result.events.filter((event) => event.type === 'token')).toEqual([])
    expect(f.histories.every((history) => history.outcome !== 'success')).toBe(true)
  })

  it('确认后重复授权阻断不能无限重复弹窗，回写失败工具结果后由模型收束', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '确认未生效', calls: [] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'waiting', interaction: { id: 'confirm-synthetic', kind: 'confirmation', toolCall } }))
    await collect(f.harness.start(identity))
    const result = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'confirm-synthetic', receiptId: 'confirm-receipt', status: 'confirmed', value: null }))
    expect(result.state.status).toBe('completed')
    expect(result.events.filter((event) => event.type === 'interaction_required')).toEqual([])
    expect(result.events.find((event) => event.type === 'tool_done')?.payload.status).toBe('error')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(2)
  })

  it('mixed批次普通工具先真实并发，确认项串行且其后serial延后，Canon/终态按model序', async () => {
    const calls = ['confirm-a', 'read-b', 'confirm-c', 'read-d'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '全部收束', calls: [] }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 2, serialCallIds: ['confirm-a', 'confirm-c'] }))
    let readStarted = 0
    let active = 0
    let peak = 0
    const reads = deferred<void>()
    const dispatched: string[] = []
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call, scope) => {
      dispatched.push(call.id)
      if (call.id.startsWith('read')) {
        active++; peak = Math.max(peak, active)
        if (++readStarted === 2) reads.resolve()
        await reads.promise
        active--
        return { kind: 'completed', value: `实际回执:${call.id}`, successful: true, mutated: false }
      }
      if (scope.resolution) return { kind: 'completed', value: '确认执行完成', successful: true, mutated: true }
      return { kind: 'waiting', interaction: { id: `intent-${call.id}`, kind: 'confirmation', toolCall: call } }
    })
    const first = await collect(f.harness.start(identity))
    expect(first.state.status).toBe('waiting')
    expect(peak).toBe(2)
    expect(dispatched).toEqual(['read-b', 'read-d', 'confirm-a'])
    expect(first.state.toolResults).toHaveLength(4)
    expect(first.events.filter((event) => event.type === 'tool_done').map((event) => event.payload.toolCallId)).toEqual(['confirm-a', 'read-b', 'confirm-c', 'read-d'])
    expect(first.events.find((event) => event.type === 'tool_done' && event.payload.toolCallId === 'confirm-c')?.payload.status).toBe('deferred')
    const resumed = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-confirm-a', receiptId: 'receipt-confirm-a', status: 'confirmed', value: null }))
    expect(resumed.state.status).toBe('completed')
    expect(dispatched).toEqual(['read-b', 'read-d', 'confirm-a', 'confirm-a'])
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
  })

  it('取消首个等待门关闭未展示的后续交互，已完成siblings保留且后续门不被激活', async () => {
    const calls = ['ask-a', 'read-b', 'ask-c'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 3 }))
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => call.id.startsWith('ask') ? { kind: 'waiting', interaction: { id: `intent-${call.id}`, kind: 'question', toolCall: call } } : { kind: 'completed', value: '已完成兄弟回执', successful: true, mutated: true })
    await collect(f.harness.start(identity))
    const result = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-ask-a', receiptId: 'receipt-cancel-a', status: 'cancelled', value: null }))
    expect(result.state.status).toBe('completed')
    expect(result.state.queuedInteractions).toEqual([])
    expect(f.ports.interactions.activate).toHaveBeenCalledTimes(1)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(3)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(result.events.filter((event) => event.type === 'tool_done').map((event) => event.payload.toolCallId)).toEqual(['ask-a', 'ask-c'])
    expect(f.histories.at(-1)?.context).toContain('tool:read-b:completed')
  })

  it('并行工具返回等待同时兄弟取消时仍保留成功回执，不激活过时交互也不丢Canon结果', async () => {
    const calls = ['ask-a', 'done-b', 'cancel-c'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 3 }))
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => {
      if (call.id === 'ask-a') return { kind: 'waiting', interaction: { id: 'intent-a', kind: 'question', toolCall: call } }
      if (call.id === 'done-b') return { kind: 'completed', value: '已完成真实回执', successful: true, mutated: true }
      throw new HarnessError('cancelled', '合成共享取消')
    })
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('cancelled')
    expect(result.state.completedToolCount).toBe(1)
    expect(f.ports.interactions.activate).not.toHaveBeenCalled()
    expect(f.histories.at(-1)?.context).toContain('tool:done-b:completed')
  })

  it('同批多个确认逐个激活且每个只重投自己的原调用，不在中间请求下一轮模型', async () => {
    const calls = ['confirm-a', 'confirm-b'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 2 }))
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call, scope) => scope.resolution ? { kind: 'completed', value: '确认已执行', successful: true, mutated: true } : { kind: 'waiting', interaction: { id: `intent-${call.id}`, kind: 'confirmation', toolCall: call } })
    await collect(f.harness.start(identity))
    const second = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-confirm-a', receiptId: 'receipt-confirm-a', status: 'confirmed', value: null }))
    expect(second.state.pending?.id).toBe('intent-confirm-b')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.ports.tools.dispatch).mock.calls.map(([call]) => call.id)).toEqual(['confirm-a', 'confirm-b', 'confirm-a'])
    const final = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-confirm-b', receiptId: 'receipt-confirm-b', status: 'confirmed', value: null }))
    expect(final.state.status).toBe('completed')
    expect(vi.mocked(f.ports.tools.dispatch).mock.calls.map(([call]) => call.id)).toEqual(['confirm-a', 'confirm-b', 'confirm-a', 'confirm-b'])
    expect(f.ports.interactions.activate).toHaveBeenCalledTimes(2)
  })

  it('首个串行工具或确认重投结果未知时立即停止，不启动剩余工具或已排队交互', async () => {
    const calls = ['first-call', 'next-call'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'unknown' }))
    expect((await collect(f.harness.start(identity))).state.status).toBe('unknown')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    const confirmation = fixture([[{ type: 'complete', text: '', calls }]])
    confirmation.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 2 }))
    confirmation.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call, scope) => scope.resolution ? { kind: 'unknown' } : { kind: 'waiting', interaction: { id: `intent-${call.id}`, kind: 'confirmation', toolCall: call } })
    await collect(confirmation.harness.start(identity))
    expect((await collect(createRunHarness(confirmation.ports).resume(identity, { interactionId: 'intent-first-call', receiptId: 'receipt-first', status: 'confirmed', value: null }))).state.status).toBe('unknown')
    expect(confirmation.ports.interactions.activate).toHaveBeenCalledTimes(1)
  })

  it('确认实际执行回执已提交但提交响应丢失，重启使用cached receipt而不重复授权操作', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call, scope) => scope.resolution ? { kind: 'completed', value: '真实执行完成', successful: true, mutated: true } : { kind: 'waiting', interaction: { id: 'intent-confirm', kind: 'confirmation', toolCall: call } })
    await collect(f.harness.start(identity))
    const original = f.ports.store.commit
    let interrupted = false
    f.ports.store.commit = vi.fn(async (change) => {
      await original(change)
      if (change.checkpoint.replayResultReady && !interrupted) { interrupted = true; throw new Error('合成提交响应丢失') }
    })
    await expect(collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-confirm', receiptId: 'receipt-confirm', status: 'confirmed', value: null }))).rejects.toMatchObject({ code: 'persistence_unknown' })
    expect(f.records.get(f.idKey(identity))!.replayResultReady).toBe(true)
    f.ports.store.commit = original
    const result = await collect(createRunHarness(f.ports).resume(identity))
    expect(result.state.status).toBe('completed')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(2)
    expect(f.ports.tools.reconcile).not.toHaveBeenCalled()
  })

  it.each(['question', 'confirmation'] as const)('交互卡显示前flush完整同轮解释，恢复后不重复前置说明：%s', async kind => {
    const f = fixture([[{ type: 'token', text: '前置说明' }, { type: 'complete', text: '前置说明', calls: [toolCall] }], [{ type: 'token', text: '回答后收束' }, { type: 'complete', text: '回答后收束', calls: [] }]])
    f.ports.createStreamSanitizer = () => {
      let buffered = ''
      return { feed(text) { const current = buffered + text; buffered = current.slice(-1); return current.slice(0, -1) }, flush() { const tail = buffered; buffered = ''; return tail } }
    }
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call, scope) => scope.resolution
      ? { kind: 'completed', value: '已确认执行', successful: true, mutated: true }
      : { kind: 'waiting', interaction: { id: 'intent-question', kind, toolCall: call } })
    f.ports.interactions.activate = vi.fn(async (_identity, request) => {
      expect(f.order.indexOf('publish:round_end')).toBeGreaterThan(f.order.indexOf('publish:token'))
      return request
    })
    const first = await collect(f.harness.start(identity))
    expect(first.events.filter((event) => event.type === 'token').map((event) => event.payload.text).join('')).toBe('前置说明')
    expect(first.events.findIndex((event) => event.type === 'round_end')).toBeLessThan(first.events.findIndex((event) => event.type === 'interaction_required'))
    const resumed = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-question', receiptId: 'receipt-question', status: kind === 'question' ? 'answered' : 'confirmed', value: '合成回答' }))
    expect(resumed.events.filter((event) => event.type === 'token').map((event) => event.payload.text).join('')).toBe('回答后收束')
    expect(resumed.state.roundTexts).toEqual(['前置说明', '回答后收束'])
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(kind === 'question' ? 1 : 2)
  })
})
