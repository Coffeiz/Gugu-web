import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CanonicalMessage, ProviderEvent } from '../../../src/agent/harness/contracts.js'
import { canonicalToolRound } from '../../../src/agent/harness/history/canonical-history.js'
import { anthropicDriver, anthropicPolicy, anthropicRequest, anthropicUsage, parseAnthropicToolInput } from '../../../src/agent/providers/anthropic.js'
import { projectAnthropicHistory, sanitizeAnthropicHistory } from '../../../src/agent/providers/anthropic-history.js'
import type { JsonObject, ProviderDriverDependencies, ProviderHttpRequest, ProviderInvocation } from '../../../src/agent/providers/contracts.js'
import { ProviderError } from '../../../src/agent/providers/errors.js'
import { record } from '../../../src/agent/providers/values.js'
import { minimaxPolicy } from '../../../src/agent/providers/vendors/policies.js'
import { streamWithRetry } from '../../../src/agent/providers/retry.js'

const scope = { ownerId: 'owner', sessionId: 'session', runId: 'run', round: 1, modelIdentity: 'model-identity', accessScopeHash: 'scope-hash' }
function invocation(extra: Partial<ProviderInvocation> = {}): ProviderInvocation {
  return { config: { provider: 'anthropic', model: 'claude-sonnet-4-6', api_key: 'synthetic-key', max_tokens: 256 }, policy: anthropicPolicy,
    history: [{ role: 'user', content: '合成问题' }], tools: [], system: '固定人格', purpose: 'chat', signal: new AbortController().signal, scope, ...extra }
}
const start = (usage: unknown = { input_tokens: 10, output_tokens: 0 }) => ({ type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage } })
const blockStart = (index: number, content_block: unknown) => ({ type: 'content_block_start', index, content_block })
const delta = (index: number, value: unknown) => ({ type: 'content_block_delta', index, delta: value })
const stop = (index: number) => ({ type: 'content_block_stop', index })
const end = { type: 'message_stop' }
function fixture(responses: readonly ({ events: readonly unknown[] } | { json: unknown })[]) {
  const requests: ProviderHttpRequest[] = [], closed: number[] = []
  const dependencies: ProviderDriverDependencies = {
    digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'), diagnose: vi.fn(),
    transport: { request: vi.fn(async request => {
      const index = requests.length; requests.push(structuredClone(request))
      const response = responses[index]
      if (!response) throw new Error('不应有额外模型请求')
      const body = 'events' in response ? response.events.map(event => `event: ${String(record(event).type)}\ndata: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(response.json)
      return { status: 200, headers: { 'content-type': 'events' in response ? 'text/event-stream' : 'application/json' },
        body: (async function* () { const bytes = new TextEncoder().encode(body); for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7) })(),
        cancel: () => { if (!closed.includes(index)) closed.push(index) } }
    }) },
  }
  return { dependencies, requests, closed }
}
async function collect(input: ProviderInvocation, deps: ProviderDriverDependencies) { const events: ProviderEvent[] = []; for await (const event of anthropicDriver.stream(input, deps)) events.push(event); return events }
function final(events: readonly ProviderEvent[]) { const value = events.findLast(event => event.type === 'complete'); if (!value || value.type !== 'complete') throw new Error('应完整结束'); return value }

describe('Anthropic真实HTTP协议边界', () => {
  it('URL推断出的Ollama策略不能授予本地网络权限，只有显式可信local/ollama配置可以', () => {
    const inferred = invocation({ config: { provider: 'custom', model: 'synthetic', base_url: 'http://synthetic-ollama.example:11434' }, policy: { ...anthropicPolicy, name: 'ollama' } })
    expect(anthropicRequest(inferred, false).allowLocal).toBe(false)
    expect(anthropicRequest({ ...inferred, config: { ...inferred.config, provider: ' Local ' } }, false).allowLocal).toBe(true)
  })
  it('流拼接多工具JSON和原始键序，工具名按已知分隔符清洗，用量包含cache read/write', async () => {
    const f = fixture([{ events: [start({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }),
      blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: '正在读取' }), stop(0),
      blockStart(1, { type: 'tool_use', id: 'tool-a', name: 'lookup]<]minimax[', input: {} }),
      delta(1, { type: 'input_json_delta', partial_json: '{"z":1,' }), delta(1, { type: 'input_json_delta', partial_json: '"a":"合成"}' }), stop(1),
      blockStart(2, { type: 'tool_use', id: 'tool-b', name: 'read', input: { path: 'relative/file' } }), stop(2),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }, end ] }])
    const events = await collect(invocation({ tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }), f.dependencies)
    expect(events.filter(event => event.type === 'token')).toEqual([{ type: 'token', text: '正在读取' }])
    expect(final(events)).toMatchObject({ text: '正在读取', finishReason: 'tool_use', calls: [
      { id: 'tool-a', name: 'lookup', input: { z: 1, a: '合成' }, rawArguments: '{"z":1,"a":"合成"}' },
      { id: 'tool-b', name: 'read', input: { path: 'relative/file' } },
    ] })
    expect(events.filter(event => event.type === 'usage').at(-1)).toMatchObject({ usage: { input: 10, cacheRead: 30, cacheWrite: 5, contextInput: 45, output: 8 } })
    expect(f.requests[0]).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': 'synthetic-key', 'anthropic-version': '2023-06-01' }, body: {
      model: 'claude-sonnet-4-6', stream: true, system: [{ type: 'text', text: '固定人格', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    } })
    expect(f.closed).toEqual([0])
  })

  it.each(['content_block_stop', 'content_block_delta', 'empty_tool_delta'])('缺块%s尚无正文时只用相同参数非流式恢复一次，恢复正文进入正常事件链', async type => {
    const eventType = type === 'empty_tool_delta' ? 'content_block_delta' : type
    const emptyDelta = type === 'empty_tool_delta' ? { type: 'input_json_delta', partial_json: '' } : { type: 'text_delta', text: '' }
    const f = fixture([{ events: [start(), { type: eventType, index: 0, ...(eventType.endsWith('delta') ? { delta: emptyDelta } : {}) }] },
      { json: { content: [{ type: 'text', text: '恢复完成' }, { type: 'tool_use', id: 'recovered', name: 'lookup', input: { q: '合成' } }], stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 5 } } }])
    const events = await collect(invocation(), f.dependencies)
    expect(events.filter(event => event.type === 'token')).toEqual([{ type: 'token', text: '恢复完成' }])
    expect(final(events).calls).toHaveLength(1)
    const first = structuredClone(f.requests[0]!.body) as JsonObject; delete first.stream
    expect(f.requests[1]!.body).toEqual(first)
    expect(f.requests).toHaveLength(2); expect(f.closed).toEqual([0, 1])
  })

  it('content_block_stop在message_start之前是SDK事件顺序错误，不冒充已知缺块进行恢复', async () => {
    const f = fixture([{ events: [{ type: 'content_block_stop', index: 0 }] }])
    await expect(collect(invocation({ config: { provider: 'minimax', model: 'MiniMax-M3' }, policy: minimaxPolicy }), f.dependencies))
      .rejects.toMatchObject({ code: 'protocol', options: { retryable: false } })
    expect(f.requests).toHaveLength(1); expect(f.closed).toEqual([0])
  })

  it.each([
    { type: 'text_delta', text: '已收到但因缺块未发布的正文' },
    { type: 'input_json_delta', partial_json: '{"query":' },
    { type: 'thinking_delta', thinking: '私有推理片段' },
    { type: 'signature_delta', signature: 'synthetic-signature' },
  ])('缺块delta已携%s片段时先记录输出事实，再失败且禁止非流或普通重放', async fragment => {
    const f = fixture([{ events: [start(), delta(0, fragment)] }]), input = invocation()
    const events: ProviderEvent[] = []
    await expect((async () => { for await (const event of streamWithRetry(() => anthropicDriver.stream(input, f.dependencies), input.signal)) events.push(event) })())
      .rejects.toMatchObject({ code: 'protocol', options: { outputStarted: true, retryable: false } })
    expect(f.requests).toHaveLength(1)
    expect(events.filter(event => event.type === 'token' || event.type === 'retry' || event.type === 'complete')).toEqual([])
    expect(JSON.stringify(events)).not.toContain('synthetic-signature')
    expect(f.closed).toEqual([0])
  })

  it('已输出正文再缺块不重放；恢复请求失败也不暴露原始错误或重新进入重试', async () => {
    const visible = fixture([{ events: [start(), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: '已输出' }), { type: 'content_block_stop', index: 1 }] }])
    const seen: ProviderEvent[] = []
    await expect((async () => { for await (const event of anthropicDriver.stream(invocation(), visible.dependencies)) seen.push(event) })()).rejects.toMatchObject({ code: 'protocol', options: { outputStarted: true, retryable: false } })
    expect(seen.filter(event => event.type === 'token')).toEqual([{ type: 'token', text: '已输出' }])
    expect(visible.requests).toHaveLength(1)
    const failure = fixture([{ events: [start(), { type: 'content_block_stop', index: 0 }] }])
    const request = failure.dependencies.transport.request
    failure.dependencies.transport.request = vi.fn(async (value, signal) => {
      if (failure.requests.length) throw new ProviderError('timeout', { retryable: true })
      return request(value, signal)
    })
    await expect(collect(invocation(), failure.dependencies)).rejects.toMatchObject({ code: 'timeout', options: { retryable: false } })
    expect(failure.dependencies.transport.request).toHaveBeenCalledTimes(2)
  })

  it('EOF不能冒充空成功，正常空message_stop保留空答供Harness重试', async () => {
    const missing = fixture([{ events: [start()] }])
    await expect(collect(invocation(), missing.dependencies)).rejects.toMatchObject({ code: 'stream_incomplete' })
    const empty = fixture([{ events: [start(), end] }])
    expect(final(await collect(invocation(), empty.dependencies))).toMatchObject({ text: '', calls: [] })
    expect(empty.requests).toHaveLength(1)
    const unknown = fixture([{ events: [start(null), end] }])
    expect((await collect(invocation(), unknown.dependencies)).filter(event => event.type === 'usage').at(-1)).toMatchObject({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null } })
  })

  it.each([
    { events: [blockStart(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: '私有片段' })] },
    { events: [blockStart(0, { type: 'tool_use', id: 'partial', name: 'lookup', input: {} }), delta(0, { type: 'input_json_delta', partial_json: '{"q":' })] },
  ])('已有私有或工具片段后的坏流不因尚无可见token而重放：%j', async ({ events }) => {
    const f = fixture([{ events: [start(), ...events, { type: 'content_block_stop', index: 1 }] }])
    await expect(collect(invocation(), f.dependencies)).rejects.toMatchObject({ options: { outputStarted: true, retryable: false } })
    expect(f.requests).toHaveLength(1)
  })

  it('消费者提前结束会关闭HTTP流，外部取消后不再交付新token', async () => {
    const f = fixture([{ events: [start(), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: '一' }), delta(0, { type: 'text_delta', text: '二' }), stop(0), end] }])
    const control = new AbortController(), stream = anthropicDriver.stream(invocation({ signal: control.signal }), f.dependencies)[Symbol.asyncIterator]()
    await stream.next(); expect((await stream.next()).value).toMatchObject({ type: 'token', text: '一' })
    control.abort()
    await expect(stream.next()).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.closed).toEqual([0])
    const early = fixture([{ events: [start(), end] }])
    for await (const _event of anthropicDriver.stream(invocation(), early.dependencies)) break
    expect(early.closed).toEqual([0])
  })

  it.each([1, 5, 6])('真实Anthropic读取超时%i次遵循五次重试和5秒间隔，成功缺报usage不能借失败attempt', async failTimes => {
    const failed = { events: [start()] }, successful = { events: [start(null), blockStart(0, { type: 'text', text: '成功' }), stop(0), end] }
    const f = fixture([...Array.from({ length: failTimes }, () => failed), successful])
    const original = f.dependencies.transport.request
    let elapsed = 0
    f.dependencies.transport.request = vi.fn(async (request, signal) => {
      const response = await original(request, signal), failed = f.requests.length <= failTimes
      if (!failed) return response
      const body = response.body
      return { ...response, body: (async function* () {
        yield* body
        elapsed += 120_000
        throw new ProviderError('timeout', { retryable: true, requestStarted: true })
      })() }
    })
    const input = invocation(), events: ProviderEvent[] = [], sleeps: number[] = []
    const run = async () => { for await (const event of streamWithRetry(() => anthropicDriver.stream(input, f.dependencies), input.signal, {
      clock: { now: () => elapsed, sleep: async ms => { sleeps.push(ms); elapsed += ms } },
    })) events.push(event) }
    if (failTimes === 6) await expect(run()).rejects.toMatchObject({ code: 'timeout' })
    else { await run(); expect(final(events).text).toBe('成功'); expect(events.filter(event => event.type === 'usage').at(-1)).toMatchObject({ usage: { contextInput: null } }) }
    expect(f.requests).toHaveLength(Math.min(failTimes + 1, 6))
    expect(events.filter(event => event.type === 'retry').map(event => event.type === 'retry' ? event.attempt : 0)).toEqual(Array.from({ length: Math.min(failTimes, 5) }, (_, index) => index + 1))
    expect(sleeps).toEqual(Array.from({ length: Math.min(failTimes, 5) }, () => 5000))
    expect(events.filter(event => event.type === 'retry').every(event => event.type === 'retry' && event.errorCode === 'timeout')).toBe(true)
    expect(f.closed).toHaveLength(f.requests.length)
  })

  it('Anthropic重试墙钟先于次数用尽，已出正文后读超时不重发或重复token', async () => {
    for (const emitted of [false, true]) {
      const f = fixture([{ events: emitted ? [start(), blockStart(0, { type: 'text', text: 'hello' })] : [start()] }])
      const original = f.dependencies.transport.request
      let elapsed = 0
      f.dependencies.transport.request = vi.fn(async (request, signal) => {
        const response = await original(request, signal), body = response.body
        return { ...response, body: (async function* () { yield* body; elapsed += 100_000; throw new ProviderError('timeout', { retryable: true }) })() }
      })
      const input = invocation(), events: ProviderEvent[] = [], sleep = vi.fn(async () => undefined)
      await expect((async () => { for await (const event of streamWithRetry(() => anthropicDriver.stream(input, f.dependencies), input.signal,
        { clock: { now: () => elapsed, sleep }, maxWallMs: emitted ? 900_000 : 60_000 })) events.push(event) })()).rejects.toMatchObject({ code: 'timeout' })
      expect(f.requests).toHaveLength(1); expect(sleep).not.toHaveBeenCalled()
      expect(events.filter(event => event.type === 'token').map(event => event.type === 'token' ? event.text : '')).toEqual(emitted ? ['hello'] : [])
      expect(f.closed).toEqual([0])
    }
  })

  it.each([anthropicPolicy, minimaxPolicy])('未知程序异常不能因%s策略而盲重试，也不能把原始错误暴露给Harness', async policy => {
    const input = invocation({ policy }), request = vi.fn(async () => { throw new TypeError('私有程序异常细节') })
    const dependencies: ProviderDriverDependencies = { digest: value => JSON.stringify(value), diagnose: vi.fn(), transport: { request } }
    const events: ProviderEvent[] = []
    await expect((async () => { for await (const event of streamWithRetry(() => anthropicDriver.stream(input, dependencies), input.signal)) events.push(event) })()).rejects.toMatchObject({ code: 'upstream', options: { retryable: false } })
    expect(request).toHaveBeenCalledTimes(1)
    expect(events.filter(event => event.type === 'retry' || event.type === 'token')).toEqual([])
    expect(JSON.stringify(events)).not.toContain('私有程序异常细节')
  })

  it('HTTP200的SSE上游错误只给固定安全分类，超限不被当成普通可重试故障', async () => {
    const f = fixture([{ events: [{ type: 'error', error: { type: 'invalid_request_error', message: 'maximum context length exceeded；secret-key；私有正文' } }] }])
    await expect(collect(invocation(), f.dependencies)).rejects.toMatchObject({ code: 'context_overflow', options: { retryable: false } })
    try { await collect(invocation(), fixture([{ events: [{ type: 'error', error: { type: 'overloaded_error', message: '私有上游故障' } }] }]).dependencies) }
    catch (error) { expect(error).toMatchObject({ code: 'busy' }); expect(JSON.stringify(error)).not.toContain('私有') }
  })

  it.each([['1000', 'busy', true], ['1001', 'timeout', true], ['1002', 'rate_limit', true], ['1024', 'busy', true], ['1033', 'busy', true], ['2013', 'input_rejected', false], ['1004', 'authentication', false]] as const)('MiniMax Anthropic HTTP200 SSE业务码%s按真实厂商策略分类而不泄漏错误正文', async (code, expected, retryable) => {
    const f = fixture([{ events: [{ type: 'error', error: { type: 'api_error', message: `私有上游正文 (${code})` } }] }])
    const input = invocation({ config: { provider: 'minimax', model: 'MiniMax-M3', api_key: 'synthetic-key' }, policy: minimaxPolicy })
    await expect(collect(input, f.dependencies)).rejects.toMatchObject({ code: expected, options: { retryable } })
    expect(f.requests[0]!.url).toBe('https://api.minimaxi.com/anthropic/v1/messages')
  })

  it('非流式分支原样使用带签名wire，既有history的JSON分支不改变主请求参数或工具', async () => {
    const history: JsonObject[] = [{ role: 'assistant', content: [{ type: 'thinking', thinking: '私有推理', signature: 'synthetic-signature' }, { type: 'text', text: '历史答复' }] }, { role: 'user', content: '分支任务' }]
    const wireSystem: JsonObject[] = [{ type: 'text', text: '固定人格', cache_control: { type: 'ephemeral', ttl: '1h' } }]
    const original = structuredClone(history), f = fixture([{ json: { content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 4, output_tokens: 3 }, stop_reason: 'end_turn' } }])
    const result = await anthropicDriver.complete(invocation({ history, wireSystem, purpose: 'branch', hasHistory: true, outputMode: 'json', tools: [{ name: 'lookup', input_schema: { type: 'object' } }] }), f.dependencies)
    expect(result.text).toBe('{"ok":true}')
    expect(result.continuation).toBeUndefined()
    expect(record(f.requests[0]!.body).messages).toEqual(history)
    expect(record(f.requests[0]!.body).system).toEqual(wireSystem)
    expect(record(f.requests[0]!.body).tools).toEqual([{ name: 'lookup', input_schema: { type: 'object' } }])
    expect(record(f.requests[0]!.body)).not.toHaveProperty('tool_choice')
    expect(record(f.requests[0]!.body)).not.toHaveProperty('response_format')
    expect(history).toEqual(original)
  })

  it('真实工具流截断只保留已完成参数并标明max_tokens，不能伪装正常工具终态', async () => {
    const f = fixture([{ events: [start(), blockStart(0, { type: 'tool_use', id: 'partial', name: 'lookup', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"complete":1,"pending":"尚未完成' }), stop(0),
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 256 } }, end] }])
    expect(final(await collect(invocation(), f.dependencies))).toMatchObject({ calls: [{ id: 'partial', input: { complete: 1 }, rawArguments: '{"complete":1}' }],
      finishReason: 'max_tokens', incompleteReason: 'max_tokens' })
    expect(f.requests).toHaveLength(1)
  })

  it('原始usage保留厂商元数据并合并最终output，只经探针交付且sink改写或失败不影响事件', async () => {
    const raw = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, provider_cache_details: { request_class: 'synthetic' } }
    const f = fixture([{ events: [start(raw), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7, vendor_queue_ms: 12 } }, end] }])
    const reports: { raw: unknown; usage: unknown }[] = []
    const dependencies: ProviderDriverDependencies = { ...f.dependencies, onUsage(value, normalized) {
      reports.push(structuredClone({ raw: value, usage: normalized }))
      record(value).input_tokens = 999; record(normalized).input = 999
      throw new Error('合成探针写入失败')
    } }
    const events = await collect(invocation(), dependencies)
    expect(final(events).text).toBe('')
    expect(reports.at(-1)).toEqual({ raw: { ...raw, output_tokens: 7, vendor_queue_ms: 12 }, usage: { input: 10, output: 7, cacheRead: 20, cacheWrite: 3, contextInput: 33 } })
    expect(events.filter(event => event.type === 'usage').at(-1)).toMatchObject({ usage: { input: 10, output: 7, contextInput: 33 } })
    expect(JSON.stringify(events)).not.toContain('provider_cache_details'); expect(JSON.stringify(events)).not.toContain('合成探针写入失败')
    expect(dependencies.diagnose).toHaveBeenCalledWith('provider_usage_sink', expect.any(Error))
  })

  it('非流式实际raw usage与unknown分别交探针，显式null预算沿Python高预算而不回落配置', async () => {
    const raw = { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 8, vendor_latency_ms: 11 }
    const f = fixture([{ json: { content: [{ type: 'text', text: '完成' }], usage: raw } }, { json: { content: [] } }])
    const reports: { raw: unknown; usage: unknown }[] = []
    const dependencies: ProviderDriverDependencies = { ...f.dependencies, onUsage: (value, usage) => reports.push({ raw: value, usage }) }
    const input = invocation({ system: '', tools: [], purpose: 'branch', maxOutputTokens: null })
    const originalConfig = structuredClone(input.config)
    const completed = await anthropicDriver.complete(input, dependencies)
    expect(completed.text).toBe('完成'); expect(record(f.requests[0]!.body).max_tokens).toBe(32768)
    expect(record(f.requests[0]!.body)).not.toHaveProperty('system'); expect(record(f.requests[0]!.body)).not.toHaveProperty('tools')
    expect(reports[0]).toEqual({ raw, usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 8, contextInput: 11 } })
    await anthropicDriver.complete(input, dependencies)
    expect(reports[1]).toEqual({ raw: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null } })
    expect(input.config).toEqual(originalConfig)
  })

  it.each(['chat', 'standalone'] as const)('Anthropic %s不支持真正不限输出，显式null在发送前拒绝而非悄悄扩大预算', purpose => {
    expect(() => anthropicRequest(invocation({ purpose, maxOutputTokens: null }), purpose === 'chat')).toThrowError(ProviderError)
  })

  it('分支系统缓存按同一厂商能力生成，thinking与generation参数跟随主请求策略而不手拼', () => {
    const inactive = anthropicRequest(invocation({ config: { provider: 'minimax', model: 'MiniMax-M1' }, policy: minimaxPolicy, purpose: 'branch' }), false)
    expect(record(inactive.body).system).toBe('固定人格')
    const active = anthropicRequest(invocation({ purpose: 'branch' }), false)
    expect(record(active.body).system).toEqual([{ type: 'text', text: '固定人格', cache_control: { type: 'ephemeral' } }])
    expect(record(active.body)).not.toHaveProperty('tools')
    const minimax = anthropicRequest(invocation({ config: { provider: 'minimax', model: 'MiniMax-M3', thinking: 'adaptive' }, policy: minimaxPolicy, purpose: 'branch' }), false)
    expect(record(minimax.body)).not.toHaveProperty('thinking')
    const policy = { ...anthropicPolicy, parameters: () => ({ thinking: { type: 'enabled' }, metadata: { x: 1 } }) }
    for (const purpose of ['chat', 'branch'] as const) {
      const body = record(anthropicRequest(invocation({ policy, purpose }), purpose === 'chat').body)
      expect(body.thinking).toEqual({ type: 'enabled' }); expect(body.metadata).toEqual({ x: 1 })
    }
  })
})

describe('Anthropic能力、历史与私有续接', () => {
  it.each([anthropicPolicy, minimaxPolicy])('消息级system reminder按%s转user后仍与真实输入保持独立边界', policy => {
    const input: CanonicalMessage[] = [{ role: 'system', content: '[system-reminder]\n时间\n[/system-reminder]' }, { role: 'user', content: '继续' }]
    const original = structuredClone(input), projected = projectAnthropicHistory(input, invocation().config, policy)
    expect(projected.map(message => message.role)).toEqual(['user', 'user'])
    expect(projected.map(message => message.content)).toEqual([[{ type: 'text', text: '[system-reminder]\n时间\n[/system-reminder]' }], [{ type: 'text', text: '继续' }]])
    expect(input).toEqual(original)
  })

  it('默认只在发送副本剥原生thinking，正文与成对工具仍保留；同协议显式wire投影可保签名', () => {
    const thinking = { type: 'thinking', thinking: '私有推理', signature: 'synthetic-signature' }
    const messages: CanonicalMessage[] = [{ role: 'assistant', content: [thinking, { type: 'text', text: '回答' }, { type: 'tool_call', id: 'paired', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'paired', content: '结果' }] }]
    const original = structuredClone(messages)
    const plain = projectAnthropicHistory(messages, invocation().config, anthropicPolicy)
    const native = projectAnthropicHistory(messages, invocation().config, anthropicPolicy, { preserveNativeThinking: true })
    expect(plain[0]!.content).toEqual([{ type: 'text', text: '回答' }, { type: 'tool_use', id: 'paired', name: 'lookup', input: {} }])
    expect(native[0]!.content).toEqual([thinking, ...(plain[0]!.content as JsonObject[])])
    expect(native[1]).toEqual(plain[1]); expect(messages).toEqual(original)
  })
  it.each([
    ['claude-opus-4-7', ['low', 'medium', 'high']], ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh']],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']], ['claude-fable-5', []],
  ] as const)('官方%s能力档位按模型声明，代理域不冒充官方支持', (model, efforts) => {
    const config = { provider: 'anthropic', model, thinking: 'adaptive', reasoning_effort: 'xhigh' }
    expect(anthropicPolicy.reasoningCapabilities(config, 'anthropic')).toMatchObject({ modes: ['adaptive'], efforts, supports_adaptive_thinking: true })
    expect(anthropicPolicy.reasoningCapabilities({ ...config, base_url: 'https://proxy.example/v1' }, 'anthropic').efforts).toEqual([])
    expect(anthropicPolicy.parameters({ ...config, base_url: 'https://proxy.example/v1' }, 'anthropic', 'chat')).toEqual({ thinking: { type: 'adaptive' } })
  })

  it('history转换原始字符串参数为对象、system转user、按相邻位置移除孤儿且不修改原历史', () => {
    const messages: CanonicalMessage[] = [{ role: 'system', content: '快照' },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'same', content: '孤儿' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'same', name: 'read', arguments: '{"z":1,"a":2}' }, { type: 'tool_call', id: 'unprocessed', name: 'write', arguments: '错误参数' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'same', content: '{"error":"合成失败"}' }] },
      { role: 'user', content: [{ type: 'tool-schema', tool_name: 'read', schema: { name: 'read' } }] }]
    const original = structuredClone(messages), rendered = projectAnthropicHistory(messages, invocation().config, anthropicPolicy)
    expect(rendered).toHaveLength(4)
    expect(rendered[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '快照' }] })
    expect(rendered[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'read', input: { z: 1, a: 2 } }] })
    expect(rendered[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: '{"error":"合成失败"}', is_error: true }] })
    expect(JSON.stringify(rendered[3])).toContain('canonical tool-schema')
    expect(messages).toEqual(original)
    expect(sanitizeAnthropicHistory(rendered)).toEqual(rendered)
  })

  it('当前图片保持媒体不文本化，不支持的音视频明确拒绝', () => {
    const image: CanonicalMessage = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }
    expect(projectAnthropicHistory([image], { ...invocation().config, image: true }, anthropicPolicy)[0]!.content).toEqual(image.content)
    expect(() => projectAnthropicHistory([{ role: 'user', content: [{ type: 'video', source: 'synthetic-video' }] }], invocation().config, anthropicPolicy)).toThrowError(ProviderError)
  })

  it.each(['不是JSON', '[1,2]', 'null'])('旧历史参数%s仅在投影副本中转空对象，配对结果及原字节保留', argumentsText => {
    const history: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call', name: 'lookup', arguments: argumentsText }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call', content: '结果' }] },
    ]
    const original = structuredClone(history)
    expect(projectAnthropicHistory(history, invocation().config, anthropicPolicy)).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: '结果' }] },
    ])
    expect(history).toEqual(original)
  })

  it('分支修复孤儿时保留原生签名和redacted块，清除外协议推理且不改字符串形状', async () => {
    const native = { type: 'thinking', thinking: '合成推理', signature: 'synthetic-signature' }
    const redacted = { type: 'redacted_thinking', data: 'synthetic-redacted' }
    const history: JsonObject[] = [{ role: 'user', content: '旧问题' }, { role: 'user', content: [{ type: 'text', text: '继续' }, { type: 'tool_result', tool_use_id: 'orphan', content: '旧结果' }] },
      { role: 'assistant', content: [native, redacted, { type: 'reasoning_content', text: '外协议推理' }, { type: 'tool_use', id: 'paired', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'paired', content: '实际结果' }] }, { role: 'assistant', content: [{ type: 'reasoning_content', text: '只有外协议推理' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'unfinished', name: 'lookup', input: {} }] }]
    const original = structuredClone(history), f = fixture([{ json: { content: [], stop_reason: 'end_turn' } }])
    await anthropicDriver.complete(invocation({ history, hasHistory: true, purpose: 'branch' }), f.dependencies)
    expect(record(f.requests[0]!.body).messages).toEqual([
      { role: 'user', content: '旧问题' }, { role: 'user', content: [{ type: 'text', text: '继续' }] },
      { role: 'assistant', content: [native, redacted, { type: 'tool_use', id: 'paired', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'paired', content: '实际结果' }] },
    ])
    expect(history).toEqual(original)
  })

  it('thinking与多段text原位恢复且未派发工具不复活，跨owner绑定失败不复用', async () => {
    const f = fixture([{ events: [start(), blockStart(0, { type: 'text', text: '查询' }), stop(0),
      blockStart(1, { type: 'thinking', thinking: '' }), delta(1, { type: 'thinking_delta', thinking: '私有推理' }), delta(1, { type: 'signature_delta', signature: 'synthetic-signature' }), stop(1),
      blockStart(2, { type: 'text', text: '后续说明' }), stop(2),
      blockStart(3, { type: 'tool_use', id: 'call', name: 'lookup', input: { z: 1, a: 2 } }), stop(3),
      blockStart(4, { type: 'tool_use', id: 'unprocessed', name: 'write', input: {} }), stop(4), end] },
      { json: { content: [{ type: 'text', text: '下一轮' }], usage: { input_tokens: 2 }, stop_reason: 'end_turn' } },
      { json: { content: [], stop_reason: 'end_turn' } }])
    const continuation = final(await collect(invocation(), f.dependencies)).continuation
    const messages: CanonicalMessage[] = [{ role: 'user', content: '问题' },
      { role: 'assistant', content: [{ type: 'text', text: '查询后续说明' }, { type: 'tool_call', id: 'call', name: 'lookup', arguments: '{"z":1,"a":2}' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call', content: '实际回执' }] }]
    const history = projectAnthropicHistory(messages, invocation().config, anthropicPolicy), original = structuredClone(history)
    await anthropicDriver.complete(invocation({ history, continuation, scope: { ...scope, round: 2 } }), f.dependencies)
    const sent = record(f.requests[1]!.body).messages as JsonObject[]
    expect(sent[1]!.content).toEqual([{ type: 'text', text: '查询' }, { type: 'thinking', thinking: '私有推理', signature: 'synthetic-signature' }, { type: 'text', text: '后续说明' }, { type: 'tool_use', id: 'call', name: 'lookup', input: { z: 1, a: 2 } }])
    expect(history).toEqual(original)
    expect(JSON.stringify(messages)).not.toContain('synthetic-signature')
    await anthropicDriver.complete(invocation({ history, continuation, scope: { ...scope, ownerId: 'other' } }), f.dependencies)
    expect(JSON.stringify(record(f.requests[2]!.body).messages)).not.toContain('synthetic-signature')
  })

  it.each([{ max_results: 15, query: '合成记录', filters: { z: null, a: [1, { z: 2, a: 3 }] } }, {}] as JsonObject[])('真实驱动参数%j经Canonical和键排序后回放保持原字节序，错误工具结果与Canonical一致', async argumentsValue => {
    const f = fixture([{ events: [start(), blockStart(0, { type: 'tool_use', id: 'call', name: 'lookup', input: argumentsValue }), stop(0), end] },
      { json: { content: [], stop_reason: 'end_turn' } }])
    const tool = final(await collect(invocation(), f.dependencies)).calls[0]!
    const error = '{"error":"合成路径错误"}'
    const canonical = canonicalToolRound({ text: '', calls: [{ ...tool, input: argumentsValue }], dispatched: [{ callId: tool.id, content: error, isError: true }] })
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, reorder(item)])) : value
    const restored = reorder(canonical) as CanonicalMessage[]
    const history = projectAnthropicHistory(restored, invocation().config, anthropicPolicy)
    await anthropicDriver.complete(invocation({ history }), f.dependencies)
    const outbound = record(f.requests[1]!.body).messages as JsonObject[]
    expect(JSON.stringify(record((outbound[0]!.content as JsonObject[])[0]).input)).toBe(JSON.stringify(argumentsValue))
    expect(outbound[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: error, is_error: true }] })
    expect((canonical[1]!.content as JsonObject[])[0]).toMatchObject({ tool_call_id: tool.id, content: error, is_error: true })
    expect(canonical[0]!.content).toEqual([{ type: 'tool_call', id: 'call', name: 'lookup', arguments: JSON.stringify(argumentsValue) }])
  })

  it('三轮已持久Canonical工具恢复各自签名且重复恢复幂等，跨Run重建剔除历史外续接call', async () => {
    const response = (index: number) => ({ events: [start(), blockStart(0, { type: 'text', text: `前文${index}` }), stop(0),
      blockStart(1, { type: 'thinking', thinking: `检查步骤${index}`, signature: `signature-${index}` }), stop(1),
      blockStart(2, { type: 'text', text: `后文${index}` }), stop(2),
      blockStart(3, { type: 'tool_use', id: `call-${index}`, name: 'lookup', input: { query: `合成${index}` } }), stop(3), end] })
    const f = fixture([response(0), response(1), response(2), { json: { content: [], stop_reason: 'end_turn' } }, { json: { content: [], stop_reason: 'end_turn' } }])
    const canonical: CanonicalMessage[] = [{ role: 'user', content: '检查工具' }]
    let continuation: unknown
    for (let index = 0; index < 3; index++) {
      const history = projectAnthropicHistory(canonical, invocation().config, anthropicPolicy)
      const completed = final(await collect(invocation({ history, continuation, scope: { ...scope, round: index + 1 } }), f.dependencies))
      continuation = completed.continuation
      const expectedCalls = Array.from({ length: index + 1 }, (_, round) => `call-${round}`)
      const payload = record(record(continuation).payload)
      expect(Object.keys(record(payload.history_thinking_by_tool_id))).toEqual(expectedCalls)
      expect(Object.keys(record(payload.history_response_blocks_by_tool_id))).toEqual(expectedCalls)
      const call = completed.calls[0]!
      canonical.push(...canonicalToolRound({ text: completed.text, calls: [{ ...call, input: record(call.input) as JsonObject }], dispatched: [{ callId: call.id, content: '实际工具结果' }] }))
    }
    const history = projectAnthropicHistory(canonical, invocation().config, anthropicPolicy), original = structuredClone(canonical), originalDigest = f.dependencies.digest(canonical)
    const lastAssistant = history.findLast(message => message.role === 'assistant')!
    const lastBlocks = lastAssistant.content as JsonObject[]
    lastBlocks[lastBlocks.length - 1] = { ...lastBlocks.at(-1)!, cache_control: { type: 'ephemeral' } }
    history.push({ role: 'user', content: '未标缓存的最终分支任务' })
    const originalHistory = structuredClone(history), historyDigest = f.dependencies.digest(history)
    record(record(continuation).payload).history_thinking_by_tool_id = { ...record(record(record(continuation).payload).history_thinking_by_tool_id), 'removed-call': [{ type: 'thinking', thinking: '已压缩', signature: 'removed-signature' }] }
    let restoredHistory = history
    for (let restore = 0; restore < 2; restore++) {
      const beforeRestore = structuredClone(restoredHistory), beforeDigest = f.dependencies.digest(restoredHistory)
      const completed = await anthropicDriver.complete(invocation({ history: restoredHistory, continuation, purpose: 'branch', hasHistory: true, scope: { ...scope, runId: 'next-run', round: restore + 1 } }), f.dependencies)
      const sent = record(f.requests[3 + restore]!.body).messages as JsonObject[]
      const assistants = sent.filter(message => message.role === 'assistant')
      expect(assistants).toHaveLength(3)
      assistants.forEach((message, index) => expect(message.content).toEqual([{ type: 'text', text: `前文${index}` },
        { type: 'thinking', thinking: `检查步骤${index}`, signature: `signature-${index}` }, { type: 'text', text: `后文${index}` },
        { type: 'tool_use', id: `call-${index}`, name: 'lookup', input: { query: `合成${index}` }, ...(index === 2 ? { cache_control: { type: 'ephemeral' } } : {}) }]))
      expect(sent.at(-1)).toEqual({ role: 'user', content: '未标缓存的最终分支任务' })
      expect(JSON.stringify(completed.continuation)).not.toContain('removed-call')
      const payload = record(record(completed.continuation).payload)
      expect(Object.keys(record(payload.history_thinking_by_tool_id))).toEqual(['call-0', 'call-1', 'call-2'])
      expect(Object.keys(record(payload.history_response_blocks_by_tool_id))).toEqual(['call-0', 'call-1', 'call-2'])
      expect(Object.values(record(payload.history_thinking_by_tool_id)).reduce<number>((count, blocks) => count + (blocks as JsonObject[]).length, 0)).toBe(3)
      expect(restoredHistory).toEqual(beforeRestore); expect(f.dependencies.digest(restoredHistory)).toBe(beforeDigest)
      continuation = completed.continuation
      restoredHistory = sent
    }
    expect(record(f.requests[4]!.body).messages).toEqual(record(f.requests[3]!.body).messages)
    expect(history).toEqual(originalHistory); expect(f.dependencies.digest(history)).toBe(historyDigest)
    expect(JSON.stringify(canonical)).not.toContain('signature-'); expect(canonical).toEqual(original)
    expect(f.dependencies.digest(canonical)).toBe(originalDigest)
  })

  it.each([['{"a":"合成', {}], ['{"a":[1,2', { a: [1, 2] }], ['{"a":1,', { a: 1 }], ['{', {}], ['{"a":1,"b":', { a: 1 }], ['{"a": tru', {}],
    ['{"a":1]', { a: 1 }], ['{"a":trueX', { a: true }], ['{"a":1x', { a: 1 }], ['{"a":1]junk', { a: 1 }], ['{"a":1}junk', { a: 1 }], ['{"a":[1,2}', { a: [1, 2] }],
  ])('SDK有限partial模式%s保留完成值而不猜测字段', (value, expected) => {
    expect(parseAnthropicToolInput(String(value))).toEqual(expected)
  })
  it.each(['不是JSON', '{"a":+1', '{"a":"\\q', '{"a":1,}'])('非法参数%s明确拒绝', value => {
    expect(() => parseAnthropicToolInput(value)).toThrowError(ProviderError)
  })
  it('缺失用量保持未知，cache写入也计入真实输入且不累计上一轮', () => {
    expect(anthropicUsage(null).contextInput).toBeNull()
    expect(anthropicUsage({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 })).toEqual({ input: 10, cacheRead: 20, cacheWrite: 3, output: 0, contextInput: 33 })
  })
})
