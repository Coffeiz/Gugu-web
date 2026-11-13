import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CanonicalContextPorts, HarnessPorts } from '../../../src/agent/harness/ports.js'
import type { CanonicalHarnessContext, Json, ProviderEvent } from '../../../src/agent/harness/contracts.js'
import { createCanonicalContextPort, createCanonicalHarness, isEarlyExit, stableJson } from '../../../src/agent/harness/index.js'
import { connectProviderHarness } from '../../../src/agent/providers/runtime.js'
import { ProviderError, classifyProviderError } from '../../../src/agent/providers/errors.js'
import { openaiPolicy } from '../../../src/agent/providers/openai.js'
import { streamWithRetry } from '../../../src/agent/providers/retry.js'
import { InProcessPrefixCoordinator, providerCacheSupported } from '../../../src/agent/providers/cache.js'
import type { PrefixCoordinator } from '../../../src/agent/providers/cache.js'
import { ProviderClientPool, providerConfigKey } from '../../../src/agent/providers/client-pool.js'
import { ProviderStreamSanitizer, stripThinking } from '../../../src/agent/providers/sanitize.js'
import { runContextBranch } from '../../../src/agent/harness/context/reflection.js'
import type { JsonObject, ProviderHttpRequest, ProviderTransport } from '../../../src/agent/providers/contracts.js'
import type { ProviderConfig, ProviderWire } from '../../../src/agent/providers/contracts.js'
import type { ProviderProbeSink } from '../../../src/agent/providers/cache-probe.js'
import { RequestProbe } from '../../../src/agent/providers/cache-probe.js'
import { requestJson } from '../../../src/agent/providers/http.js'
import { listProviderModels, normalizedApiKey, providerDiagnosticRequest } from '../../../src/agent/providers/diagnostics.js'
import { fixture, identity, collect, deferred } from '../harness/run/fixtures.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const encode = (text: string) => new TextEncoder().encode(text)
async function* collectSource<T>(values: readonly T[]) { yield* values }
async function all(source: AsyncIterable<ProviderEvent>) { const result: ProviderEvent[] = []; for await (const event of source) result.push(event); return result }
function setup(scripts: readonly string[], options: { config?: ProviderConfig; probeSink?: ProviderProbeSink; initialImage?: boolean; now?: () => number; coordinator?: PrefixCoordinator; diagnose?: (code: string, error: unknown) => void } = {}) {
  let id = 0, index = 0
  const sent: ProviderHttpRequest[] = []
  const currentContent: Json = options.initialImage ? [{ type: 'text', text: '读取合成信息' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW5pdGlhbA==' } }] : '读取合成信息'
  const media = new Map<string, Json>()
  function mediaCodec(value: Json, hydrate: boolean): Json {
    if (Array.isArray(value)) return value.map(item => mediaCodec(item, hydrate))
    if (!value || typeof value !== 'object') return value
    if (value.type === 'tool_result' && typeof value.content === 'string' && /^[\s]*[\[{]/.test(value.content)) {
      try { return { ...value, content: JSON.stringify(mediaCodec(JSON.parse(value.content) as Json, hydrate)) } }
      catch { return value }
    }
    if (!hydrate && value.type === 'image') {
      const id = digest(value); media.set(id, structuredClone(value)); return { type: 'attachment_ref', attach_id: id, kind: 'image' }
    }
    if (hydrate && value.type === 'attachment_ref' && typeof value.attach_id === 'string' && media.has(value.attach_id)) return structuredClone(media.get(value.attach_id)!)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mediaCodec(item, hydrate)]))
  }
  const transport: ProviderTransport = { request: vi.fn(async request => {
    sent.push(structuredClone(request))
    const text = scripts[index++]
    if (text === undefined) throw new Error('协议请求超出合成脚本范围')
    return { status: 200, headers: {}, body: collectSource([encode(text)]), cancel: vi.fn() }
  }) }
  const context: CanonicalContextPorts = {
    digest, nextId: () => `entry-${++id}`,
    load: async () => ({ modelIdentity: 'model-a', contextWindow: 10000, accessScopeHash: digest(identity), capabilities: { toolNames: ['lookup'], tools: [{ name: 'lookup', schema: { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } } }] },
      input: { ...identity, fixedPrefix: [], history: [], preparedRag: { tail: [] }, currentUser: { persistedMessageId: 'current', message: { role: 'user', content: currentContent } } } }),
    preparation: { buildRag: async () => ({ tail: [] }) },
    prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
    references: { dehydrate: async entry => mediaCodec(entry.message, false) as import('../../../src/agent/harness/contracts.js').CanonicalMessage, hydrate: async entry => mediaCodec(entry.message, true) as import('../../../src/agent/harness/contracts.js').CanonicalMessage },
    compaction: { summarize: vi.fn(async () => { throw new Error('不应触发压缩') }) },
    finalization: { complete: vi.fn(async () => undefined) },
    currentRequest: () => { throw new Error('Provider接线应替换该端口') },
    stageContinuation: async () => { throw new Error('Provider接线应替换该端口') }, releaseContinuations: async () => undefined,
    diagnoseCompactionFailure: vi.fn(),
  }
  const connected = connectProviderHarness(context, { transport, resolve: async () => ({ modelIdentity: 'model-a', accessScopeHash: digest(identity), config: options.config ?? { provider: 'openai', model: 'synthetic-model' }, systemPrompt: '固定人格' }), probeSink: options.probeSink, diagnose: options.diagnose, coordinator: options.coordinator, clock: { now: options.now ?? (() => 0), sleep: async () => undefined } })
  const fake = fixture([])
  fake.ports.presentError = vi.fn(fake.ports.presentError)
  const runtime = fake.ports as unknown as HarnessPorts<CanonicalHarnessContext>
  const harness = createCanonicalHarness({ context: connected.context, executor: { authorize: async () => { throw new Error('lookup不执行原生进程') }, executor: { execute: async () => { throw new Error('lookup不执行原生进程') } } }, runtime: { ...runtime, provider: connected.provider } })
  return { ...connected, harness, sent, context, fake }
}
function chat(data: JsonObject) { return `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n` }
const tool = (raw: string) => chat({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'lookup', arguments: raw } }] }, finish_reason: 'tool_calls' }] })
const final = chat({ choices: [{ delta: { content: '已整理合成结果。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } })

describe('真实Provider到Canonical Harness组合', () => {
  it.each(['过期', '跨Run', '成功收尾'])('私有续接%s后明确拒绝引用，不能静默丢签名继续模型请求', async kind => {
    let now = 0
    const value = setup([], { now: () => now })
    const context = await createCanonicalContextPort(value.context).prepare(identity, new AbortController().signal)
    if (isEarlyExit(context)) throw new Error('合成上下文不应早退')
    const continuationRef = await value.provider.stageContinuation({ identity, round: 1, modelIdentity: context.modelIdentity, accessScopeHash: context.accessScopeHash, areaDigest: context.prepared.digest, value: { private: '合成私有续接' } })
    if (kind === '过期') now = 15 * 60_000
    if (kind === '成功收尾') value.provider.finishRun(identity)
    const target = kind === '跨Run' ? { ...identity, runId: 'other-run' } : identity
    const stream = value.provider.stream({ identity: target, context: { ...context, identity: target, continuationRef }, round: 2, replyChoice: 'reply', signal: new AbortController().signal })
    await expect(stream.next()).rejects.toMatchObject({ code: 'input_rejected' })
    expect(value.sent).toHaveLength(0)
    await value.provider.close()
  })
  it.each(['首轮恢复工具', '次轮恢复正文'])('Anthropic缺块%s实际跨Harness工具轮，工具只派发一次且最终正文只输出一次', async mode => {
    const sse = (...events: JsonObject[]) => events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    const start: JsonObject = { type: 'message_start', message: { content: [], usage: { input_tokens: 3, output_tokens: 0 } } }
    const bad = sse(start, { type: 'content_block_stop', index: 0 })
    const use: JsonObject = { type: 'tool_use', id: 'lookup-a', name: 'lookup', input: { query: '合成' } }
    const text: JsonObject = { type: 'text', text: '已恢复合成结果。' }
    const normal = (block: JsonObject, reason: string) => sse(start, { type: 'content_block_start', index: 0, content_block: block }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 2 } }, { type: 'message_stop' })
    const json = (block: JsonObject, reason: string) => JSON.stringify({ role: 'assistant', content: [block], stop_reason: reason, usage: { input_tokens: 3, output_tokens: 2 } })
    const scripts = mode === '首轮恢复工具' ? [bad, json(use, 'tool_use'), normal(text, 'end_turn')] : [normal(use, 'tool_use'), bad, json(text, 'end_turn')]
    const value = setup(scripts, { config: { provider: 'anthropic', model: 'claude-sonnet-4-6' } })
    const result = await collect(value.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(value.fake.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(value.sent).toHaveLength(3)
    expect(result.events.filter(event => event.type === 'token').map(event => event.payload.text).join('')).toBe('已恢复合成结果。')
    expect(result.state.text).toBe('已恢复合成结果。')
    expect((value.sent[1]!.body as JsonObject).stream).toBe(mode === '首轮恢复工具' ? undefined : true)
    expect((value.sent[2]!.body as JsonObject).stream).toBe(mode === '首轮恢复工具' ? true : undefined)
    await value.provider.close()
  })
  it('真实非聊天JSON分支去思考后解析围栏对象，不把内部JSON当结果', async () => {
    const value = setup([JSON.stringify({ choices: [{ message: { content: '<think>{"ok":false}</think>```json\n{"ok":true}\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3 } })])
    const result = await runContextBranch<ProviderWire>({ ...identity, stableSystem: '固定人格', delta: '返回合成JSON', tools: [], canonicalHistory: [] }, { name: 'reflection', outputMode: 'json' },
      { digest, nextId: () => 'branch', provider: value.provider.branchProvider('model-a'), pauseBeforeRetry: async () => undefined, diagnostic: vi.fn() })
    expect(result).toMatchObject({ ok: true, output: { ok: true }, attempts: 1 })
    expect(value.sent).toHaveLength(1)
    await value.provider.close()
  })
  it('首轮消费初始图片后合法推进Canonical revision并保留正文，后续工具新图片仍正常发送', async () => {
    const value = setup([tool('{"query":"合成"}'), final], { initialImage: true, config: { provider: 'openai', model: 'synthetic-model', image: true } })
    value.fake.ports.tools.dispatch = vi.fn(async () => ({ kind: 'completed' as const, value: [{ type: 'text', text: '合成工具结果' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'dG9vbA==' } }], successful: true, mutated: false }))
    const result = await collect(value.harness.start(identity))
    expect(result.state.status, vi.mocked(value.fake.ports.presentError).mock.calls.map(([error]) => String(error)).join('\n')).toBe('completed')
    expect(stableJson(value.sent[0]!.body)).toContain('aW5pdGlhbA==')
    expect(stableJson(value.sent[1]!.body)).not.toContain('aW5pdGlhbA==')
    expect(stableJson(value.sent[1]!.body)).toContain('dG9vbA==')
    const entry = result.state.context!.prepared.area.entries.find(entry => entry.persistedMessageId === 'current')!
    expect(typeof entry.message.content).toBe('string'); expect(entry.message.content).toContain('读取合成信息')
    expect(entry.revision).toBeGreaterThan(0)
    expect(stableJson(result.state)).not.toContain('base64')
    await value.provider.close()
  })
  it('Anthropic真实工具流等待回答后仍恢复原生签名，问题工具不重派且Canonical不存私有块', async () => {
    const sse = (...events: JsonObject[]) => events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    const start: JsonObject = { type: 'message_start', message: { content: [], usage: { input_tokens: 3, output_tokens: 0 } } }
    const end: JsonObject = { type: 'message_stop' }
    const first = sse(start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'synthetic-native-thinking', signature: 'synthetic-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'question-a', name: 'lookup', input: { query: '合成' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, end)
    const second = sse(start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '已整理合成回答。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, end)
    const value = setup([first, second], { config: { provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'adaptive' } })
    value.fake.ports.tools.dispatch = vi.fn(async call => ({ kind: 'waiting' as const, interaction: { id: 'question', kind: 'question' as const, toolCall: call } }))
    const waiting = await collect(value.harness.start(identity))
    expect(waiting.state.status).toBe('waiting')
    const complete = await collect(value.harness.resume(identity, { interactionId: 'question', receiptId: 'answer', status: 'answered', value: '合成回答' }))
    expect(complete.state.status).toBe('completed')
    expect(value.fake.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(value.sent).toHaveLength(2)
    const body = value.sent[1]!.body as JsonObject
    expect(stableJson(body.messages)).toContain('synthetic-signature')
    expect(stableJson(body.messages)).toContain('合成回答')
    expect(stableJson(complete.state)).not.toContain('synthetic-native-thinking')
    expect(stableJson(complete.state)).not.toContain('synthetic-signature')
    await value.provider.close()
  })
  it('缓存probe接实际发送请求与当前usage，sink异常不阻塞成功且不输出凭据', async () => {
    const probes: unknown[] = []
    const value = setup([final], { probeSink: probe => { probes.push(probe); if (probe.outcome === 'success') throw new Error('合成Collector不可用') }, diagnose: () => { throw new Error('合成诊断端口不可用') } })
    expect((await collect(value.harness.start(identity))).state.status).toBe('completed')
    expect(probes).toHaveLength(2)
    expect(probes[1]).toMatchObject({ outcome: 'success', normalizedUsage: { contextInput: 7 }, rawUsage: { prompt_tokens: 7, completion_tokens: 3 }, wirePrefix: { rowsKey: 'messages' } })
    expect(stableJson(probes)).not.toContain('api_key')
    await value.provider.close()
  })
  it('非法工具JSON只反馈错误，修正后仅派发一次且真实请求带system与配对历史', async () => {
    const value = setup([tool('{"query":'), tool('{"query":"合成"}'), final])
    const result = await collect(value.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(value.fake.ports.tools.dispatch).toHaveBeenCalledTimes(1)
    expect(value.sent).toHaveLength(3)
    const bodies = value.sent.map(request => request.body as JsonObject)
    expect(stableJson(bodies[0])).toContain('固定人格')
    expect(stableJson(bodies[1])).toContain('invalid_json')
    expect(stableJson(bodies[2])).toContain('tool_call_id')
    expect(result.events.filter(event => event.type === 'tool_done')).toHaveLength(2)
    expect(value.context.finalization.complete).toHaveBeenCalledTimes(1)
    expect(result.state.usage.contextInput).toBe(7)
    await value.provider.close()
  })
  it('实际出站wire快照供收尾反思使用，绑定checkpoint而非事后重渲染', async () => {
    const value = setup([final])
    await collect(value.harness.start(identity))
    const completion = vi.mocked(value.context.finalization.complete).mock.calls[0]![0]
    const body = value.sent[0]!.body as JsonObject
    // Python OpenAIAdapter沿用unknown适配器名；协议与模型身份另外精确绑定。
    expect(completion.projection?.wire).toMatchObject({ protocol: 'openai', provider: 'unknown', messages: body.messages })
    expect(completion.requestSystemPrompt).toBe('固定人格')
    expect(completion.projection?.modelIdentity).toBe('model-a')
    expect(stableJson(completion)).not.toContain('api_key')
    const projection = completion.projection as import('../../../src/agent/providers/contracts.js').ProviderProjection
    await expect(value.provider.completeBranch({ ...identity, ownerId: 'foreign-owner', modelIdentity: 'model-a', stableSystem: '固定人格', delta: '分支', tools: [], projection: projection as import('../../../src/agent/harness/contracts.js').OpaqueProviderProjection<ProviderWire> })).rejects.toMatchObject({ code: 'input_rejected' })
    expect(value.sent).toHaveLength(1)
    await value.provider.close()
  })
})

describe('共享重试、池与前缀协调契约', () => {
  it.each(['openai', 'responses'])('真实%s分支按最终body参数协调，动态任务不改变键而输出预算改变键，无稳定历史不协调', async protocol => {
    const keys: string[] = []
    const coordinator: PrefixCoordinator = { run: async (key, _signal, operation) => { keys.push(key); return operation() } }
    const json = JSON.stringify(protocol === 'responses' ? { status: 'completed', output_text: '完成' } : { choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] })
    const value = setup(Array.from({ length: 6 }, () => json), { coordinator, config: { provider: 'openai', model: 'synthetic-model', api_format: protocol } })
    const branch = { ...identity, modelIdentity: 'model-a', stableSystem: '固定规则', tools: [], canonicalHistory: [{ role: 'user' as const, content: '稳定历史' }], cacheSingleflight: true }
    await value.provider.completeBranch({ ...branch, delta: '任务甲', maxOutputTokens: 10 })
    await value.provider.completeBranch({ ...branch, delta: '任务乙', maxOutputTokens: 10 })
    await value.provider.completeBranch({ ...branch, delta: '任务乙', maxOutputTokens: 20 })
    await value.provider.completeBranch({ ...branch, canonicalHistory: [], delta: '任务甲', maxOutputTokens: 10 })
    await value.provider.completeBranch({ ...branch, canonicalHistory: [{ role: 'user', content: '不同稳定历史' }], delta: '任务甲', maxOutputTokens: 10 })
    await value.provider.completeBranch({ ...branch, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], delta: '任务甲', maxOutputTokens: 10 })
    expect(keys).toHaveLength(5); expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]); expect(keys[3]).not.toBe(keys[0]); expect(keys[4]).not.toBe(keys[0])
    expect(keys.every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true)
    const budget = protocol === 'responses' ? 'max_output_tokens' : 'max_tokens'
    expect((value.sent[0]!.body as JsonObject)[budget]).toBe(10)
    expect((value.sent[2]!.body as JsonObject)[budget]).toBe(20)
    await value.provider.close()
  })
  it('缓存协调按主动或显式缓存能力门控，none不等于明确禁止显式缓存', () => {
    const policy = { ...openaiPolicy, capabilities: (config: ProviderConfig) => ({ ...openaiPolicy.capabilities(config), cache_mode: 'none' as const }), explicitCache: (config: ProviderConfig) => config.model === 'cached' }
    expect(providerCacheSupported(policy, { model: 'cached' })).toBe(true)
    expect(providerCacheSupported(policy, { model: 'uncached' })).toBe(false)
  })
  it('取消原因正文不通过预取消HTTP和独立请求抛出，也不开始网络请求', async () => {
    const controller = new AbortController(); controller.abort(new Error('合成私密取消原因'))
    const request = vi.fn(async () => { throw new Error('不应发请求') })
    await expect(requestJson({ transport: { request }, digest }, { url: 'https://provider.example/v1/models', method: 'GET', headers: {} }, controller.signal)).rejects.toMatchObject({ code: 'cancelled', message: '模型请求已取消' })
    const value = setup([])
    await expect(value.provider.completeText(identity, 'model-a', '合成正文', 20, controller.signal)).rejects.toMatchObject({ code: 'cancelled', message: '模型请求已取消' })
    expect(request).not.toHaveBeenCalled(); expect(value.sent).toHaveLength(0)
    await value.provider.close()
  })
  it('分支及独立请求探针保存实际请求和raw usage，诊断失败不会把成功变为错误', async () => {
    const json = JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } })
    const probes: unknown[] = []
    const value = setup([json, json], { probeSink: probe => { probes.push(probe); throw new Error('合成Collector故障') }, diagnose: () => { throw new Error('合成诊断故障') } })
    expect(await value.provider.completeText(identity, 'model-a', '独立合成请求')).toBe('完成')
    expect((await value.provider.completeBranch({ ...identity, modelIdentity: 'model-a', stableSystem: '合成规则', delta: '分支合成请求', tools: [], canonicalHistory: [] })).output).toBe('完成')
    expect(probes).toHaveLength(4)
    for (const probe of [probes[1], probes[3]]) expect(probe).toMatchObject({ outcome: 'success', rawUsage: { prompt_tokens: 4, completion_tokens: 2 }, normalizedUsage: { contextInput: 4 } })
    await value.provider.close()
  })
  it('缓存指纹仅覆盖最后锚点前缀，动态尾部改变不使稳定前缀失配', () => {
    const build = (tail: string, stable = '固定合成上下文', tools: JsonObject[] = []) => {
      const values: unknown[] = []
      new RequestProbe({ tools, messages: [{ role: 'user', content: [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: tail }] }, { id: 'probe', digest, now: () => 0, sink: value => values.push(value) })
      return values[0] as { wirePrefix: { digest: string; rowCount: number } }
    }
    expect(build('动态甲').wirePrefix).toEqual(build('动态乙').wirePrefix)
    expect(build('动态甲').wirePrefix.rowCount).toBe(1)
    expect(build('动态甲', '不同稳定历史').wirePrefix.digest).not.toBe(build('动态甲').wirePrefix.digest)
    expect(build('动态甲', undefined, [{ name: 'lookup' }]).wirePrefix.digest).not.toBe(build('动态甲').wirePrefix.digest)
  })
  it('模型列表经过真实诊断请求映射，原生Ollama用tags，控制字符凭据在发请求前拒绝', async () => {
    expect(providerDiagnosticRequest({ provider: 'ollama', model: 'synthetic', ollama_api_mode: 'native' }, 'models').url).toMatch(/\/api\/tags$/)
    expect(() => normalizedApiKey('synthetic\nsecret')).toThrow(ProviderError)
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: collectSource([encode('{"data":[{"id":"synthetic-model"}]}')]), cancel: vi.fn() }))
    expect(await listProviderModels({ provider: 'openai', model: 'synthetic' }, { transport: { request }, digest }, new AbortController().signal)).toEqual([{ id: 'synthetic-model' }])
    expect(request.mock.calls[0]).toBeDefined()
  })
  it('池关闭和诊断同时失败仍回收scope，等待close不产生未处理拒绝', async () => {
    const pool = new ProviderClientPool({ diagnose: () => { throw new Error('合成诊断故障') } })
    const client = { close: vi.fn(async () => { throw new Error('合成关闭故障') }) }
    pool.get('run', 'key', () => client)
    await expect(pool.close()).resolves.toBeUndefined()
    expect(client.close).toHaveBeenCalledTimes(1)
  })
  it('MiniMax尾标记跨增量截断且不吞普通厂商同字面文本，思考精确标签不误伤正文', () => {
    const minimax = new ProviderStreamSanitizer(['[e~[', ']<]minimax'])
    expect(minimax.feed('正常回复\n```python\nprint(1)\n```[e')).toBe('正常回复\n```python\nprint(1)\n```')
    expect(minimax.feed('~[\n内部泄漏')).toBe(''); expect(minimax.flush()).toBe('')
    const normal = new ProviderStreamSanitizer()
    expect(normal.feed('说明一下 [e~[ 这段文本')).toBe('说明一下 [e~[ 这段文本')
    expect(normal.feed('前文<thi')).toBe('前文'); expect(normal.feed('nk>内部')).toBe('')
    expect(normal.feed('判断</thi')).toBe(''); expect(normal.feed('nk>后文')).toBe('后文'); expect(normal.flush()).toBe('')
    const math = new ProviderStreamSanitizer(); expect(math.feed('1 <')).toBe('1 '); expect(math.flush()).toBe('<')
    const partial = new ProviderStreamSanitizer(); partial.feed('<thi'); expect(partial.flush()).toBe('')
    const unclosed = new ProviderStreamSanitizer(); expect(unclosed.feed('可见<think>私有合成片段')).toBe('可见'); expect(unclosed.flush()).toBe('')
    const ordinary = new ProviderStreamSanitizer(); expect(ordinary.feed('正常回复。')).toBe('正常回复。'); expect(ordinary.flush()).toBe('')
    const words = new ProviderStreamSanitizer(); expect(words.feed('thinking普通单词<think>隐藏</think>可见')).toBe('thinking普通单词可见'); expect(words.flush()).toBe('')
    expect(stripThinking('thinking不是标签，<think>隐藏</think>保留')).toBe('thinking不是标签，保留')
    expect(stripThinking('<think>未闭合')).toBe(''); expect(stripThinking('<thi')).toBe('<thi')
    expect(stripThinking('<THINK>普通字面</THINK>')).toBe('<THINK>普通字面</THINK>')
  })
  it('无输出限流退避一次，重试码供Harness识别；新attempt的usage明确归零为未知', async () => {
    let attempts = 0
    const source = () => (async function* (): AsyncGenerator<ProviderEvent> {
      attempts++
      if (attempts === 1) { yield { type: 'usage', usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: 100 } }; throw new ProviderError('rate_limit', { retryable: true }) }
      yield { type: 'complete', text: '完成', calls: [] }
    })()
    const sleep = vi.fn(async () => undefined)
    const events = await all(streamWithRetry(source, new AbortController().signal, { clock: { now: () => 0, sleep } }))
    expect(attempts).toBe(2); expect(sleep).toHaveBeenCalledWith(5000, expect.any(AbortSignal))
    expect(events.find(event => event.type === 'retry')).toMatchObject({ errorCode: 'rate_limited' })
    const usages = events.filter((event): event is Extract<ProviderEvent, { type: 'usage' }> => event.type === 'usage')
    expect(usages.at(-1)!.usage.contextInput).toBeNull()
  })
  it('收到正文或私有输出事实后即使上游繁忙也不重放，错误正文不进入安全错误', async () => {
    const open = vi.fn(() => (async function* (): AsyncGenerator<ProviderEvent> { yield { type: 'token', text: '部分正文' }; throw new ProviderError('busy', { retryable: true }) })())
    await expect(all(streamWithRetry(open, new AbortController().signal))).rejects.toMatchObject({ code: 'busy' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(classifyProviderError({ status: 401, body: { message: 'private-token/正文' } }))).not.toContain('private-token')
  })
  it('MiniMax普通HTTP529不被业务码分类吞掉，2013窗口超限不重试', () => {
    expect(classifyProviderError({ response: { status_code: 429 } })).toMatchObject({ code: 'rate_limit', options: { status: 429, retryable: true } })
    expect(classifyProviderError({ cause: { response: { status_code: 401 } } })).toMatchObject({ code: 'authentication', options: { status: 401, retryable: false } })
    expect(classifyProviderError({ status_code: 600 }).options.status).toBeUndefined()
    for (const status of [399, 400, 503, 599, 600]) expect(classifyProviderError({ status_code: status }).options.status).toBe(status >= 400 && status <= 599 ? status : undefined)
    expect(classifyProviderError(new Error('合成内部错误')).options.status).toBeUndefined()
    expect(classifyProviderError({ status: 529 }, { providerUrl: 'https://api.minimaxi.com/anthropic/v1/messages' })).toMatchObject({ code: 'busy', options: { retryable: true } })
    expect(classifyProviderError({ status: 400, body: { error: { type: 'invalid_request_error', code: 2013, message: 'context window exceeds limit' } } }, { providerUrl: 'https://api.minimaxi.com/anthropic/v1/messages' })).toMatchObject({ code: 'context_overflow', options: { retryable: false } })
  })
  it('排队调用取消立即退出但第三个请求不越过仍运行的首请求，也不共享答案', async () => {
    const coordinator = new InProcessPrefixCoordinator(), started = deferred<void>(), release = deferred<void>()
    const first = coordinator.run('prefix', new AbortController().signal, async () => { started.resolve(); await release.promise; return '一' })
    await started.promise
    const controller = new AbortController(), skipped = vi.fn(async () => '不应运行')
    const second = coordinator.run('prefix', controller.signal, skipped); controller.abort()
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })
    const next = vi.fn(async () => '三'), third = coordinator.run('prefix', new AbortController().signal, next)
    await Promise.resolve(); expect(next).not.toHaveBeenCalled()
    release.resolve(); expect(await first).toBe('一'); expect(await third).toBe('三'); expect(skipped).not.toHaveBeenCalled()
  })
  it('客户端复用只发生在相同凭据/网络键，最后scope退出才延迟关闭且新scope可取消关闭', async () => {
    let callback: () => void = () => undefined
    const clear = vi.fn(), client = { close: vi.fn(async () => undefined) }, factory = vi.fn(() => client)
    const pool = new ProviderClientPool({ timers: { set: action => { callback = action; return 1 }, clear } })
    expect(pool.get('a', 'key', factory)).toBe(pool.get('b', 'key', factory)); expect(factory).toHaveBeenCalledTimes(1)
    pool.finish('a'); expect(client.close).not.toHaveBeenCalled()
    pool.finish('b'); pool.get('c', 'key', factory); expect(clear).toHaveBeenCalledWith(1)
    callback(); expect(client.close).not.toHaveBeenCalled()
    pool.finish('c'); callback()
    const fresh = { close: vi.fn(async () => undefined) }
    expect(pool.get('d', 'key', () => fresh)).toBe(fresh); expect(fresh).not.toBe(client)
    await pool.close(); expect(client.close).toHaveBeenCalledTimes(1); expect(fresh.close).toHaveBeenCalledTimes(1)
    const key = providerConfigKey('openai', { baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-secret', headers: {}, timeout: 10 }, digest)
    expect(key).toMatch(/^[a-f0-9]{64}$/); expect(key).not.toContain('synthetic-secret')
    expect(providerConfigKey('openai', { baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-a', headers: {}, timeout: 10 }, digest))
      .not.toBe(providerConfigKey('openai', { baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-b', headers: {}, timeout: 10 }, digest))
  })
})
