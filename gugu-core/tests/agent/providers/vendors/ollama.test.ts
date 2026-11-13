import { describe, expect, it } from 'vitest'
import type { CanonicalMessage, ProviderEvent, Usage } from '../../../../src/agent/harness/contracts.js'
import type { JsonObject } from '../../../../src/agent/providers/contracts.js'
import { providerSelection } from '../../../../src/agent/providers/registry.js'
import { ollamaDriver, projectOllamaHistory } from '../../../../src/agent/providers/vendors/ollama.js'
import { ollamaPolicy } from '../../../../src/agent/providers/vendors/policies.js'
import { limitSearchResult, providerSearchSchema, readSearchResponse, searchProvider, supportsProviderSearch, MAX_SEARCH_RESULT_BYTES } from '../../../../src/agent/providers/vendors/search.js'
import { fakeDependencies, fakeResponse, invocation, requestJsonBody } from './fixtures.js'

const encoder = new TextEncoder()
const collect = async (stream: AsyncIterable<ProviderEvent>) => { const result: ProviderEvent[] = []; for await (const event of stream) result.push(event); return result }

describe('Ollama原生请求与NDJSON流', () => {
  it.each(['thinking', 'tool_calls'])('仅收到私有%s后断连也标记输出事实，不允许共享重试重放', async kind => {
    const message = kind === 'thinking' ? { thinking: '合成私有片段' } : { tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }
    const f = fakeDependencies([])
    let requests = 0
    f.dependencies.transport.request = async () => {
      requests++
      return { status: 200, headers: {}, cancel: () => undefined, body: (async function* () {
        yield encoder.encode(JSON.stringify({ message }) + '\n')
        throw Object.assign(new Error('合成断连'), { code: 'ECONNRESET' })
      })() }
    }
    await expect(collect(ollamaDriver.stream(invocation(ollamaPolicy), f.dependencies))).rejects.toMatchObject({ code: 'network', options: { outputStarted: true } })
    expect(requests).toBe(1)
  })
  it('真实分片流按token→usage→complete输出并保留工具参数、thinking和实际用量', async () => {
    const response = fakeResponse(null, { chunks: [encoder.encode('{"message":{"content":"先查'), encoder.encode('一下。","thinking":"私有思考"}}\n{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{"x":1}}}]}}\n{"done":true,"prompt_eval_count":12,"eval_count":3,"done_reason":"stop"}\n')] })
    const f = fakeDependencies([response]), input = invocation(ollamaPolicy, { model: 'qwen3:8b', thinking: 'adaptive', reasoning_effort: 'max', max_tokens: 32 }, { system: '固定system', tools: [{ type: 'function', function: { name: 'read_file' } }] })
    const events = await collect(ollamaDriver.stream(input, f.dependencies))
    expect(events.map(event => event.type)).toEqual(['token', 'usage', 'complete'])
    expect(events[0]).toEqual({ type: 'token', text: '先查一下。' })
    expect(events[1]).toMatchObject({ type: 'usage', usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, contextInput: 12 } })
    const callId = `ollama-call-${f.dependencies.digest(['小北', 'session', 'run', 1]).slice(0, 24)}-0`
    expect(events[2]).toMatchObject({ type: 'complete', calls: [{ id: callId, name: 'read_file', input: { x: 1 } }], requiresTools: true,
      continuation: { thinkingByToolCallId: { [callId]: '私有思考' } }, finishReason: 'stop' })
    expect(f.requests[0]).toMatchObject({ url: 'http://127.0.0.1:11434/api/chat', allowLocal: true })
    expect(requestJsonBody(f.requests[0]!)).toEqual({ model: 'qwen3:8b', stream: true, think: 'max', keep_alive: '5m', options: { num_predict: 32 }, messages: [{ role: 'system', content: '固定system' }], tools: input.tools })
    expect(response.closed).toBe(true)
  })
  it('两个无ID工具分块产生稳定不同ID，字符串参数原始字节保留', async () => {
    // 用JSON生成固定NDJSON，避免测试本身的引号转义成为协议差异。
    const raw = [{ message: { tool_calls: [{ function: { name: 'read', arguments: '{ "x": 1 }' } }] } }, { message: { tool_calls: [{ function: { name: 'write', arguments: {} } }] } }, { done: true }].map(value => JSON.stringify(value)).join('\n')
    const f = fakeDependencies([fakeResponse(null, { raw })])
    const events = await collect(ollamaDriver.stream(invocation(ollamaPolicy), f.dependencies))
    const complete = events.find(event => event.type === 'complete')
    expect(complete).toMatchObject({ calls: [{ id: expect.stringMatching(/^ollama-call-[a-f0-9]{24}-0$/), name: 'read', input: { x: 1 }, rawArguments: '{ "x": 1 }' }, { id: expect.stringMatching(/^ollama-call-[a-f0-9]{24}-1$/), name: 'write', input: {} }] })
  })
  it('无ID调用绑定run与round，相同身份稳定而后续轮和Run不会碰撞', async () => {
    const raw = [{ message: { tool_calls: [{ function: { name: 'read', arguments: {} } }] } }, { done: true }].map(value => JSON.stringify(value)).join('\n')
    const f = fakeDependencies(Array.from({ length: 4 }, () => fakeResponse(null, { raw }))), ids: string[] = []
    for (const [runId, round] of [['run-a', 1], ['run-a', 2], ['run-b', 1], ['run-a', 1]] as const) {
      const input = invocation(ollamaPolicy)
      const events = await collect(ollamaDriver.stream({ ...input, scope: { ...input.scope, runId, round } }, f.dependencies))
      const complete = events.find(event => event.type === 'complete')
      if (!complete || complete.type !== 'complete') throw new Error('合成流应完成')
      ids.push(complete.calls[0]!.id)
    }
    expect(new Set(ids.slice(0, 3)).size).toBe(3); expect(ids[3]).toBe(ids[0])
  })
  it('独立完成发送非流请求和显式JSON格式，系统规则不重复插入', async () => {
    const f = fakeDependencies([fakeResponse({ message: { content: '{"ok":true}' }, done: true, prompt_eval_count: 9, eval_count: 2 })])
    const input = invocation(ollamaPolicy, { ollama_mode: 'cloud', thinking: 'disabled' }, { system: '固定system', history: [{ role: 'system', content: '固定system' }], outputMode: 'json' })
    const result = await ollamaDriver.complete(input, f.dependencies)
    expect(result).toMatchObject({ text: '{"ok":true}', usage: { contextInput: 9, output: 2 } })
    expect(requestJsonBody(f.requests[0]!)).toMatchObject({ messages: [{ role: 'system', content: '固定system' }], stream: false, think: false, format: 'json' })
    expect(f.requests[0]).toMatchObject({ url: 'https://ollama.com/api/chat', allowLocal: false })
  })
  it('真实registry配置过滤仍保留原生Ollama显式思考和档位，实际请求不退成think=false', async () => {
    const selected = providerSelection({ provider: 'ollama', model: 'qwen3:8b', ollama_api_mode: 'native', thinking: 'adaptive', reasoning_effort: 'max' })
    expect(selected.config).toMatchObject({ thinking: 'adaptive', reasoning_effort: 'max' })
    const f = fakeDependencies([fakeResponse(null, { raw: '{"done":true}\n' })])
    await collect(selected.driver.stream(invocation(selected.policy, selected.config), f.dependencies))
    expect(requestJsonBody(f.requests[0]!)).toMatchObject({ think: 'max' })
  })
  it.each([undefined, 'unknown', '  custom-provider  '])('未知Provider%s经URL选择Ollama协议也不得授予内网访问，流与独立完成都保持未授权', async provider => {
    const selected = providerSelection({ provider, model: 'qwen3:8b', base_url: 'http://127.0.0.1:11434', ollama_api_mode: 'native' })
    expect(selected.policy.name).toBe('ollama')
    const f = fakeDependencies([fakeResponse(null, { raw: '{"done":true}\n' }), fakeResponse({ done: true, message: { content: '完成' } })])
    const input = invocation(selected.policy, { ...selected.config, provider })
    await collect(selected.driver.stream(input, f.dependencies))
    await selected.driver.complete(input, f.dependencies)
    expect(f.requests).toHaveLength(2)
    expect(f.requests.every(request => request.url === 'http://127.0.0.1:11434/api/chat' && request.allowLocal === false)).toBe(true)
  })
  it('只有显式Ollama配置可给原生驱动内网授权，配置名按trim和大小写规范化', async () => {
    const selected = providerSelection({ provider: '  OLLAMA  ', model: 'qwen3:8b', base_url: 'http://127.0.0.1:11434/api', ollama_api_mode: 'native' })
    const f = fakeDependencies([fakeResponse({ done: true, message: { content: '完成' } })])
    await selected.driver.complete(invocation(selected.policy, selected.config), f.dependencies)
    expect(f.requests[0]?.allowLocal).toBe(true)
  })
  it.each(['{"message":{"content":"部分正文"}}\n', '{"message":{"tool_calls":[{"function":{"name":"write","arguments":"{bad"}}]}}\n{"done":true}\n'])('缺done或工具参数无效不能作为成功完成：%s', async raw => {
    const f = fakeDependencies([fakeResponse(null, { raw })]), events: ProviderEvent[] = []
    await expect((async () => { for await (const event of ollamaDriver.stream(invocation(ollamaPolicy), f.dependencies)) events.push(event) })()).rejects.toHaveProperty('code')
    expect(events.some(event => event.type === 'complete')).toBe(false)
  })
  it('用量缺报保持未知，未使用字符数生成token', async () => {
    const f = fakeDependencies([fakeResponse(null, { raw: '{"done":true,"message":{"content":"很长很长的正文"}}\n' })])
    const observed: unknown[] = []
    const events = await collect(ollamaDriver.stream(invocation(ollamaPolicy), { ...f.dependencies, onUsage: (raw, normalized) => { observed.push({ raw, normalized }) } }))
    expect(events.find(event => event.type === 'usage')).toMatchObject({ usage: { input: 0, output: 0, contextInput: null } })
    expect(observed).toEqual([{ raw: null, normalized: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null } }])
  })
  it.each(['stream', 'complete'] as const)('原生%s用量hook保留真实计数/时长但不包含正文，sink改写或失败不污染正常事件', async kind => {
    const chunk = { done: true, message: { content: '合成正文' }, prompt_eval_count: 12, eval_count: 3, total_duration: 4000, eval_duration: 1000 }
    const f = fakeDependencies([kind === 'stream' ? fakeResponse(null, { raw: JSON.stringify(chunk) + '\n' }) : fakeResponse(chunk)])
    const observed: unknown[] = []
    const dependencies = { ...f.dependencies, onUsage: (raw: unknown, normalized: Usage) => {
      observed.push(structuredClone({ raw, normalized }))
      ;(raw as { prompt_eval_count: number }).prompt_eval_count = 999
      ;(normalized as { input: number }).input = 999
      throw new Error('合成用量接收失败')
    } }
    if (kind === 'stream') {
      const events = await collect(ollamaDriver.stream(invocation(ollamaPolicy), dependencies))
      expect(events.find(event => event.type === 'usage')).toMatchObject({ usage: { input: 12, contextInput: 12 } })
      expect(events.at(-1)).toMatchObject({ type: 'complete', text: '合成正文' })
    } else expect(await ollamaDriver.complete(invocation(ollamaPolicy), dependencies)).toMatchObject({ text: '合成正文', usage: { input: 12, contextInput: 12 } })
    expect(observed).toEqual([{ raw: { prompt_eval_count: 12, eval_count: 3, total_duration: 4000, eval_duration: 1000 }, normalized: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, contextInput: 12 } }])
  })
  it.each([undefined, null, 64])('原生maxOutputTokens=%s保留显式None含义，不能重新套用配置上限', async maximum => {
    const f = fakeDependencies([fakeResponse(null, { raw: '{"done":true}\n' }), fakeResponse({ done: true, message: { content: '完成' } })])
    const input = invocation(ollamaPolicy, { max_tokens: 128 }, { maxOutputTokens: maximum })
    await collect(ollamaDriver.stream(input, f.dependencies)); await ollamaDriver.complete(input, f.dependencies)
    for (const request of f.requests) {
      if (maximum === null) expect(requestJsonBody(request).options).toEqual({})
      else expect(requestJsonBody(request).options).toEqual({ num_predict: maximum ?? 128 })
    }
  })
  it('消费者提前return取消真实响应流，不再读取后续NDJSON', async () => {
    const response = fakeResponse(null, { chunks: [encoder.encode('{"message":{"content":"首片"}}\n'), encoder.encode('{"done":true}\n')] })
    const f = fakeDependencies([response]), generator = ollamaDriver.stream(invocation(ollamaPolicy), f.dependencies)[Symbol.asyncIterator]()
    expect((await generator.next()).value).toEqual({ type: 'token', text: '首片' })
    await generator.return?.()
    expect(response.closed).toBe(true); expect(response.chunksRead).toBe(1)
  })
  it('已取消输入不打开transport，上游原文不进入可见错误', async () => {
    const cancel = new AbortController(); cancel.abort()
    const f = fakeDependencies([])
    await expect(collect(ollamaDriver.stream(invocation(ollamaPolicy, {}, { signal: cancel.signal }), f.dependencies))).rejects.toThrow()
    expect(f.requests).toEqual([])
    const error = fakeDependencies([fakeResponse(null, { raw: '{"error":"synthetic-secret-upstream-body"}\n' })])
    await expect(collect(ollamaDriver.stream(invocation(ollamaPolicy), error.dependencies))).rejects.toThrow('模型服务请求失败')
    expect(error.diagnostics[0]?.error).toBe('synthetic-secret-upstream-body')
  })
  it('done用量交付后收到取消不得继续发成功complete', async () => {
    const controller = new AbortController(), response = fakeResponse(null, { raw: '{"done":true,"prompt_eval_count":1}\n' })
    const f = fakeDependencies([response]), stream = ollamaDriver.stream(invocation(ollamaPolicy, {}, { signal: controller.signal }), f.dependencies)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'usage' })
    controller.abort()
    await expect(stream.next()).rejects.toThrow()
    expect(response.closed).toBe(true)
  })
})

