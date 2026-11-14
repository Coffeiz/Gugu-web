import { describe,expect,it,vi } from 'vitest'
import { ExecutionError } from "../../../../src/agent/executor/contracts.js"
import type {
HarnessPorts,
ProviderEvent,
RunEvent,
ToolPort,
ToolResult
} from "../../../../src/agent/harness/index.js"
import { createPortableReplyPolicy,createRunHarness,HarnessError,RunStoreRejected } from "../../../../src/agent/harness/index.js"
import type { Context } from '../run/fixtures.js'
import { collect,deferred,fixture,identity,replyFacts,stream,toolCall,usage } from '../run/fixtures.js'

describe('Harness Run生命周期与持久化边界', () => {
  it('串行三个不同工具按模型顺序交错提交call与done，不能先发完所有call', async () => {
    const calls = ['alpha', 'beta', 'gamma'].map(name => ({ id: `call-${name}`, name: `read_${name}`, input: {} }))
    const f = fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '读取完成', calls: [] }]])
    const result = await collect(f.harness.start(identity))
    expect(vi.mocked(f.ports.tools.dispatch).mock.calls.map(([call]) => call.name)).toEqual(calls.map(call => call.name))
    expect(result.events.filter(event => event.type === 'tool_call' || event.type === 'tool_done').map(event => [event.type, event.payload.toolCallId, event.payload.status]))
      .toEqual(calls.flatMap(call => [['tool_call', call.id, 'running'], ['tool_done', call.id, 'success']]))
  })
  it('真实回复策略空答追问实际进入下一轮上下文，工具成功后重新获得追问额度', async () => {
    const f = fixture([
      [{ type: 'complete', text: '', calls: [] }],
      [{ type: 'complete', text: '', calls: [toolCall] }],
      [{ type: 'complete', text: '', calls: [] }],
      [{ type: 'token', text: '项目查询完成' }, { type: 'complete', text: '项目查询完成', calls: [] }],
    ])
    f.ports.reply = createPortableReplyPolicy({ context: () => ({ userRequest: '查一下项目', locale: 'zh-CN' }) })
    const stream = f.ports.provider.stream
    f.ports.provider.stream = vi.fn<HarnessPorts<Context>['provider']['stream']>(request => {
      const reminders = request.context.filter(text => text.startsWith('reminder:'))
      if (request.round === 2) expect(reminders).toHaveLength(1)
      if (request.round === 4) expect(reminders).toHaveLength(2)
      return stream(request)
    })
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(result.state.text).toBe('项目查询完成')
    expect(f.ports.context.appendReminder).toHaveBeenCalledTimes(2)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(result.events.filter(event => event.type === 'token').map(event => event.payload.text).join('')).toBe('项目查询完成')
  })

  it('真实中文进度守卫保留首轮draft，守卫追问的无工具回复不再泄漏', async () => {
    const f = fixture([
      [{ type: 'token', text: '正在为你查询最新信息。' }, { type: 'complete', text: '正在为你查询最新信息。', calls: [] }],
      [{ type: 'token', text: '查完了，结果如下。' }, { type: 'complete', text: '查完了，结果如下。', calls: [] }],
    ])
    f.ports.reply = createPortableReplyPolicy({ context: () => ({ userRequest: '查一下最新信息', locale: 'zh-CN' }) })
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(result.events.filter(event => event.type === 'token').map(event => event.payload.text).join('')).toBe('正在为你查询最新信息。')
    expect(f.ports.context.appendReminder).toHaveBeenCalledTimes(1)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
  })
  it('scheduled连续31次真实工具轮后仍能在第32轮完成，不误用30工具上限', async () => {
    const rounds: ProviderEvent[][] = Array.from({ length: 31 }, (_, index) => [{ type: 'complete', text: `轮次${index + 1}`, calls: [{ ...toolCall, id: `task-call-${index}` }] }])
    rounds.push([{ type: 'complete', text: '任务已完成', calls: [] }])
    const f = fixture(rounds)
    const { state } = await collect(f.harness.start(identity, { scheduled: true }))
    expect(state.status).toBe('completed')
    expect(state.round).toBe(32)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(31)
    expect(f.histories).toHaveLength(1)
  })
  it('成功历史与用量只提交一次，final在历史之后；重启读取终态不重跑模型', async () => {
    const f = fixture()
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('completed')
    expect(state.totalUsage).toEqual(usage)
    expect(f.histories).toEqual([{ outcome: 'success', context: [f.idKey(identity), 'prepared', 'assistant:合成回复'], text: '合成回复' }])
    expect(f.order.indexOf('history')).toBeLessThan(f.order.indexOf('publish:final'))
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1))
    expect((await collect(createRunHarness(f.ports).resume(identity))).state.status).toBe('completed')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(f.histories).toHaveLength(1)
  })

  it('错误文案经安全端口展示，error不写canonical history', async () => {
    const f = fixture([[{ type: 'token', text: '中间文本' }, { type: 'error', error: new Error('合成凭据与私有正文') }]])
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('failed')
    expect(events.at(-1)?.payload).toMatchObject({ text: '上游暂时不可用' })
    expect(JSON.stringify(events)).not.toContain('私有正文')
    expect(f.histories).toEqual([])
  })

  it('取消保留已完成轮次和部分正文，不把用户取消文案当助手历史', async () => {
    const f = fixture()
    const next = deferred<IteratorResult<ProviderEvent>>()
    let steps = 0
    f.ports.provider.stream = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<ProviderEvent>> => ++steps === 1 ? Promise.resolve({ value: { type: 'token', text: '部分正文' }, done: false }) : next.promise,
        return: async (): Promise<IteratorResult<ProviderEvent>> => ({ done: true, value: undefined }),
      })
    }))
    const source = f.harness.start(identity)
    while (true) {
      const item = await source.next()
      if (!item.done && item.value.type === 'token') break
    }
    const task = collect(source)
    await f.harness.cancel(identity)
    const { state } = await task
    expect(state.status).toBe('cancelled')
    expect(f.histories).toEqual([{ outcome: 'interruption', context: [f.idKey(identity), 'prepared'], text: '部分正文' }])
    next.resolve({ done: true, value: undefined })
  })

  it('持久化失败结果未知时停止，不二次收尾或重发工具', async () => {
    const f = fixture()
    f.ports.store.commit = vi.fn(async () => { throw new Error('合成提交中断') })
    await expect(collect(f.harness.start(identity))).rejects.toMatchObject({ code: 'persistence_unknown' })
    expect(f.ports.store.commit).toHaveBeenCalledTimes(1)
    expect(f.ports.provider.stream).not.toHaveBeenCalled()
    expect(f.histories).toHaveLength(0)
    expect(f.ports.leases.release).toHaveBeenCalledTimes(1)
  })

  it('发布失败保留outbox且不回滚历史，replay不重新执行模型', async () => {
    const f = fixture()
    f.ports.publish = vi.fn(async () => { throw new Error('合成消息总线故障') })
    await collect(f.harness.start(identity))
    expect(f.outbox.size).toBeGreaterThan(0)
    expect(f.histories).toHaveLength(1)
    const before = f.outbox.size
    f.ports.publish = vi.fn(async () => undefined)
    const replayed: RunEvent[] = []
    for await (const event of f.harness.replay(identity)) replayed.push(event)
    expect(replayed).toHaveLength(before)
    expect(f.outbox.size).toBe(0)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(f.histories).toHaveLength(1)
  })

  it('工具通过绑定可信scope的共用Executor执行，模型不能提供owner或grant', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    const request = { id: 'request-synthetic', command: '合成命令', cwd: '/synthetic', timeoutMs: 10, destructive: false }
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (_call, scope) => {
      await scope.execute(request)
      return { kind: 'completed', value: '完成', successful: true, mutated: true }
    })
    const { state } = await collect(f.harness.start(identity))
    expect(state.status).toBe('completed')
    expect(f.ports.execution.execute).toHaveBeenCalledWith({ ...identity, roundId: 'run-synthetic:1', toolCallId: toolCall.id }, request, expect.any(AbortSignal))
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(state.completedToolCount).toBe(1)
  })

  it('执行后崩溃仅查询操作收据，未知结果不再次派发', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'tool_call') break
    }
    await source.return(undefined as never)
    const result = await collect(createRunHarness(f.ports).resume(identity))
    expect(result.state.status).toBe('unknown')
    expect(f.ports.tools.reconcile).toHaveBeenCalledWith(toolCall, { ...identity, roundId: 'run-synthetic:1' })
    expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
  })

  it('同一请求缺失实际usage不触发压缩，空结果补充两次后按Python契约给出正常空回复文案', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [] }]])
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(result.state.text).toBe('嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(3)
    expect(f.ports.context.afterUsage).not.toHaveBeenCalled()
    expect(f.histories).toHaveLength(1)
  })

  it('串行工具取消必须等待资源清理，并关闭当前气泡且后续工具不派发', async () => {
    const calls = [toolCall, { ...toolCall, id: 'call-next' }]
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    const started = deferred<void>()
    let cleaned = false
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (_call, scope) => {
      started.resolve()
      await new Promise<void>((resolve) => scope.signal.addEventListener('abort', () => resolve(), { once: true }))
      await Promise.resolve()
      cleaned = true
      throw new HarnessError('cancelled', '合成工具取消')
    })
    const result = collect(f.harness.start(identity))
    await started.promise
    await f.harness.cancel(identity)
    const { state, events } = await result
    expect(state.status).toBe('cancelled')
    expect(cleaned).toBe(true)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'tool_done').map((event) => event.payload.status)).toEqual(['cancelled', 'deferred'])
  })

  it('工具完成回执先到时即使同一turn取消也保留已完成canonical结果', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => {
      const result: ToolResult = { kind: 'completed', value: '已完成', successful: true, mutated: true }
      queueMicrotask(() => { void f.harness.cancel(identity) })
      return result
    })
    const { state } = await collect(f.harness.start(identity))
    expect(state.status).toBe('cancelled')
    expect(state.completedToolCount).toBe(1)
    expect(f.histories.at(-1)?.context).toContain(`tool:${toolCall.id}:completed`)
    expect(f.histories.at(-1)?.outcome).toBe('interruption')
  })

  it('可信并发计划实际重叠执行，queued/running分开且canonical结果按模型序提交', async () => {
    const calls = [toolCall, { ...toolCall, id: 'call-second' }, { ...toolCall, id: 'call-third' }]
    const f = fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 2 }))
    let active = 0
    let peak = 0
    const twoStarted = deferred<void>()
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => {
      active++
      peak = Math.max(peak, active)
      if (active === 2) twoStarted.resolve()
      await twoStarted.promise
      await Promise.resolve()
      active--
      return { kind: 'completed', value: '完成', successful: true, mutated: false }
    })
    const { state, events } = await collect(f.harness.start(identity))
    expect(peak).toBe(2)
    expect(state.completedToolCount).toBe(3)
    expect(f.histories.at(-1)?.context.filter((item) => item.startsWith('tool:'))).toEqual(calls.map((call) => `tool:${call.id}:completed`))
    expect(events.filter((event) => event.type === 'tool_call').map((event) => event.payload.status)).toEqual(['queued', 'queued', 'queued', 'running', 'running', 'running'])
  })

  it('并发共享取消保留已完成工具，等待兄弟清理且未启动项deferred', async () => {
    const calls = [toolCall, { ...toolCall, id: 'call-second' }, { ...toolCall, id: 'call-third' }, { ...toolCall, id: 'call-fourth' }]
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 3 }))
    const siblings = deferred<void>()
    let stopped = false
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call, scope) => {
      if (call.id === toolCall.id) return { kind: 'completed', value: '完成', successful: true, mutated: true }
      if (call.id === 'call-second') { await siblings.promise; throw new HarnessError('cancelled', '合成取消') }
      siblings.resolve()
      await new Promise<void>((resolve) => scope.signal.addEventListener('abort', () => resolve(), { once: true }))
      stopped = true
      throw new HarnessError('cancelled', '合成兄弟取消')
    })
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('cancelled')
    expect(stopped).toBe(true)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(3)
    expect(events.filter((event) => event.type === 'tool_done').map((event) => event.payload.status)).toEqual(['success', 'cancelled', 'cancelled', 'deferred'])
    expect(state.completedToolCount).toBe(1)
    expect(f.histories.at(-1)?.context).toContain(`tool:${toolCall.id}:completed`)
  })

  it('工具输入拒绝getter/平台对象/循环值，验证本身不能触发getter', async () => {
    const getter = vi.fn(() => '合成私有值')
    for (const input of [new Map(), { get value() { return getter() } }, (() => { const cycle: Record<string, unknown> = {}; cycle.self = cycle; return cycle })()]) {
      const f = fixture([[{ type: 'complete', text: '', calls: [{ ...toolCall, input }] }]])
      expect((await collect(f.harness.start(identity))).state.status).toBe('failed')
      expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('冒号守卫续轮在真实最终正文确定后一次性展示，不丢最后一段', async () => {
    const f = fixture([[{ type: 'token', text: '结果如下：' }, { type: 'complete', text: '结果如下：', calls: [] }], [{ type: 'token', text: '交付内容' }, { type: 'complete', text: '交付内容', calls: [] }]])
    f.ports.reply.classify = vi.fn(async (text) => ({ ...replyFacts, endsWithColon: text.endsWith('：') }))
    f.ports.context.appendReminder = vi.fn(async (context, prompt) => [...context, prompt])
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('completed')
    expect(state.text).toBe('交付内容')
    expect(events.filter((event) => event.type === 'token').map((event) => event.payload.text)).toEqual(['结果如下：', '交付内容'])
  })

  it('scheduled保持100轮安全上限，普通run不因相同轮数提前停止', async () => {
    const rounds: ProviderEvent[][] = Array.from({ length: 101 }, (_unused, index) => [{ type: 'complete', text: '', calls: [{ ...toolCall, id: `call-${index}` }] }])
    rounds.push([{ type: 'complete', text: '完成', calls: [] }])
    const scheduled = fixture(rounds)
    expect((await collect(scheduled.harness.start(identity, { scheduled: true }))).state).toMatchObject({ status: 'failed', errorCode: 'round_limit', round: 100 })
    const ordinary = fixture(rounds)
    expect((await collect(ordinary.harness.start(identity))).state).toMatchObject({ status: 'completed', round: 102, completedToolCount: 101 })
  })

  it('取消旧run的展示按原始问题anchor排序，Tool状态更新不追加第二个气泡', async () => {
    const f = fixture([[{ type: 'complete', text: '前置说明', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    const { state, events } = await collect(f.harness.start(identity, { anchorMessageId: '17' }))
    const tool = state.displayTimeline.filter((item) => item.kind === 'tool')
    expect(tool).toHaveLength(1)
    expect(tool[0]).toMatchObject({ anchorMessageId: '17', timelineOrder: '17000002', toolStatus: 'success' })
    const updates = events.filter((event) => event.type === 'tool_call' || event.type === 'tool_done').map((event) => event.payload.display)
    expect(updates[0]).toMatchObject({ eventId: tool[0]!.eventId, sequence: 2 })
    expect(updates[1]).toMatchObject({ eventId: tool[0]!.eventId, sequence: 2 })
  })

  it('串行单项工具异常脱敏并隔离，剩余工具继续，提交未知则必须显式unknown终止', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall, { ...toolCall, id: 'second-call' }] }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => {
      if (call.id === toolCall.id) throw new Error('synthetic-private-tool-failure')
      return { kind: 'completed', value: '完成', successful: true, mutated: false }
    })
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(result.events.filter((event) => event.type === 'tool_done').map((event) => event.payload.status)).toEqual(['error', 'success'])
    expect(JSON.stringify(result)).not.toContain('synthetic-private-tool-failure')
    const uncertain = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    uncertain.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'unknown' }))
    expect((await collect(uncertain.harness.start(identity))).state.status).toBe('unknown')
    expect(uncertain.ports.provider.stream).toHaveBeenCalledTimes(1)
  })

  it('成功提交与发布后才安排反思，hook失败保持权威终态且不重放业务；error/cancel不反思', async () => {
    const f = fixture()
    f.ports.context.afterFinal = vi.fn(async () => {
      expect(f.histories).toHaveLength(1)
      expect(f.order).toContain('publish:final')
      throw new Error('合成私有反思异常')
    })
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(f.ports.diagnose).toHaveBeenCalledWith('finalization_hook_failed')
    expect(JSON.stringify(result)).not.toContain('合成私有反思异常')
    await collect(createRunHarness(f.ports).resume(identity))
    expect(f.ports.context.afterFinal).toHaveBeenCalledTimes(1)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    const error = fixture([[{ type: 'error', error: new Error('合成错误') }]])
    error.ports.context.afterFinal = vi.fn()
    await collect(error.harness.start(identity))
    expect(error.ports.context.afterFinal).not.toHaveBeenCalled()
  })

  it('同owner/session的新run不能在旧run尚未结束时并发启动，取消不影响下一次run', async () => {
    const f = fixture()
    const started = deferred<void>()
    f.ports.provider.stream = vi.fn(({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        started.resolve()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      }
    }))
    const active = collect(f.harness.start(identity))
    await started.promise
    await expect(collect(f.harness.start({ ...identity, runId: 'next-run' }))).rejects.toMatchObject({ code: 'conflict' })
    await f.harness.cancel(identity)
    await active
    f.ports.provider.stream = vi.fn(() => stream([{ type: 'complete', text: '新运行正常', calls: [] }]))
    const next = await collect(f.harness.start({ ...identity, runId: 'next-run' }))
    expect(next.state.status).toBe('completed')
  })

  it('mutated来自工具明确结果而非名称前缀，artifact与tool_done同事务保存供刷新回放', async () => {
    const attachment = { attach_id: 'attachment-synthetic', name: '合成结果.png', kind: 'image' }
    const f = fixture([[{ type: 'complete', text: '', calls: [{ ...toolCall, name: 'remember' }] }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'completed', value: '完成', successful: true, mutated: true, artifact: attachment }))
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.mutated).toBe(true)
    expect(state.files).toEqual([attachment])
    expect(state.displayTimeline.find((item) => item.files)?.files).toEqual([attachment])
    const committed = vi.mocked(f.ports.store.commit).mock.calls.map(([change]) => change).find((change) => change.events[0]?.type === 'tool_done')!
    expect(committed.checkpoint.files).toEqual([attachment])
    expect(committed.checkpoint.displayTimeline.find((item) => item.files)?.files).toEqual([attachment])
    expect(events.find((event) => event.type === 'tool_done')?.payload.artifactDisplay).toMatchObject({ kind: 'assistant', files: [attachment] })
    const readOnly = fixture([[{ type: 'complete', text: '', calls: [{ ...toolCall, name: 'update_named_but_readonly' }] }], [{ type: 'complete', text: '完成', calls: [] }]])
    expect((await collect(readOnly.harness.start(identity))).state.mutated).toBe(false)
  })

  it('链接按钮产物进独立展示卡而不混入附件列表', async () => {
    const artifact = { kind: 'link_buttons', message: '合成说明', buttons: [{ id: 'synthetic-button', label: '合成链接', url: 'https://example.test/result' }] }
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'completed', value: '完成', successful: true, mutated: false, artifact }))
    const { state } = await collect(f.harness.start(identity))
    expect(state.files).toEqual([])
    expect(state.displayTimeline.find((item) => item.linkButtons)?.linkButtons).toEqual(artifact)
  })

  it('模型轮次诊断只投影明确字段，不把Prompt/response和任意上游原因写进checkpoint或事件', async () => {
    const f = fixture([[{ type: 'diagnostic', data: { round_id: 'round-synthetic', input: 24, context_input: 24, output: 10, output_token_budget: 10, finish_reason: 'incomplete', incomplete_reason: 'max_output_tokens', prompt: 'synthetic-private-prompt', response: 'synthetic-private-response' } }, { type: 'complete', text: '完成', calls: [] }]])
    const result = await collect(f.harness.start(identity))
    expect(result.state.providerRounds).toEqual([{ round_id: 'round-synthetic', input: 24, context_input: 24, output: 10, output_token_budget: 10, finish_reason: 'incomplete', incomplete_reason: 'max_output_tokens' }])
    expect(JSON.stringify(result)).not.toContain('synthetic-private')
    expect(JSON.stringify(vi.mocked(f.ports.store.commit).mock.calls)).not.toContain('synthetic-private')
    expect(result.events.at(-1)?.payload.providerRounds).toEqual(result.state.providerRounds)
  })

  it('工具running事件后实际派发前取消只更新展示，executed=false不生成孤儿Canonical往返', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'tool_call') break
    }
    await f.harness.cancel(identity)
    const result = await collect(source)
    expect(result.state.status).toBe('cancelled')
    expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
    expect(f.ports.context.afterTool).toHaveBeenCalledWith(expect.anything(), toolCall, expect.objectContaining({ executed: false }), 1)
    expect(result.state.context?.some((item) => item.startsWith('tool:'))).toBe(false)
  })

  it('压缩未应用也保存无进展策略元数据，不发布虚假压缩成功事件', async () => {
    const f = fixture()
    f.ports.context.afterUsage = vi.fn(async (context) => ({ context: [...context, 'failed-pressure:9'], applied: false }))
    const result = await collect(f.harness.start(identity))
    expect(result.state.context).toContain('failed-pressure:9')
    expect(result.events.some((event) => event.type === 'compaction')).toBe(false)
  })

  it('租约与早期存储异常只暴露安全错误，不在失效fence上写错误终态', async () => {
    const f = fixture()
    f.ports.leases.acquire = vi.fn(async () => { throw new Error('synthetic-private-lease-error') })
    await expect(collect(f.harness.start(identity))).rejects.toThrow('上游暂时不可用')
    const store = fixture()
    store.ports.store.read = vi.fn(async () => { throw new Error('synthetic-private-storage-error') })
    await expect(collect(store.harness.resume(identity))).rejects.toMatchObject({ code: 'persistence_unknown', message: '运行状态读取失败，请重新查询' })
    const stale = fixture()
    const source = stale.harness.start(identity)
    await source.next()
    stale.ports.leases.assert = vi.fn(async () => { throw new Error('synthetic-private-fence-error') })
    await expect(collect(source)).rejects.toMatchObject({ code: 'lease_lost' })
    expect(stale.histories).toHaveLength(0)
    expect(stale.ports.store.commit).not.toHaveBeenCalled()
  })

  it.each(['attachment_claim_failed', 'quota_exhausted', 'voice_unsupported', 'provider_error'] as const)('准备早退%s共用final路径，不调用模型/工具或正常历史反思', async (reason) => {
    const f = fixture()
    f.ports.context.prepare = vi.fn<HarnessPorts<Context>['context']['prepare']>(async () => ({ kind: 'early_exit', reason, response: { text: '合成早退响应', errored: reason === 'provider_error', errorCode: 'safe_provider_error' } }))
    f.ports.context.afterFinal = vi.fn()
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe(reason === 'provider_error' ? 'failed' : 'completed')
    expect(state.earlyExitReason).toBe(reason)
    expect(state.context).toBeNull()
    expect(events.map((event) => event.type)).toEqual(['run_started', 'final'])
    expect(events.at(-1)?.payload.text).toBe('合成早退响应')
    expect(f.ports.provider.stream).not.toHaveBeenCalled()
    expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
    expect(f.histories).toEqual([])
    expect(f.ports.context.afterFinal).not.toHaveBeenCalled()
  })

  it('parallel动态等待持久全部siblings回执，仅激活首门，重启后依次回答而不重派任何工具', async () => {
    const calls = ['ask-a', 'read-b', 'ask-c', 'read-d'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 4 }))
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => call.id.startsWith('ask') ? { kind: 'waiting', interaction: { id: `intent-${call.id}`, kind: 'question', toolCall: call } } : { kind: 'completed', value: `实际结果:${call.id}`, successful: true, mutated: false })
    f.ports.interactions.activate = vi.fn(async (_id, request) => ({ ...request, id: `active-${request.id}` }))
    const first = await collect(f.harness.start(identity))
    expect(first.state.pending?.id).toBe('active-intent-ask-a')
    expect(first.state.queuedInteractions.map((item) => item.id)).toEqual(['intent-ask-c'])
    expect(f.ports.interactions.activate).toHaveBeenCalledTimes(1)
    const waitCommit = vi.mocked(f.ports.store.commit).mock.calls.find(([change]) => change.events[0]?.type === 'interaction_required')![0]
    expect(waitCommit.checkpoint.toolResults).toHaveLength(4)
    expect(waitCommit.checkpoint.toolResults.find((item) => item.callId === 'read-d')?.result).toMatchObject({ kind: 'completed', value: '实际结果:read-d' })
    const second = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'active-intent-ask-a', receiptId: 'receipt-answer-a', status: 'answered', value: '合成第一答' }))
    expect(second.state.status).toBe('waiting')
    expect(second.state.pending?.id).toBe('active-intent-ask-c')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    const final = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'active-intent-ask-c', receiptId: 'receipt-answer-c', status: 'answered', value: '合成第二答' }))
    expect(final.state.status).toBe('completed')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(4)
    expect(f.ports.interactions.activate).toHaveBeenCalledTimes(2)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
  })

  it('无副作用协议错误独立回执不调用dispatch，五个普通Shell仍按配置并发且结果保持原序', async () => {
    const calls = [{ ...toolCall, id: 'invalid-call', name: 'call_tool', input: { name: 'shell', arguments: [] } }, ...Array.from({ length: 5 }, (_unused, index) => ({ ...toolCall, id: `shell-${index}`, name: 'shell', input: { command: `synthetic-${index}` } }))]
    const f = fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 5, isolatedResults: [{ callId: 'invalid-call', result: { kind: 'completed' as const, value: { error: 'tool_call_invalid' }, successful: false, mutated: false } }] }))
    const started = deferred<void>()
    let count = 0
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => {
      if (++count === 5) started.resolve()
      await started.promise
      return { kind: 'completed', value: '完成', successful: true, mutated: false }
    })
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('completed')
    expect(count).toBe(5)
    expect(vi.mocked(f.ports.tools.dispatch).mock.calls.every(([call]) => call.name === 'shell')).toBe(true)
    expect(events.find((event) => event.type === 'tool_call' && event.payload.toolCallId === 'invalid-call')?.payload.status).toBe('invalid')
    expect(events.filter((event) => event.type === 'tool_done').map((event) => event.payload.toolCallId)).toEqual(calls.map((call) => call.id))
  })

  it('展示首个门前已封存全部siblings的Canonical与回执，崩溃后取消也不能改写已完成结果', async () => {
    const calls = ['ask-a', 'done-b', 'ask-c'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 3 }))
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => call.id.startsWith('ask') ? { kind: 'waiting', interaction: { id: `intent-${call.id}`, kind: 'question', toolCall: call } } : { kind: 'completed', value: '兄弟真实已完成', successful: true, mutated: true })
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'interaction_required') break
    }
    await source.return(undefined as never)
    const checkpoint = f.records.get(f.idKey(identity))!
    expect(checkpoint.callIndex).toBe(3)
    expect(checkpoint.context).toContain('tool:done-b:completed')
    expect(checkpoint.queuedInteractions).toHaveLength(1)
    const result = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-ask-a', receiptId: 'receipt-cancel-after-crash', status: 'cancelled', value: null }))
    expect(result.state.status).toBe('completed')
    expect(f.histories.at(-1)?.context).toContain('tool:done-b:completed')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(3)
    expect(f.ports.interactions.activate).toHaveBeenCalledTimes(1)
  })

  it('publisher阻塞时取消仍可提交终态，未ack的启动/final留在outbox且replay不重跑业务', async () => {
    const f = fixture()
    const publishing = deferred<void>()
    const never = deferred<void>()
    f.ports.publish = vi.fn(async () => { publishing.resolve(); await never.promise })
    const running = collect(f.harness.start(identity))
    await publishing.promise
    expect(await f.harness.cancel(identity)).toBe(true)
    const result = await running
    expect(result.state.status).toBe('cancelled')
    expect([...f.outbox.values()].map((event) => event.type)).toEqual(['run_started', 'final'])
    expect(f.ports.provider.stream).not.toHaveBeenCalled()
    f.ports.publish = vi.fn(async () => undefined)
    for await (const _event of f.harness.replay(identity)) { /* 补送权威outbox，不启动Agent。 */ }
    expect(f.outbox.size).toBe(0)
    expect(f.ports.provider.stream).not.toHaveBeenCalled()
    never.resolve()
  })

  it('并发清理发生于兄弟DB提交等待期间，迟到running不能入无人消费队列造成return死锁', async () => {
    const calls = ['first-call', 'second-call'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 2 }))
    const secondCommit = deferred<void>()
    const releaseCommit = deferred<void>()
    const original = f.ports.store.commit
    f.ports.store.commit = vi.fn(async (change) => {
      const event = change.events[0]
      if (event?.type === 'tool_call' && event.payload.toolCallId === 'second-call' && event.payload.status === 'running') {
        secondCommit.resolve()
        await releaseCommit.promise
      }
      await original(change)
    })
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'tool_call' && event.value.payload.status === 'running') break
    }
    await secondCommit.promise
    const closed = source.return(undefined as never)
    await Promise.resolve()
    releaseCommit.resolve()
    await expect(closed).resolves.toMatchObject({ done: true })
    expect(f.ports.leases.release).toHaveBeenCalledTimes(1)
  })

  it('模型响应标记incomplete不能执行截断工具参数，已上报实际用量仍只记一次', async () => {
    const f = fixture([[{ type: 'usage', usage }, { type: 'complete', text: '被截断的说明', calls: [toolCall], finishReason: 'incomplete', incompleteReason: 'max_output_tokens' }]])
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('failed')
    expect(state.errorCode).toBe('provider_incomplete')
    expect(state.totalUsage).toEqual(usage)
    expect(events.at(-1)?.payload.usage).toEqual(usage)
    expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
    expect(f.ports.context.afterRound).not.toHaveBeenCalled()
    expect(f.histories).toEqual([])
    await collect(createRunHarness(f.ports).resume(identity))
    expect(f.records.get(f.idKey(identity))!.totalUsage).toEqual(usage)
  })

  it('群回复pending先缓冲正文，同批decline阻断所有业务且silent只提交用量/缓存metadata', async () => {
    const decline = { ...toolCall, id: 'decline-call', name: 'choose_no_reply' }
    const business = { ...toolCall, id: 'business-call', name: 'create_project' }
    const anchor = { modelIdentity: 'model-synthetic', anchor: { provider: 'synthetic', api_format: 'synthetic', model: 'model-synthetic', strategy: 'multi', baseline_digest: 'digest-synthetic' } }
    const f = fixture([[{ type: 'token', text: '不应提前展示的草稿' }, { type: 'usage', usage }, { type: 'complete', text: '不应提前展示的草稿', calls: [decline, business], cacheAnchor: anchor }]])
    f.ports.replyGate = { classifyCall: vi.fn(async (_context, call) => call.name === 'choose_no_reply' ? 'decline' : 'business') }
    f.ports.tools.plan = vi.fn(async () => { throw new Error('静默选择不得进入执行计划') })
    f.ports.context.afterFinal = vi.fn()
    const { state, events } = await collect(f.harness.start(identity, { replyChoice: 'pending' }))
    expect(state.status).toBe('completed')
    expect(state.replyChoice).toBe('silent')
    expect(state.text).toBe('')
    expect(events.filter((event) => event.type === 'token')).toEqual([])
    expect(f.ports.tools.plan).not.toHaveBeenCalled()
    expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(f.histories.at(-1)?.outcome).toBe('silent')
    expect(f.ports.context.afterRound).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cacheAnchor: anchor }), 1)
    const final = vi.mocked(f.ports.store.commit).mock.calls.map(([change]) => change).find((change) => change.history?.outcome === 'silent')!
    expect(final.checkpoint.totalUsage).toEqual(usage)
    expect(f.ports.context.afterFinal).not.toHaveBeenCalled()
  })

  it('群纯工具轮保留decline机会，确定实际正文后锁reply且以后拒绝再选静默', async () => {
    const business = { ...toolCall, id: 'business-call', name: 'lookup' }
    const decline = { ...toolCall, id: 'decline-call', name: 'choose_no_reply' }
    const f = fixture([[{ type: 'complete', text: '', calls: [business] }], [{ type: 'token', text: '已有实际答复' }, { type: 'complete', text: '已有实际答复', calls: [{ ...business, id: 'next-business' }] }], [{ type: 'complete', text: '尝试错误静默', calls: [decline] }], [{ type: 'complete', text: '正常收尾', calls: [] }]])
    f.ports.replyGate = { classifyCall: vi.fn(async (_context, call) => call.name === 'choose_no_reply' ? 'decline' : 'business') }
    const { state, events } = await collect(f.harness.start(identity, { replyChoice: 'pending' }))
    expect(state.replyChoice).toBe('reply')
    expect(vi.mocked(f.ports.provider.stream).mock.calls.map(([request]) => request.replyChoice)).toEqual(['pending', 'pending', 'reply', 'reply'])
    expect(vi.mocked(f.ports.tools.dispatch).mock.calls.map(([call]) => call.name)).toEqual(['lookup', 'lookup'])
    expect(events.filter((event) => event.type === 'token').map((event) => event.payload.text)).toEqual(['已有实际答复'])
    expect(events.find((event) => event.type === 'tool_done' && event.payload.toolCallId === decline.id)?.payload.status).toBe('error')
    expect(f.histories.at(-1)?.outcome).toBe('success')
  })

  it('明确已回滚的CAS/owner/fence拒绝按真实错误中止，不伪装未知提交或覆盖新状态', async () => {
    for (const code of ['conflict', 'not_found', 'lease_lost'] as const) {
      const f = fixture()
      f.ports.store.commit = vi.fn(async () => { throw new RunStoreRejected(code) })
      await expect(collect(f.harness.start(identity))).rejects.toMatchObject({ code })
      expect(f.ports.store.commit).toHaveBeenCalledTimes(1)
      expect(f.ports.provider.stream).not.toHaveBeenCalled()
      expect(f.histories).toEqual([])
      expect(f.records.get(f.idKey(identity))?.status).toBe('preparing')
    }
  })

  it.each([
    { name: 'create_project', input: {}, successful: true, mutated: true },
    { name: 'lookup', input: {}, successful: true, mutated: false },
    { name: 'create_project', input: {}, successful: false, mutated: false },
    { name: 'send_file', input: {}, successful: true, mutated: false, artifact: { attach_id: 'attachment-synthetic' } },
    { name: 'manage_mcp_servers', input: { action: 'list' }, successful: true, mutated: false },
    { name: 'manage_mcp_servers', input: { action: 'add' }, successful: true, mutated: true },
    { name: 'mcp_external_weather', input: {}, successful: true, mutated: true },
    { name: 'note_create', input: {}, successful: true, mutated: true },
  ])('$name的成功/失败与副作用元数据不擅自增加自动复查或读回轮次', async (scenario) => {
    const call = { ...toolCall, name: scenario.name, input: scenario.input }
    const f = fixture([[{ type: 'token', text: '前置说明' }, { type: 'complete', text: '前置说明', calls: [call] }], [{ type: 'complete', text: '正常结果', calls: [] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'completed', value: '实际回执', successful: scenario.successful, mutated: scenario.mutated, ...('artifact' in scenario ? { artifact: scenario.artifact } : {}) }))
    f.ports.context.appendReminder = vi.fn(async (context) => context)
    const { state, events } = await collect(f.harness.start(identity))
    expect(state.status).toBe('completed')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(f.ports.tools.dispatch).toHaveBeenCalledWith(call, expect.anything())
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(2)
    expect(f.ports.context.appendReminder).not.toHaveBeenCalled()
    expect(events.filter(event => event.type === 'interaction_required')).toEqual([])
    expect(events.find((event) => event.type === 'token')?.payload.text).toBe('前置说明')
  })

  it('恢复流游标出现缺口时不接受后续工具声明，保持未知结果并禁止补发整请求', async () => {
    const f = fixture([[{ type: 'token', text: '前半', cursor: { sequence: 1, reference: 'cursor-1' } }]])
    f.ports.createStreamSanitizer = () => ({ feed: (text) => text, flush: () => '', checkpoint: () => ({ kind: 'clean' }) })
    const source = f.harness.start(identity)
    while (true) {
      const event = await source.next()
      if (!event.done && event.value.type === 'token') break
    }
    await source.return(undefined as never)
    f.ports.provider.recover = vi.fn(async (_request, boundary) => ({ boundary, stream: stream([{ type: 'complete', text: '错误跨过游标', calls: [toolCall], cursor: { sequence: 3, reference: 'cursor-3' } }]) }))
    expect((await collect(createRunHarness(f.ports).resume(identity))).state).toMatchObject({ status: 'unknown', errorCode: 'provider_resume_gap' })
    expect(f.ports.tools.dispatch).not.toHaveBeenCalled()
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
  })

  it('tool_done安全详情与刷新时间线同事务，可信投影过滤私有字段后Core递归替换媒体和错误', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'completed', value: { ok: true, privateReceipt: 'opaque-synthetic-receipt' }, successful: true, mutated: false }))
    f.ports.presentToolResult = vi.fn(async (value) => ({ ok: (value as { ok: boolean }).ok, nested: [{ type: 'video', source: { data: 'synthetic-private-media' } }, { error: '/home/synthetic/private.txt' }] }))
    const { state, events } = await collect(f.harness.start(identity))
    const expected = { ok: true, nested: [{ type: 'text', text: '[视频已查看]' }, { error: '‹路径已隐藏›' }] }
    expect(events.find((event) => event.type === 'tool_done')?.payload.result).toEqual(expected)
    expect(state.displayTimeline.find((item) => item.kind === 'tool')?.toolResult).toEqual(expected)
    const committed = vi.mocked(f.ports.store.commit).mock.calls.map(([change]) => change).find((change) => change.events[0]?.type === 'tool_done')!
    expect(committed.checkpoint.displayTimeline.find((item) => item.kind === 'tool')?.toolResult).toEqual(expected)
    expect(f.ports.presentToolResult).toHaveBeenCalledWith({ ok: true, privateReceipt: 'opaque-synthetic-receipt' }, { identity, round: 1, call: toolCall })
    expect(JSON.stringify(events)).not.toContain('opaque-synthetic-receipt')
    expect(JSON.stringify(events)).not.toContain('synthetic-private-media')
  })

  it('并发结果cache先固化安全引用，重启/当前模型和展示前hydrate，durable副本不另存媒体正文', async () => {
    const calls = ['media-call', 'ask-call'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '完成', calls: [] }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 2 }))
    const media = [{ type: 'image', source: { type: 'base64', data: 'synthetic-private-current-media' } }]
    const secure = new Map<string, ToolResult>()
    f.ports.context.checkpointToolResult = vi.fn(async (scope, result) => {
      if (result.kind !== 'completed') return result
      const reference = `${scope.identity.runId}:${scope.round}:${scope.call.id}`
      secure.set(reference, result)
      return { ...result, value: { result_reference: reference } }
    })
    f.ports.context.restoreToolResult = vi.fn(async (_scope, result) => result.kind !== 'completed' ? result : secure.get((result.value as { result_reference: string }).result_reference)!)
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => call.id === 'media-call' ? { kind: 'completed', value: media, successful: true, mutated: false } : { kind: 'waiting', interaction: { id: 'intent-ask', kind: 'question', toolCall: call } })
    const first = await collect(f.harness.start(identity))
    expect(first.state.status).toBe('waiting')
    expect(f.ports.context.afterTool).toHaveBeenCalledWith(expect.anything(), calls[0], expect.objectContaining({ value: media }), 1)
    expect(JSON.stringify(vi.mocked(f.ports.store.commit).mock.calls)).not.toContain('synthetic-private-current-media')
    expect(first.state.displayTimeline.find((item) => item.toolCallId === 'media-call')?.toolResult).toEqual([{ type: 'text', text: '[图片已查看]' }])
    const final = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-ask', receiptId: 'receipt-ask', status: 'answered', value: '合成回答' }))
    expect(final.state.status).toBe('completed')
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(2)
    expect(f.ports.context.restoreToolResult).toHaveBeenCalled()
  })

  it('共用Executor已知native_failure不能被Tools吞错改成普通error，未知副作用阻止剩余工具与模型轮次', async () => {
    const calls = ['first-call', 'second-call'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    let effects = 0
    f.ports.execution.execute = vi.fn(async () => { effects++; throw new ExecutionError('native_failure', '合成后端回执丢失') })
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (_call, scope) => {
      try { await scope.execute({ id: 'request-synthetic', command: '合成命令', cwd: '/synthetic', timeoutMs: 10, destructive: false }) } catch { /* 模拟Tools误把未知原生失败映射成一般错误。 */ }
      return { kind: 'completed', value: { error: '普通错误' }, successful: false, mutated: false }
    })
    const { state } = await collect(f.harness.start(identity))
    expect(state.status).toBe('unknown')
    expect(state.remoteStatusUnknown).toBe(true)
    expect(effects).toBe(1)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
  })

  it('结束后的工具execute能力关闭，不能借detached回调跨轮或跨run执行', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    let detached!: Parameters<ToolPort['dispatch']>[1]['execute']
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (_call, scope) => { detached = scope.execute; return { kind: 'completed', value: '完成', successful: true, mutated: false } })
    await collect(f.harness.start(identity))
    await expect(detached({ id: 'request-synthetic', command: '合成命令', cwd: '/synthetic', timeoutMs: 10, destructive: false })).rejects.toMatchObject({ code: 'invalid_state' })
    expect(f.ports.execution.execute).not.toHaveBeenCalled()
  })

  it('实际工具结果无法固化时保存安全观察metadata并保留inflight，不能普通failed后继续或重执行', async () => {
    const calls = ['first-call', 'second-call'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'completed', value: '真实写入已经完成', successful: true, mutated: true }))
    f.ports.context.checkpointToolResult = vi.fn(async () => { throw new Error('synthetic-private-codec-error') })
    const result = await collect(f.harness.start(identity))
    expect(result.state).toMatchObject({ status: 'unknown', errorCode: 'tool_receipt_not_persisted', mutated: true, inflightCall: calls[0], unpersistedToolResult: { callId: 'first-call', successful: true, mutated: true } })
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('synthetic-private-codec-error')
    expect(JSON.stringify(vi.mocked(f.ports.store.commit).mock.calls)).not.toContain('真实写入已经完成')
  })

  it('artifact持久卡使用encoded稳定引用，hydrate的当前媒体不能重新写入files或display', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '完成', calls: [] }]])
    const raw = { type: 'image', source: { type: 'base64', data: 'synthetic-private-artifact-media' } }
    const reference = { type: 'attachment_ref', attach_id: 'attachment-synthetic', kind: 'image', name: '合成图片' }
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async () => ({ kind: 'completed', value: '完成', successful: true, mutated: false, artifact: raw }))
    f.ports.context.checkpointToolResult = vi.fn(async (_scope, result) => result.kind === 'completed' ? { ...result, artifact: reference } : result)
    f.ports.context.restoreToolResult = vi.fn(async (_scope, result) => result.kind === 'completed' ? { ...result, artifact: raw } : result)
    const result = await collect(f.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(result.state.files).toEqual([reference])
    expect(result.state.displayTimeline.find((item) => item.files)?.files).toEqual([reference])
    expect(JSON.stringify(result.events)).not.toContain('synthetic-private-artifact-media')
    expect(JSON.stringify(vi.mocked(f.ports.store.commit).mock.calls)).not.toContain('synthetic-private-artifact-media')
  })

  it('纯工具轮不制造空assistant占位，最终正文与非空roundTexts分开保留', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }], [{ type: 'complete', text: '最终正文', calls: [] }]])
    const { state } = await collect(f.harness.start(identity))
    expect(state.displayTimeline.map((item) => item.kind)).toEqual(['tool', 'assistant'])
    expect(state.displayTimeline.filter((item) => item.kind === 'assistant').map((item) => item.text)).toEqual(['最终正文'])
    expect(state.roundTexts).toEqual(['最终正文'])
    expect(state.text).toBe('最终正文')
  })

  it.each(['question', 'confirmation', 'credential'] as const)('expired的%s当前门error、排队门cancel，消费收据后不重投工具或模型且不写成功历史', async (kind) => {
    const calls = ['first-call', 'queued-call'].map((id) => ({ ...toolCall, id }))
    const f = fixture([[{ type: 'complete', text: '', calls }]])
    f.ports.tools.plan = vi.fn(async () => ({ mode: 'parallel' as const, maxConcurrency: 2 }))
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => ({ kind: 'waiting', interaction: { id: `intent-${call.id}`, kind: call.id === 'first-call' ? kind : 'question', toolCall: call } }))
    await collect(f.harness.start(identity))
    const result = await collect(createRunHarness(f.ports).resume(identity, { interactionId: 'intent-first-call', receiptId: 'expired-receipt', status: 'expired', value: null }))
    expect(result.state).toMatchObject({ status: 'failed', errorCode: 'interaction_expired', pending: null, queuedInteractions: [], resolutionClosure: null })
    expect(result.events.filter((event) => event.type === 'tool_done').map((event) => [event.payload.toolCallId, event.payload.status])).toEqual([['first-call', 'error'], ['queued-call', 'cancelled']])
    expect(f.receipts.has('expired-receipt')).toBe(true)
    expect(f.histories).toEqual([])
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(2)
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
  })

  it('过期收据已消费但终态尚未提交时崩溃，重启按resolutionClosure收尾而不误启动下一模型', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    f.ports.tools.dispatch = vi.fn<ToolPort['dispatch']>(async (call) => ({ kind: 'waiting', interaction: { id: 'intent-question', kind: 'question', toolCall: call } }))
    await collect(f.harness.start(identity))
    const resolving = createRunHarness(f.ports).resume(identity, { interactionId: 'intent-question', receiptId: 'expired-before-crash', status: 'expired', value: null })
    const consumed = await resolving.next()
    expect(consumed.done).toBe(false)
    expect((consumed.value as RunEvent).type).toBe('interaction_resolved')
    await resolving.return(undefined as never)
    expect(f.receipts.has('expired-before-crash')).toBe(true)
    expect(f.records.get(f.idKey(identity))!.resolutionClosure?.step).toBe('close_tools')
    const result = await collect(createRunHarness(f.ports).resume(identity))
    expect(result.state.status).toBe('failed')
    expect(result.state.errorCode).toBe('interaction_expired')
    expect(f.ports.provider.stream).toHaveBeenCalledTimes(1)
    expect(f.ports.tools.dispatch).toHaveBeenCalledTimes(1)
  })
})
