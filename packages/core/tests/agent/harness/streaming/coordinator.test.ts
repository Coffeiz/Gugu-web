import { describe,expect,it,vi } from 'vitest'
import type {
ProviderEvent,
RunEvent,
ToolPort
} from "../../../../src/agent/harness/index.js"
import { createRunHarness } from "../../../../src/agent/harness/index.js"
import { collect,deferred,fixture,identity,replyFacts,stream,toolCall,usage } from '../run/fixtures.js'

describe('Harness 流式协调、背压与事件顺序', () => {
  it('取消打断无token的模型等待，只订阅一次，并先写durable标记后通知', async () => {
    const f = fixture()
    const started = deferred<void>()
    f.ports.provider.stream = vi.fn(({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        started.resolve()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    }))
    const task = collect(f.harness.start(identity))
    await started.promise
    expect(await f.harness.cancel({ ...identity, runId: 'other-run' })).toBe(false)
    expect(await f.harness.cancel(identity)).toBe(true)
    const result = await task
    expect(result.state.status).toBe('cancelled')
    expect(result.events.at(-1)?.payload.text).toBe('')
    expect(f.order.filter((item) => item.startsWith('cancel_'))).toEqual(['cancel_marker', 'cancel_notify'])
    expect(f.ports.cancellation.subscribe).toHaveBeenCalledTimes(1)
    expect(f.histories).toEqual([])
  })

  it('流式消费自然背压，不拉取下一token直到消费者再次推进', async () => {
    const f = fixture()
    const next = vi.fn()
    f.ports.provider.stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        next()
        yield { type: 'token', text: '第一段' } as const
        next()
        yield { type: 'complete', text: '最终正文', calls: [] } as const
      }
    }))
    const source = f.harness.start(identity)
    let event = await source.next()
    while (!event.done && event.value.type !== 'token') event = await source.next()
    expect(next).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(next).toHaveBeenCalledTimes(1)
    await collect(source)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('模型请求途中重启没有明确recover适配器时不重发请求', async () => {
    const f = fixture()
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'round_start') break
    }
    await source.return(undefined as never)
    const result = await collect(createRunHarness(f.ports).resume(identity))
    expect(result.state.status).toBe('unknown')
    expect(result.state.remoteStatusUnknown).toBe(true)
    expect(f.ports.provider.stream).not.toHaveBeenCalled()
  })

  it('provider overlow仅显式压缩成功才重试，第二次溢出停止', async () => {
    const f = fixture([[{ type: 'error', error: new Error('合成overflow'), contextOverflow: true }], [{ type: 'error', error: new Error('合成overflow'), contextOverflow: true }]])
    f.ports.context.recoverOverflow = vi.fn(async (context) => ({ context: [...context, 'compressed'], applied: true }))
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('failed')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
    expect(f.ports.context.recoverOverflow).toHaveBeenCalledTimes(1)
    expect(result.events.filter((event) => event.type === 'compaction').map((event) => event.payload)).toEqual([{ phase: 'started', reason: 'provider_overflow' }, { phase: 'completed', reason: 'provider_retry_failed', applied: false }])
  })

  it('外层合法身份不能让另owner的嵌套context进入Provider或准备端口', async () => {
    const f = fixture()
    await collect(f.harness.start(identity))
    const checkpoint = f.records.get(f.idKey(identity))!
    f.records.set(f.idKey(identity), { ...checkpoint, status: 'running', phase: 'idle', context: [f.idKey({ ...identity, ownerId: 'other-owner' }), 'prepared'] })
    vi.mocked(f.ports.context.prepare).mockClear()
    vi.mocked(f.ports.provider.stream).mockClear()
    await expect(collect(createRunHarness(f.ports).resume(identity))).rejects.toMatchObject({ code: 'not_found' })
    expect(f.ports.context.prepare).not.toHaveBeenCalled()
    expect(f.ports.provider.stream).not.toHaveBeenCalled()
  })

  it('守卫续轮的token缓冲不会把未交付说明重新展示，提醒经Context端口进入下一轮', async () => {
    const f = fixture([[{ type: 'token', text: '计划说明' }, { type: 'complete', text: '计划说明', calls: [] }], [{ type: 'token', text: '仍是内部说明' }, { type: 'complete', text: '仍是内部说明', calls: [] }]])
    f.ports.reply.classify = vi.fn(async (text) => ({ ...replyFacts, narration: text.includes('说明') }))
    f.ports.context.appendReminder = vi.fn(async (context, prompt) => [...context, prompt])
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('completed')
    expect(state.text).toBe('')
    expect(events.filter((event) => event.type === 'token').map((event) => event.payload.text)).toEqual(['计划说明'])
    expect(f.ports.context.appendReminder).toHaveBeenCalledWith(expect.anything(), '合成叙述提醒')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
  })

  it('goal必须显式完成标记，未完成继续编排，内部标记跨token也不进入事件和时间线', async () => {
    const f = fixture([[{ type: 'token', text: '目标已完成' }, { type: 'complete', text: '目标已完成', calls: [] }], [{ type: 'token', text: '全部交付<!-- GUGU_' }, { type: 'token', text: 'GOAL_DONE -->' }, { type: 'complete', text: '全部交付<!-- GUGU_GOAL_DONE -->', calls: [] }]])
    f.ports.context.appendReminder = vi.fn(async (context, prompt) => [...context, prompt])
    const { state, events } = await collect(f.harness.start(identity, { goalMode: true }))
    expect(state.status).toBe('completed')
    expect(state.text).toBe('全部交付')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(events)).not.toContain('GUGU_GOAL_DONE')
    expect(JSON.stringify(state.displayTimeline)).not.toContain('GUGU_GOAL_DONE')
    expect(f.ports.context.appendReminder).toHaveBeenCalledTimes(1)
  })

  it('归一缓存anchor与原始tool参数保留给Canonical端口，provider私有字段不出现在visible事件', async () => {
    const raw = '{ "query" : "合成输入" }'
    const call = { ...toolCall, rawArguments: raw, responsesItemId: 'item-synthetic' }
    const anchor = { ownerId: identity.ownerId, modelIdentity: 'model-synthetic', anchorId: 'cache-synthetic' }
    const f = fixture([[{ type: 'complete', text: '', calls: [call], cacheAnchor: anchor }], [{ type: 'complete', text: '完成', calls: [] }]])
    const result = await collect(f.harness.start(identity))
    expect(f.ports.context.afterRound).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ calls: [call], cacheAnchor: anchor }), 1)
    expect(f.ports.tools.dispatch).toHaveBeenCalledWith(call, expect.anything())
    expect(JSON.stringify(result.events)).not.toContain('cache-synthetic')
    expect(JSON.stringify(result.events)).not.toContain('rawArguments')
  })

  it('Provider恢复必须匹配可信游标/正文/身份，续接去重旧token且不重新创建模型请求', async () => {
    const cursor = (sequence: number) => ({ sequence, reference: `cursor-${sequence}` })
    const f = fixture([[{ type: 'token', text: '前半', cursor: cursor(1) }]])
    f.ports.createStreamSanitizer = () => ({ feed: (text) => text, flush: () => '', checkpoint: () => ({ kind: 'clean' }) })
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'token') break
    }
    await source.return(undefined as never)
    f.ports.provider.recover = vi.fn(async (_request, boundary) => ({
      boundary, stream: stream([
        { type: 'token', text: '前半', cursor: cursor(1) },
        { type: 'token', text: '后半', cursor: cursor(2) },
        { type: 'complete', text: '前半后半', calls: [], cursor: cursor(3) },
      ])
    }))
    const { state, events } = await collect(createRunHarness(f.ports).resume(identity))
    expect(state.status).toBe('completed')
    expect(state.text).toBe('前半后半')
    expect(events.filter((event) => event.type === 'token').map((event) => event.payload.text)).toEqual(['后半'])
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(f.ports.provider.recover).toHaveBeenCalledWith(expect.objectContaining({ identity, round: 1 }), expect.objectContaining({ roundText: '前半', cursor: cursor(1), sanitizer: { kind: 'clean' } }))
  })

  it('恢复身份或sanitizer边界无法证明时终态unknown，不消费伪造流也不dispatch工具', async () => {
    for (const safe of [true, false]) {
      const f = fixture([[{ type: 'token', text: '部分正文', cursor: { sequence: 1, reference: 'cursor-1' } }]])
      if (safe) f.ports.createStreamSanitizer = () => ({ feed: (text) => text, flush: () => '', checkpoint: () => ({ kind: 'clean' }) })
      const source = f.harness.start(identity)
      while (true) {
        const event = await source.next()
        if (!event.done && event.value.type === 'token') break
      }
      await source.return(undefined as never)
      const iterated = vi.fn()
      f.ports.provider.recover = vi.fn(async (_request, boundary) => ({ boundary: { ...boundary, identity: { ...identity, ownerId: 'other-owner' } }, stream: { async *[Symbol.asyncIterator]() { iterated(); yield { type: 'complete', text: '伪造完成', calls: [toolCall] } as const } } }))
      expect((await collect(createRunHarness(f.ports).resume(identity))).state.status).toBe('unknown')
      expect(iterated).not.toHaveBeenCalled()
      expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
      if (!safe) expect(f.ports.provider.recover).not.toHaveBeenCalled()
    }
  })

  it('半token清洗状态只存安全引用，重启restore后不会把秘密尾部当普通正文展示', async () => {
    const f = fixture([[{ type: 'token', text: '[[private', cursor: { sequence: 1, reference: 'cursor-1' } }, { type: 'diagnostic', data: { output: 1 }, cursor: { sequence: 2, reference: 'cursor-2' } }]])
    const secure = new Map<string, string>()
    const restored = vi.fn()
    f.ports.createStreamSanitizer = () => {
      let buffered = ''
      return {
        feed(text) {
          if (buffered || text.startsWith('[[private')) {
            buffered += text
            const end = buffered.indexOf(']]')
            if (end < 0) return ''
            const visible = buffered.slice(end + 2)
            buffered = ''
            return visible
          }
          return text
        },
        flush: () => '',
        checkpoint() {
          if (!buffered) return { kind: 'clean' as const }
          secure.set('sanitizer-synthetic', buffered)
          return { kind: 'reference' as const, reference: 'sanitizer-synthetic' }
        },
        async restore(checkpoint) { buffered = secure.get(checkpoint.reference)!; restored() },
      }
    }
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'provider_diagnostic') break
    }
    await source.return(undefined as never)
    expect(f.records.get(f.idKey(identity))!.sanitizerCheckpoint).toEqual({ kind: 'reference', reference: 'sanitizer-synthetic' })
    f.ports.provider.recover = vi.fn(async (_request, boundary) => ({ boundary, stream: stream([{ type: 'token', text: 'secret]]安全正文', cursor: { sequence: 3, reference: 'cursor-3' } }, { type: 'complete', text: '安全正文', calls: [], cursor: { sequence: 4, reference: 'cursor-4' } }]) }))
    const result = await collect(createRunHarness(f.ports).resume(identity))
    expect(result.state.status).toBe('completed')
    expect(restored).toHaveBeenCalledTimes(1)
    expect(result.events.filter((event) => event.type === 'token').map((event) => event.payload.text)).toEqual(['安全正文'])
    expect(JSON.stringify(vi.mocked(f.ports.store.commit).mock.calls)).not.toContain('[[private')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it.each([
    { name: 'single_input', adjusted: false, accepted: false, requests: 1 },
    { name: 'retry_fails', adjusted: true, accepted: false, requests: 2 },
    { name: 'retry_succeeds', adjusted: true, accepted: true, requests: 2 },
  ])('overflow $name仅在Provider实际接受重试后才报告applied=true', async (scenario) => {
    const f = fixture()
    let requests = 0
    let accepted = false
    f.ports.provider.stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        requests++
        if (requests === 1 || !scenario.accepted) yield { type: 'error', error: new Error('合成overflow'), contextOverflow: true } as const
        else {
          accepted = true
          yield { type: 'complete', text: '恢复后完成', calls: [] } as const
        }
      }
    }))
    f.ports.context.recoverOverflow = vi.fn(async (context) => ({ context: scenario.adjusted ? [...context, '候选缩窗'] : context, applied: scenario.adjusted }))
    f.ports.publish = vi.fn(async (event) => { if (event.type === 'compaction' && event.payload.applied === true) expect(accepted).toBe(true) })
    const { state, events } = await collect(f.harness.start(identity))
    expect(requests).toBe(scenario.requests)
    expect(state.status).toBe(scenario.accepted ? 'completed' : 'failed')
    expect(events.filter((event) => event.type === 'compaction' && event.payload.phase === 'completed').map((event) => event.payload.applied)).toEqual([scenario.accepted])
    expect(state.overflowRecoveryPending).toBe(false)
  })

  it('requiresTools是当前Provider轮次事实，不写入Canonical文本且下一轮不沿用旧值', async () => {
    const f = fixture([[{ type: 'complete', text: '普通短句', calls: [], requiresTools: true }], [{ type: 'complete', text: '续轮说明', calls: [] }]])
    f.ports.reply.classify = vi.fn(async (_text, _context, facts) => ({ ...replyFacts, requiresTools: facts?.requiresTools ?? false }))
    f.ports.context.appendReminder = vi.fn(async (context, prompt) => [...context, prompt])
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.ports.reply.classify).mock.calls.map((call) => call[2]?.requiresTools)).toEqual([true, false])
    expect(f.ports.context.appendReminder).toHaveBeenCalledWith(expect.anything(), '合成工具提醒')
    expect(result.state.context?.some((text) => text.includes('requiresTools'))).toBe(false)
    expect(vi.mocked(f.ports.context.afterRound).mock.calls.every((call) => !('requiresTools' in call[1]))).toBe(true)
  })

  it('Provider重试事件复用run游标/背压并仅保留安全原因，Harness不另造网络重试路径', async () => {
    const f = fixture()
    const advanced = vi.fn()
    f.ports.provider.stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'retry', attempt: 1, maxRetries: 2, nextRetryMs: 0, errorCode: 'synthetic-private-upstream-error', cursor: { sequence: 1, reference: 'retry-1' } } as const
        advanced()
        yield { type: 'token', text: '重试后正文', cursor: { sequence: 2, reference: 'retry-2' } } as const
        yield { type: 'complete', text: '重试后正文', calls: [], cursor: { sequence: 3, reference: 'retry-3' } } as const
      }
    }))
    const source = f.harness.start(identity)
    let retry: RunEvent | undefined
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'retry') { retry = event.value; break }
    }
    expect(retry?.payload).toEqual({ attempt: 1, maxRetries: 2, nextRetryMs: 0, errorCode: 'unknown' })
    expect(advanced).not.toHaveBeenCalled()
    const result = await collect(source)
    expect(result.state.status).toBe('completed')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(f.ports.store.commit).mock.calls)).not.toContain('synthetic-private-upstream-error')
  })

  it('消费者提前return先中止Provider网络再等待iterator回收，正常Provider异常不因清理被误标用户取消', async () => {
    const f = fixture()
    const cleaned = vi.fn()
    f.ports.provider.stream = vi.fn(({ signal }) => ({
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ProviderEvent>> => ({ done: false, value: { type: 'token', text: '首段' } }),
        async return(): Promise<IteratorResult<ProviderEvent>> {
          if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          cleaned()
          return { done: true, value: undefined }
        },
      })
    }))
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'token') break
    }
    await expect(source.return(undefined as never)).resolves.toMatchObject({ done: true })
    expect(cleaned).toHaveBeenCalledTimes(1)
    expect(f.ports.leases.release).toHaveBeenCalledTimes(1)
    const failed = fixture()
    failed.ports.provider.stream = vi.fn(({ signal }) => ({
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ProviderEvent>> => { throw new Error('合成Provider失败') },
        async return(): Promise<IteratorResult<ProviderEvent>> { expect(signal.aborted).toBe(true); return { done: true, value: undefined } },
      })
    }))
    expect((await collect(failed.harness.start(identity))).state.status).toBe('failed')
  })

  it('工具前draft与真实回执完成后续轮提前EOF，保留轮次但不把draft当最终答案持久化或反思', async () => {
    const f = fixture([[{ type: 'token', text: '正在核验' }, { type: 'complete', text: '正在核验', calls: [toolCall] }], []])
    f.ports.context.afterFinal = vi.fn(async () => undefined)
    const { state, events } = await collect(f.harness.start(identity))
    expect(state).toMatchObject({ status: 'failed', errorCode: 'incomplete_continuation', completedToolCount: 1, roundTexts: ['正在核验'] })
    expect(state.context).toContain(`tool:${toolCall.id}:completed`)
    expect(events.filter((event) => event.type === 'final').map((event) => event.payload)).toEqual([
      expect.objectContaining({ text: '工具结果已返回，但后续回复没有完成，请重试。', status: 'failed' }),
    ])
    expect(f.histories).toEqual([])
    expect(f.ports.context.afterFinal).not.toHaveBeenCalled()
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
  })

  it('普通draft先成独立轮再出现工具、下一轮最终正文，时间线与流式交错顺序保持一致', async () => {
    const f = fixture([[{ type: 'token', text: '前置说明' }, { type: 'complete', text: '前置说明', calls: [toolCall] }], [{ type: 'token', text: '最终正文' }, { type: 'complete', text: '最终正文', calls: [] }]])
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.displayTimeline.map((item) => item.kind)).toEqual(['assistant', 'tool', 'assistant'])
    expect(state.roundTexts).toEqual(['前置说明', '最终正文'])
    expect(state.text).toBe('最终正文')
    const types = events.map((event) => event.type)
    expect(types.indexOf('token')).toBeLessThan(types.indexOf('round_end'))
    expect(types.indexOf('round_end')).toBeLessThan(types.indexOf('tool_call'))
    expect(types.indexOf('tool_done')).toBeLessThan(types.lastIndexOf('token'))
    expect(state.displayTimeline[0]!.roundId).not.toBe(state.displayTimeline[2]!.roundId)
  })

  it('普通popup取消的固定收尾正文已发后崩溃，恢复不重复token或累计上轮usage', async () => {
    const f = fixture([[{ type: 'usage', usage }, { type: 'complete', text: '', calls: [toolCall] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => ({ kind: 'waiting', interaction: { id: 'intent-confirm', kind: 'confirmation', toolCall: call } }))
    await collect(f.harness.start(identity))
    const resolving = createRunHarness(f.ports).resume(identity, { interactionId: 'intent-confirm', receiptId: 'cancel-before-crash', status: 'cancelled', value: null })
    let closing = ''
    while (true) {
      const event = await resolving.next()
      if (!event.done && event.value.type === 'token') { closing = String(event.value.payload.text); break }
    }
    await resolving.return(undefined as never)
    expect(f.records.get(f.idKey(identity))!.resolutionClosure?.step).toBe('end')
    const result = await collect(createRunHarness(f.ports).resume(identity))
    expect(result.state.status).toBe('completed')
    expect(result.events.some((event) => event.type === 'token')).toBe(false)
    expect(result.state.roundTexts.filter((text) => text === closing)).toHaveLength(1)
    expect(result.state.totalUsage).toEqual(usage)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
  })
})