describe('Ollama原生历史配对与媒体', () => {
  it('仅有回执的工具进入投影，确认门后的未派发兄弟不留孤儿且Canonical原文不变', () => {
    const messages: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'one', name: 'read', arguments: { x: 1 } }, { type: 'tool_call', id: 'two', name: 'delete', arguments: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'one', tool_name: 'read', content: '等待回答' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'orphan', content: '孤儿' }] },
    ]
    const saved = structuredClone(messages)
    expect(projectOllamaHistory(messages, { model: 'qwen3:8b' })).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'one', type: 'function', function: { name: 'read', arguments: { x: 1 } } }] },
      { role: 'tool', tool_name: 'read', content: '等待回答' },
    ])
    expect(messages).toEqual(saved)
  })
  it('私有thinking按工具ID从续接材料恢复，不从普通Canonical正文推导', () => {
    const messages: CanonicalMessage[] = [{ role: 'assistant', content: [{ type: 'tool_call', id: 'one', name: 'read', arguments: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'one', content: '完成' }] }]
    const input = { model: 'qwen3:8b' }
    expect(projectOllamaHistory(messages, input)[0]).not.toHaveProperty('thinking')
    expect(projectOllamaHistory(messages, input, { continuation: { protocol: 'ollama', thinkingByToolCallId: { one: '私有思考' } } })[0]).toHaveProperty('thinking', '私有思考')
    expect(projectOllamaHistory(messages, input, { continuation: { protocol: 'responses', thinkingByToolCallId: { one: '其他协议思考' } } })[0]).not.toHaveProperty('thinking')
    expect(JSON.stringify(messages)).not.toContain('私有思考')
  })
  it('旧历史多个完整轮复用ollama-call-0时仍逐轮恢复配对，不全局去重丢结果', () => {
    const messages: CanonicalMessage[] = []
    for (const name of ['read_file', 'write_file']) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_call', id: 'ollama-call-0', name, arguments: {} }] })
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_call_id: 'ollama-call-0', content: `${name}完成` }] })
    }
    const result = projectOllamaHistory(messages, { model: 'qwen3:8b' })
    expect(result.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool'])
    expect(result.filter(message => message.role === 'tool')).toEqual([{ role: 'tool', tool_name: 'read_file', content: 'read_file完成' }, { role: 'tool', tool_name: 'write_file', content: 'write_file完成' }])
  })
  it('视觉显式开启才把base64图像送入images，音视频不能静默文本化', () => {
    const messages: CanonicalMessage[] = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]
    expect(projectOllamaHistory(messages, { model: 'vision', image: true })).toEqual([{ role: 'user', content: '看图', images: ['AAAA'] }])
    expect(() => projectOllamaHistory(messages, { model: 'text' })).toThrow()
    expect(() => projectOllamaHistory([{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA' } }] }], { model: 'text' })).toThrow()
  })
  it('工具媒体不被序列化为base64正文，未传原生媒体时明确通知而非声称模型已看图', () => {
    const projected = projectOllamaHistory([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'one', name: 'read_file', arguments: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'one', content: [{ type: 'text', text: '工具说明' }, { type: 'image', source: { type: 'base64', data: 'synthetic-large-image' } }] }] },
    ], { model: 'vision', image: true })
    expect(projected[1]?.content).toContain('工具说明')
    expect(projected[1]?.content).toContain('未发送工具图片')
    expect(JSON.stringify(projected)).not.toContain('synthetic-large-image')
  })
})

describe('六厂商联网搜索保留原生协议并限制外部输入输出', () => {
  it.each([
    { provider: 'minimax', model: 'MiniMax-M3', args: { query: '合成查询' }, path: 'https://api.minimaxi.com/v1/coding_plan/search', expected: { q: '合成查询' } },
    { provider: 'qwen', model: 'qwen3.8-max', api_format: 'openai', args: { messages: [{ role: 'user', content: '合成查询' }] }, path: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', expected: { model: 'qwen3.8-max', max_tokens: 1200, enable_search: true, include_tool_usage: true, search_options: { forced_search: true } } },
    { provider: 'qwen', model: 'qwen3.8-max', api_format: 'responses', args: { input: '合成查询' }, path: 'https://dashscope.aliyuncs.com/compatible-mode/v1/responses', expected: { model: 'qwen3.8-max', max_output_tokens: 1200, tools: [{ type: 'web_search' }], store: false } },
    { provider: 'glm', model: 'glm-5.2', args: { search_query: '合成查询', search_engine: 'search_std', search_intent: false }, path: 'https://open.bigmodel.cn/api/paas/v4/web_search', expected: { search_query: '合成查询', search_engine: 'search_std', search_intent: false } },
    { provider: 'deepseek', model: 'deepseek-flash', args: { query: '合成查询', need_content: true, count: 2 }, path: 'https://api.deepseek.com/v1/tools/search', expected: { query: '合成查询', need_content: true, count: 2 } },
    { provider: 'mimo', model: 'mimo-v2.6-pro', args: { messages: [{ role: 'user', content: '合成查询' }], tools: [{ type: 'web_search', force_search: true }] }, path: 'https://api.xiaomimimo.com/v1/chat/completions', expected: { model: 'mimo-v2.6-pro', max_completion_tokens: 1024, stream: false, thinking: { type: 'disabled' } } },
    { provider: 'ollama', model: 'qwen3:8b', args: { query: '合成查询', max_results: 2 }, path: 'https://ollama.com/api/web_search', expected: { query: '合成查询', max_results: 2 } },
  ])('$provider的$api_format请求走实际transport并保留原生结果与计费字段', async scenario => {
    const data = { base_resp: { status_code: 0 }, usage: { input_tokens: 10 }, results: [{ url: 'https://source.example/item', title: '合成结果' }] }
    const large = { results: Array.from({ length: 40 }, () => ({ content: '长正文'.repeat(4000), url: 'https://source.example/page' })) }
    const response = fakeResponse(data), f = fakeDependencies([response, fakeResponse(large)])
    const config = { provider: scenario.provider, model: scenario.model, api_format: scenario.api_format, ollama_mode: 'cloud', api_key: 'synthetic-key' }
    const result = await searchProvider(config, scenario.args as unknown as JsonObject, f.dependencies, new AbortController().signal)
    expect(result).toEqual(data)
    expect(f.requests[0]?.url).toBe(scenario.path)
    expect(requestJsonBody(f.requests[0]!)).toMatchObject(scenario.expected)
    expect(f.requests[0]?.headers).toHaveProperty(scenario.provider === 'mimo' ? 'api-key' : 'Authorization', scenario.provider === 'mimo' ? 'synthetic-key' : 'Bearer synthetic-key')
    expect(f.requests[0]?.url).not.toContain('synthetic-key')
    expect(response.closed).toBe(true)
    const bounded = await searchProvider(config, scenario.args as unknown as JsonObject, f.dependencies, new AbortController().signal)
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(MAX_SEARCH_RESULT_BYTES)
    expect(bounded).toMatchObject({ _gugu_search_limits: { truncated: true } })
  })
  it.each(['minimax', 'qwen', 'glm', 'deepseek', 'mimo', 'ollama'])('%s搜索拒绝foreign host，不把当前凭据转发给任意端点', async provider => {
    const f = fakeDependencies([])
    const config = { provider, model: provider === 'mimo' ? 'mimo-v2.6-pro' : '合成模型', base_url: 'https://foreign.example/v1', api_key: 'synthetic-key' }
    expect(supportsProviderSearch(config)).toBe(false)
    const result = await searchProvider(config, { query: '合成查询' }, f.dependencies, new AbortController().signal)
    expect(result).toHaveProperty('error'); expect(f.requests).toEqual([])
  })
  it('官方host仍拒绝重定向目标、嵌入凭据和非标准端口，Ollama local不借用云搜索', () => {
    for (const base_url of ['http://api.minimax.cn', 'https://user:secret@api.minimax.cn', 'https://api.minimax.cn:444', 'https://api.minimax.cn/v1?target=https://foreign.example']) {
      expect(supportsProviderSearch({ provider: 'minimax', model: 'MiniMax-M3', base_url })).toBe(false)
    }
    expect(supportsProviderSearch({ provider: 'ollama', model: 'qwen3:8b', ollama_mode: 'local' })).toBe(false)
    expect(supportsProviderSearch({ provider: 'qwen', model: 'qwen3.8-max', api_format: 'anthropic' })).toBe(false)
    expect(supportsProviderSearch({ provider: 'mimo', model: 'unknown-model' })).toBe(false)
  })
  it('搜索Schema按当前协议返回独立副本，不把厂商字段归一成通用query', () => {
    const qwen = providerSearchSchema({ provider: 'qwen', model: 'qwen3.8-max', api_format: 'responses' })
    expect(qwen.required).toEqual(['input'])
    expect(providerSearchSchema({ provider: 'glm', model: 'glm-5.2' }).required).toEqual(['search_query', 'search_engine', 'search_intent'])
    qwen.required = ['被调用者修改']
    expect(providerSearchSchema({ provider: 'qwen', model: 'qwen3.8-max', api_format: 'responses' }).required).toEqual(['input'])
    expect(providerSearchSchema({ provider: 'openai', model: 'gpt-test' })).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  })
  it.each([['qwen', 'responses', 'max_output_tokens', 1200], ['mimo', 'openai', 'max_completion_tokens', 1024]])('%s搜索输出预算%s有默认与2048上限', async (provider, api_format, field, defaultValue) => {
    for (const requested of [undefined, 9999]) {
      const f = fakeDependencies([fakeResponse({ ok: true })])
      await searchProvider({ provider, api_format, model: provider === 'mimo' ? 'mimo-v2.6-pro' : 'qwen3.8-max', api_key: 'synthetic-key' }, { [field]: requested ?? defaultValue, input: '合成查询' }, f.dependencies, new AbortController().signal)
      expect(requestJsonBody(f.requests[0]!)[field]).toBe(requested === undefined ? defaultValue : 2048)
    }
  })
  it.each([['1033', 3], ['1004', 1], ['1008', 1], ['2056', 1], ['2049', 1]])('MiniMax错误码%s仅瞬时1033进行有限三次重试', async (code, count) => {
    const f = fakeDependencies(Array.from({ length: 3 }, () => fakeResponse({ base_resp: { status_code: code, status_msg: 'synthetic-private-upstream-body' } }))), waits: number[] = []
    const result = await searchProvider({ provider: 'minimax', model: 'MiniMax-M3', api_key: 'synthetic-key' }, { query: '合成查询' }, { ...f.dependencies, pause: async ms => { waits.push(ms) } }, new AbortController().signal)
    expect(f.requests).toHaveLength(count); expect(waits).toHaveLength(count - 1)
    expect(result).toHaveProperty('error'); expect(JSON.stringify(result)).not.toContain('synthetic-private-upstream-body')
  })
  it('MiniMax第二次成功返回原结果，HTTP失败/重定向不按1033重放或回显上游', async () => {
    const f = fakeDependencies([fakeResponse({ base_resp: { status_code: 1033 } }), fakeResponse({ base_resp: { status_code: 0 }, results: [] })])
    expect(await searchProvider({ provider: 'minimax', model: 'MiniMax-M3', api_key: 'synthetic-key' }, { query: '合成查询' }, { ...f.dependencies, pause: async () => {} }, new AbortController().signal)).toMatchObject({ base_resp: { status_code: 0 } })
    for (const status of [302, 500]) {
      const response = fakeResponse({ error: 'synthetic-private-upstream-body' }, { status, headers: { location: 'https://foreign.example' } }), failed = fakeDependencies([response])
      expect(await searchProvider({ provider: 'minimax', model: 'MiniMax-M3', api_key: 'synthetic-key' }, { query: '合成查询' }, failed.dependencies, new AbortController().signal)).toEqual({ error: `MiniMax 搜索服务返回 HTTP ${status}` })
      expect(failed.requests).toHaveLength(1); expect(response.chunksRead).toBe(0); expect(response.closed).toBe(true)
    }
  })
  it('响应大小同时检查声明长度与实际流，超过2MiB后立即停止读取并取消', async () => {
    const oversized = fakeResponse({}, { headers: { 'content-length': '2097153' } })
    expect(await readSearchResponse(oversized, '合成搜索', new AbortController().signal)).toHaveProperty('error')
    expect(oversized.chunksRead).toBe(0); expect(oversized.closed).toBe(true)
    const chunk = new Uint8Array(1024 * 1024), streamed = fakeResponse(null, { chunks: [chunk, chunk, chunk, chunk] })
    expect(await readSearchResponse(streamed, '合成搜索', new AbortController().signal)).toHaveProperty('error')
    expect(streamed.chunksRead).toBe(3); expect(streamed.closed).toBe(true)
  })
  it('JSON错误与上游error返回通用错误，不回显上游正文或用户查询', async () => {
    for (const response of [fakeResponse(null, { raw: 'not-json-private' }), fakeResponse({ error: { message: 'synthetic-private-user-query' } }), fakeResponse(['bad-shape'])]) {
      const result = await readSearchResponse(response, '合成搜索', new AbortController().signal)
      expect(result).toHaveProperty('error'); expect(JSON.stringify(result)).not.toContain('private'); expect(response.closed).toBe(true)
    }
  })
  it('模型结果预算计入结构，保留状态/用量，文本和数组显式截断，链接保持完整或省略', () => {
    const data = { results: Array.from({ length: 30 }, (_, index) => ({ title: `条目${index}`, content: '😀'.repeat(9000), url: index === 0 ? 'https://source.example/' + 'x'.repeat(70_000) : 'https://source.example/item' })), usage: { input_tokens: 12 }, base_resp: { status_code: 0 } }
    const result = limitSearchResult(data), encoded = new TextEncoder().encode(JSON.stringify(result))
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_SEARCH_RESULT_BYTES)
    expect(result).toMatchObject({ usage: { input_tokens: 12 }, base_resp: { status_code: 0 }, _gugu_search_limits: { truncated: true } })
    const first = (result.results as { content: string; url?: string }[])[0]!
    expect([...first.content]).toHaveLength(8000); expect(first.url).toBeUndefined()
    expect((result.results as unknown[]).length).toBeLessThanOrEqual(20)
    expect(data.results[0]!.url).toHaveLength(70_023)
  })
  it('上游JSON特殊键保持普通数据，不能改变结果或全局对象原型', () => {
    const data = JSON.parse('{"__proto__":{"polluted":"synthetic"},"results":[]}')
    const result = limitSearchResult(data)
    expect(Object.getPrototypeOf(result)).toBeNull()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(result.__proto__).toEqual({ polluted: 'synthetic' })
  })
  it('搜索响应最后一片后取消仍拒绝，不把已取消请求报告成成功', async () => {
    const controller = new AbortController(); let closed = false
    const response = { status: 200, headers: {}, body: (async function* () { yield encoder.encode('{"ok":true}'); controller.abort() })(), cancel: () => { closed = true } }
    await expect(readSearchResponse(response, '合成搜索', controller.signal)).rejects.toThrow()
    expect(closed).toBe(true)
  })
})
