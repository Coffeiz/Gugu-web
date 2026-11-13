import { describe, expect, it } from 'vitest'
import type { CanonicalMessage } from '../../../src/agent/harness/contracts.js'
import type { JsonObject } from '../../../src/agent/providers/contracts.js'
import type { ProviderConfig, ProviderWire } from '../../../src/agent/providers/contracts.js'
import { ProviderRuntime } from '../../../src/agent/providers/runtime.js'
import { runContextBranch } from '../../../src/agent/harness/context/reflection.js'
import { outputBudget, parseStructuredJson } from '../../../src/agent/providers/standalone.js'
import { providerSelection } from '../../../src/agent/providers/registry.js'
import { streamWithRetry } from '../../../src/agent/providers/retry.js'
import { ProviderError } from '../../../src/agent/providers/errors.js'
import { MessageArea, canonicalToolRound } from '../../../src/agent/harness/history/canonical-history.js'
import { anthropicDriver, anthropicPolicy } from '../../../src/agent/providers/anthropic/driver.js'
import { mergeOpenaiSystemMessages, prepareOpenAiCache, projectOpenai, renderOpenaiHistory, sanitizeOpenaiToolHistory, transformOpenaiWireHistory } from '../../../src/agent/providers/openai/history.js'
import { normalizedToolCall, normalizeOpenaiUsage, openaiDriver, openaiPolicy } from '../../../src/agent/providers/openai/driver.js'
import { customPolicy, digest, events, invocation, sse, tool, transport } from './openai-fixtures.js'

function branchRuntime(config: ProviderConfig, payload: unknown) {
  const f = transport(payload); let id = 0
  const runtime = new ProviderRuntime({ digest, nextId: () => `branch-${++id}`, transport: f.deps.transport,
    references: { dehydrate: async entry => structuredClone(entry.message), hydrate: async entry => structuredClone(entry.message) },
    prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
    resolve: async (_identity, modelIdentity) => ({ modelIdentity, accessScopeHash: 'scope-synthetic', config, systemPrompt: '规则' }) })
  const branch = (hasHistory: boolean, thinking?: string, maxOutputTokens?: number) => runContextBranch<ProviderWire>({ ownerId: 'owner-synthetic', sessionId: 'session-synthetic', runId: 'run-synthetic', stableSystem: '规则', delta: '追加任务', tools: [],
    ...(hasHistory ? { canonicalHistory: [{ role: 'user', content: '历史问题' }] } : {}) }, { name: 'reflection', outputMode: 'json', maxOutputTokens },
  { digest, nextId: () => `branch-${++id}`, pauseBeforeRetry: async () => undefined, diagnostic: () => undefined,
    provider: { isInputRejected: () => false, complete: request => runtime.completeBranch({ ...request, modelIdentity: 'model-synthetic', thinking }) } })
  return { ...f, runtime, branch }
}

describe('OpenAI协议能力与历史投影', () => {
  it.each(['openai', 'ollama'] as const)('%s摘要wire清参只改调用参数，保留并行ID、思考和结果，重复变换不虚报改变', protocol => {
    const history: JsonObject[] = [{ role: 'system', content: '固定前缀' },
      { role: 'assistant', content: '读取说明', reasoning_content: 'synthetic-private', thinking: 'synthetic-native', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read', arguments: protocol === 'ollama' ? { path: 'synthetic' } : '{ "path": "synthetic" }' } },
        { id: 'b', type: 'function', function: { name: 'lookup', arguments: protocol === 'ollama' ? { q: '合成' } : '{"q":"合成"}' } },
      ] }, { role: 'tool', tool_call_id: 'a', tool_name: 'read', content: '{"arguments":{"不得清除":"结果正文"}}' },
      { role: 'tool', tool_call_id: 'b', tool_name: 'lookup', content: '完整回执' }, { role: 'assistant', content: '最新正文' }]
    const original = structuredClone(history), transformed = transformOpenaiWireHistory(history, 'strip-tool-inputs', 1, protocol)
    expect(transformed.changedMessages).toBe(1)
    const expected = structuredClone(original)
    for (const call of expected[1]!.tool_calls as JsonObject[]) (call.function as JsonObject).arguments = protocol === 'ollama' ? {} : '{}'
    expect(transformed.messages).toEqual(expected); expect(history).toEqual(original)
    expect(transformOpenaiWireHistory(transformed.messages, 'strip-tool-inputs', 1, protocol).changedMessages).toBe(0)
  })
  it('Chat摘要裁旧按并行调用和全部结果原子移除，固定前缀、summary/reminder及最新工具组保留', () => {
    const history: JsonObject[] = [{ role: 'system', content: '固定前缀' }, { role: 'user', content: '受保护的前缀行' }, { role: 'user', content: '最旧问题' },
      { role: 'assistant', reasoning_content: 'old-private', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }, { id: 'b', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'b', content: 'b回执' }, { role: 'tool', tool_call_id: 'a', content: 'a回执' }, { role: 'user', content: '较新问题' },
      { role: 'user', content: '[system-reminder]\n不可裁上下文' }, { role: 'user', content: '<compacted-summary>摘要</compacted-summary>' }, { role: 'user', content: '## 项目\n项目上下文' },
      { role: 'assistant', reasoning_content: 'latest-private', tool_calls: [{ id: 'latest', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'latest', content: '最新回执' }]
    const original = structuredClone(history), transformed = transformOpenaiWireHistory(history, 'trim-oldest-units', 2)
    expect(transformed.changedMessages).toBe(4)
    expect(transformed.messages).toEqual([...original.slice(0, 2), ...original.slice(6)])
    expect(JSON.stringify(transformed.messages)).not.toContain('old-private'); expect(history).toEqual(original)
    const boundary = transformOpenaiWireHistory(history, 'trim-oldest-units', 4)
    expect(boundary.messages).toContainEqual(original[3]); expect(boundary.messages).toContainEqual(original[4]); expect(boundary.messages).toContainEqual(original[5])
  })
  it('异常孤儿和未完成调用整组保护，Ollama仅tool_name回执仍与全部同名并行调用一起裁切', () => {
    const broken: JsonObject[] = [{ role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'foreign', content: '孤儿回执' },
      { role: 'user', content: '可裁旧正文' }, { role: 'user', content: '较新正文' }, { role: 'assistant', content: '最新正文' }, { role: 'user', content: '[system-reminder]\n尾部上下文' }, { role: 'assistant', content: '' }]
    const result = transformOpenaiWireHistory(broken, 'trim-oldest-units', 0)
    expect(result.messages).toEqual([broken[0], broken[1], ...broken.slice(3)]); expect(result.changedMessages).toBe(1)
    const native: JsonObject[] = [{ role: 'assistant', thinking: 'old-private', tool_calls: [{ id: 'a', function: { name: 'read', arguments: {} } }, { id: 'b', function: { name: 'read', arguments: {} } }] },
      { role: 'tool', tool_name: 'read', content: '第一个回执' }, { role: 'tool', tool_name: 'read', content: '第二个回执' }, { role: 'user', content: '较新问题' }, { role: 'assistant', content: '最新正文' }]
    expect(transformOpenaiWireHistory(native, 'trim-oldest-units', 0, 'ollama')).toEqual({ messages: native.slice(3), changedMessages: 3 })
    expect(() => transformOpenaiWireHistory(native, 'trim-oldest-units', -1, 'ollama')).toThrow(ProviderError)
  })
  it('Chat driver实际HTTP采用清参和裁旧后的原生wire，私有思考与回执不被Canonical重投影', async () => {
    const history: JsonObject[] = [{ role: 'system', content: '固定规则' }, { role: 'user', content: '最旧问题' },
      { role: 'assistant', reasoning_content: 'old-private', tool_calls: [{ id: 'old', type: 'function', function: { name: 'lookup', arguments: '{"q":"旧"}' } }] }, { role: 'tool', tool_call_id: 'old', content: '旧回执' },
      { role: 'user', content: '较新问题' }, { role: 'assistant', reasoning_content: 'latest-private', tool_calls: [{ id: 'latest', type: 'function', function: { name: 'lookup', arguments: '{ "q": "新" }' } }] }, { role: 'tool', tool_call_id: 'latest', content: '完整新回执' }]
    const original = structuredClone(history), stripped = openaiDriver.transformHistory(history, 'strip-tool-inputs', 1), trimmed = openaiDriver.transformHistory(stripped.messages, 'trim-oldest-units', 1)
    expect(stripped.changedMessages).toBe(2); expect(trimmed.changedMessages).toBe(3)
    for (const stage of [stripped, trimmed]) {
      const f = transport({ choices: [{ message: { content: '摘要完成' }, finish_reason: 'stop' }] })
      await openaiDriver.complete(invocation({ history: stage.messages, system: '', policy: customPolicy({ explicitCache: () => false }), purpose: 'branch', hasHistory: true }), f.deps)
      expect((f.requests[0]!.body as JsonObject).messages).toEqual(stage.messages)
    }
    expect(history).toEqual(original)
  })
  it('普通Chat真实流不声明Responses续接材料，配置continuation也不发送Responses状态字段', async () => {
    const f = transport(sse({ choices: [{ delta: { content: '普通合成回复' }, finish_reason: 'stop' }] }), { raw: true })
    const output = await events(openaiDriver.stream(invocation({ config: { provider: 'openai', model: 'gpt-test', reasoning_persistence: 'continuation' } }), f.deps))
    expect(output.at(-1)).toMatchObject({ type: 'complete', text: '普通合成回复', calls: [] })
    expect(output.at(-1)).not.toHaveProperty('continuation')
    const body = f.requests[0]!.body as JsonObject
    expect(body.previous_response_id).toBeUndefined(); expect(body.include).toBeUndefined()
    expect(body.input).toBeUndefined(); expect(body.store).toBeUndefined()
  })
  it('同一MessageArea跨OpenAI和Anthropic投影保持revision、digest及工具schema元数据，协议形状各自正确', () => {
    let sequence = 0
    const area = new MessageArea({ digest, nextId: () => `area-${++sequence}` })
    const schema = { type: 'tool-schema', tool_name: 'lookup', schema_version: 2, schema_digest: 'synthetic-schema', implementation_digest: 'synthetic-implementation', schema: { name: 'lookup', input_schema: { type: 'object' } } }
    area.configureRequest([{ role: 'system', content: '固定规则' }])
    area.appendBatch([
      { message: { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'lookup', arguments: '{ "q": "合成" }' }] }, source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-a' },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '合成结果' }] }, source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-a' },
      { message: { role: 'user', content: [schema] }, source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-a' },
    ], { round_id: 'round-a', schema_digest: 'synthetic-schema' })
    const before = area.snapshot(), identity = area.identity('model-synthetic')
    const canonical = [...area.requestPrefix, ...area.messages], original = structuredClone(canonical)
    const openai = openaiDriver.project(canonical, { model: 'm' }, openaiPolicy, { digest })
    const anthropic = anthropicDriver.project(canonical, { model: 'm' }, anthropicPolicy, { digest })
    expect(openai[1]!.tool_calls).toEqual([{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{ "q": "合成" }' } }])
    expect(openai[2]).toEqual({ role: 'tool', tool_call_id: 'a', content: '合成结果' })
    expect(anthropic[1]!.content).toEqual([{ type: 'tool_use', id: 'a', name: 'lookup', input: { q: '合成' } }])
    expect(anthropic[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'a', content: '合成结果' }])
    expect(JSON.stringify(openai[3])).toContain('canonical tool-schema')
    expect(JSON.stringify(anthropic[3])).toContain('canonical tool-schema')
    expect(canonical).toEqual(original)
    expect(area.snapshot()).toEqual(before)
    expect(area.revision).toBe(before.revision); expect(area.digest()).toBe(before.digest)
    expect(area.identity('model-synthetic')).toEqual(identity)
    expect(area.entries[2]!.message.content).toEqual([schema])
    expect(area.snapshot().batches[0]!.metadata).toEqual({ round_id: 'round-a', schema_digest: 'synthetic-schema' })
  })
  it('实际dispatch子集构成Canonical工具轮后真实Chat请求不复活未派发的并行兄弟', async () => {
    const canonical = canonicalToolRound({ text: '先查资料', calls: [{ id: 'a', name: 'lookup', input: { q: '合成' }, rawArguments: '{ "q": "合成" }' }, { id: 'not-dispatched', name: 'write', input: {} }],
      dispatched: [{ callId: 'a', content: '已查到', toolName: 'lookup' }] })
    const original = structuredClone(canonical), projected = openaiDriver.project(canonical, { model: 'm' }, openaiPolicy, { digest })
    const f = transport({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] })
    await openaiDriver.complete(invocation({ history: projected }), f.deps)
    const sent = (f.requests[0]!.body as JsonObject).messages as JsonObject[]
    expect(JSON.stringify(sent)).not.toContain('not-dispatched')
    expect(sent.find(row => row.role === 'assistant')!.tool_calls).toEqual([{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{ "q": "合成" }' } }])
    expect(sent.find(row => row.role === 'tool')).toMatchObject({ tool_call_id: 'a' })
    expect(canonical).toEqual(original)
  })
  it.each([
    ['gpt-5-pro', ['high']], ['gpt-5.6-preview', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']], ['gpt-6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.5', ['low', 'medium', 'high', 'xhigh']], ['gpt-5-mini', ['minimal', 'low', 'medium', 'high']], ['other', []],
  ])('只向官方端点的%s发送其支持的推理档位', (model, efforts) => {
    expect(openaiPolicy.reasoningCapabilities({ provider: 'openai', model: model as string }, 'responses').efforts).toEqual(efforts)
    expect(openaiPolicy.reasoningCapabilities({ provider: 'openai', base_url: 'https://synthetic.example/v1', model: model as string }, 'responses').efforts).toEqual([])
  })
  it('官方cache key/store/include能力不能扩散到兼容服务或相似域名', () => {
    const official = { provider: 'openai', model: 'gpt-test' }
    expect(openaiPolicy.responsesPromptCacheKey(official)).toBe(true)
    expect(openaiPolicy.responsesStore(official)).toBe(false)
    for (const config of [{ ...official, provider: 'other' }, { ...official, base_url: 'https://api.openai.com.synthetic.example/v1' }]) {
      expect(openaiPolicy.responsesPromptCacheKey(config)).toBe(false)
      expect(openaiPolicy.responsesStore(config)).toBeUndefined()
    }
  })
  it('原始工具参数字节不变，Canonical未被wire字段或媒体提取改写', () => {
    const raw = '{ "q": "合成查询" }', canonical: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call-a', name: 'lookup', arguments: raw, responses_item_id: 'fc-a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call-a', content: [{ type: 'text', text: '结果' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] },
    ]
    const original = structuredClone(canonical), result = projectOpenai(canonical, { model: 'test', image: true }, openaiPolicy)
    expect(result[0]!.tool_calls).toEqual([{ id: 'call-a', type: 'function', function: { name: 'lookup', arguments: raw } }])
    expect(result[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-a', content: '结果' })
    expect(JSON.stringify(result[2])).toContain('data:image/png;base64,AAAA')
    expect(canonical).toEqual(original)
    const textOnly = projectOpenai(canonical, { model: 'test', image: false }, openaiPolicy)
    expect(textOnly).toHaveLength(2)
    expect(textOnly[1]!.content).toBe('结果\n[图片结果已返回，但当前模型不支持视觉输入]')
    const media: CanonicalMessage[] = [canonical[0]!, { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call-a', content: [{ type: 'text', text: '媒体正文' },
      { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } }, { type: 'video_url', video_url: { url: 'synthetic-video' } }] }] }]
    const forwarded = projectOpenai(media, { model: 'test', audio: true, video: true }, openaiPolicy)
    expect(forwarded[1]!.content).toBe('媒体正文')
    expect((forwarded[2]!.content as JsonObject[]).map(part => part.type)).toEqual(['text', 'input_audio', 'video_url'])
    const plain = projectOpenai([canonical[0]!, { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call-a', content: '{"count": 0}' }] }], { model: 'm' }, openaiPolicy)
    expect(plain).toHaveLength(2); expect(plain[1]).toMatchObject({ role: 'tool', content: '{"count": 0}' })
  })
  it('孤儿结果与未完成调用被清理，重复调用/结果只保留首次，保留原模型顺序', () => {
    const call = (id: string) => ({ id, type: 'function', function: { name: 'lookup', arguments: '{}' } })
    const rows: JsonObject[] = [{ role: 'tool', tool_call_id: 'orphan', content: '孤儿' },
      { role: 'assistant', content: '前文', tool_calls: [call('b'), call('a'), call('a'), call('missing')] },
      { role: 'tool', tool_call_id: 'a', content: 'a结果' }, { role: 'tool', tool_call_id: 'a', content: '重复' },
      { role: 'tool', tool_call_id: 'b', content: 'b结果' }, { role: 'tool', tool_call_id: 'foreign', content: '无对应' },
      { role: 'assistant', content: '保留正文', tool_calls: [call('unanswered')] }]
    const result = sanitizeOpenaiToolHistory(rows)
    expect(result.map(row => row.role)).toEqual(['assistant', 'tool', 'tool', 'assistant'])
    expect(result[0]!.tool_calls).toEqual([call('b'), call('a')]); expect(result[3]!.tool_calls).toBeUndefined()
    expect(rows[0]!.content).toBe('孤儿')
  })
  it('动态尾部不能补配稳定历史中的半个工具轮', () => {
    const result = projectOpenai([{ role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '尾部孤儿' }] }], { model: 'test' }, openaiPolicy, { dynamicTailSize: 1 })
    expect(result).toEqual([])
  })
  it.each(['deepseek', 'openai'])('%s真实HTTP请求清理孤儿后才计算缓存，原始投影仍保留孤儿行', async provider => {
    const selected = providerSelection({ provider, model: provider === 'deepseek' ? 'deepseek-chat' : 'gpt-test', api_format: 'openai' })
    const history: JsonObject[] = [{ role: 'system', content: '固定前缀' }, { role: 'tool', tool_call_id: 'orphan', content: '不应发送的孤儿' }, { role: 'user', content: '【消息正文】\n看这张图' }]
    const before = structuredClone(history), f = transport({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    await selected.driver.complete(invocation({ config: selected.config, policy: selected.policy, history, system: '固定前缀' }), f.deps)
    const sent = (f.requests[0]!.body as JsonObject).messages as JsonObject[]
    expect(sent.map(message => message.role)).toEqual(['system', 'user'])
    expect(JSON.stringify(sent)).not.toContain('不应发送的孤儿')
    expect(sent[1]!.content).toEqual(provider === 'deepseek' ? '【消息正文】\n看这张图' : [{ type: 'text', text: '【消息正文】\n看这张图', cache_control: { type: 'ephemeral' } }])
    if (provider === 'deepseek') expect(sent).toEqual([before[0], before[2]])
    expect(history).toEqual(before)
  })
  it('system在副本中按原序合并置顶，字符串与文本块等价，基础system不重复', async () => {
    const result = mergeOpenaiSystemMessages([{ role: 'user', content: '问题' }, { role: 'system', content: '基础' }, { role: 'system', content: [{ type: 'text', text: '快照' }] }], '基础')
    expect(result).toEqual([{ role: 'system', content: [{ type: 'text', text: '基础' }, { type: 'text', text: '\n\n---\n\n' }, { type: 'text', text: '快照' }] }, { role: 'user', content: '问题' }])
    expect(mergeOpenaiSystemMessages(result, '基础')).toEqual(result)
    for (const content of ['基础\n\n会话快照', [{ type: 'text', text: '基础' }, { type: 'text', text: '会话快照' }]]) {
      const prefix: JsonObject[] = [{ role: 'system', content }, { role: 'user', content: '合成提问' }, { role: 'assistant', content: '合成回答' }], before = structuredClone(prefix)
      const f = transport({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
      await openaiDriver.complete(invocation({ policy: customPolicy({ explicitCache: () => false }), history: [...prefix, { role: 'user', content: '只做反思' }], system: '基础', stableHistoryCount: prefix.length, hasHistory: true, purpose: 'branch' }), f.deps)
      expect((f.requests[0]!.body as JsonObject).messages).toEqual([...before, { role: 'user', content: '只做反思' }])
      expect(prefix).toEqual(before)
    }
  })
  it('原生reasoning只从显式续接材料回放，不从Canonical私有块漏给用户', () => {
    const rows: CanonicalMessage[] = [{ role: 'assistant', content: [{ type: 'thinking', thinking: '不应发送' }, { type: 'tool_call', id: 'a', name: 'lookup', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '结果' }] }]
    expect(JSON.stringify(renderOpenaiHistory(rows))).not.toContain('不应发送')
    const projected = openaiDriver.project(rows, { model: 'test' }, openaiPolicy, { continuation: { reasoningByCall: { a: '合成原生思考' } } })
    expect(projected[0]!.reasoning_content).toBe('合成原生思考')
  })
})

describe('OpenAI缓存、分片与真实请求边界', () => {
  it.each([
    ['deepseek', 'deepseek-flash', true], ['deepseek', 'deepseek-flash', false], ['qwen', 'qwen3-max', true], ['qwen', 'qwen3-max', false],
    ['glm', 'glm-4.6', true], ['glm', 'glm-4.6', false], ['mimo', 'mimo-v2-flash', true], ['mimo', 'mimo-v2-flash', false],
    ['ollama', 'qwen3', true], ['ollama', 'qwen3', false], ['minimax', 'MiniMax-M3.1-Flash-Preview', true], ['minimax', 'MiniMax-M3.1-Flash-Preview', false],
  ] as const)('%s/%s真实registry分支有历史=%s时保持JSON策略与业务校验', async (provider, model, hasHistory) => {
    const f = branchRuntime({ provider, model, api_format: 'openai', ollama_api_mode: 'openai' }, { choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] })
    try {
      expect(await f.branch(hasHistory)).toMatchObject({ ok: true, output: { ok: 1 } })
      expect((f.requests[0]!.body as JsonObject).response_format).toEqual(hasHistory || provider === 'minimax' ? undefined : { type: 'json_object' })
    } finally { await f.runtime.close() }
  })
  it.each([['deepseek', 'deepseek-flash'], ['qwen', 'qwen3-max'], ['glm', 'glm-4.6'], ['mimo', 'mimo-v2-flash'], ['ollama', 'qwen3'], ['minimax', 'MiniMax-M3.1-Flash-Preview']] as const)('%s追加分支非JSON不能变成可应用的反思结果', async (provider, model) => {
    const f = branchRuntime({ provider, model, api_format: 'openai', ollama_api_mode: 'openai' }, { choices: [{ message: { content: '这不是JSON' }, finish_reason: 'stop' }] })
    try { expect(await f.branch(true)).toMatchObject({ ok: false, output: null, reason: 'schema_invalid' }) }
    finally { await f.runtime.close() }
  })
  it('baseline跨请求稳定，图片后的消息与动态尾不推进缓存，单锚点策略只标最新稳定行', () => {
    const history = [{ role: 'system', content: 'system' }, { role: 'user', content: '第一问' }, { role: 'assistant', content: '回答' }, { role: 'user', content: '第二问' }]
    const first = prepareOpenAiCache(history, openaiPolicy, { model: 'm' }, digest, 4)
    expect(JSON.stringify(first.messages[1])).toContain('cache_control')
    expect(JSON.stringify(first.messages[3])).toContain('cache_control')
    const next = prepareOpenAiCache([...history, { role: 'assistant', content: '新回答' }, { role: 'user', content: '第三问' }], openaiPolicy, { model: 'm' }, digest, 6, first.anchor)
    expect(next.anchor!.baseline_digest).toBe(first.anchor!.baseline_digest)
    const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
    const bounded = prepareOpenAiCache([...history, image, { role: 'user', content: '图片之后' }], openaiPolicy, { model: 'm' }, digest, 5)
    expect(JSON.stringify(bounded.messages.slice(4))).not.toContain('cache_control')
    expect(prepareOpenAiCache([image], openaiPolicy, { model: 'm' }, digest, 1).anchor).toBeNull()
    expect(prepareOpenAiCache([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }], openaiPolicy, { model: 'm' }, digest, 1).anchor).toBeNull()
    const recovered = prepareOpenAiCache([{ role: 'user', content: '下一轮稳定消息' }, { role: 'assistant', content: '下一轮稳定回复' }], openaiPolicy, { model: 'm' }, digest, 2)
    expect(recovered.messages[1]!.content).toEqual([{ type: 'text', text: '下一轮稳定回复', cache_control: { type: 'ephemeral' } }])
    const single = prepareOpenAiCache(history, customPolicy({ singleHistoryCacheAnchor: () => true }), { model: 'm' }, digest, 4)
    expect(JSON.stringify(single.messages[1])).not.toContain('cache_control')
    expect(JSON.stringify(single.messages[3])).toContain('cache_control')
  })
  it('真实Chat请求用正确工具schema、缓存用量与参数字节，工具按index重组而不输出思考', async () => {
    const f = transport(sse(
      { choices: [{ delta: { reasoning_content: '私有思考', tool_calls: [{ index: 1, id: 'b', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { content: '你好', tool_calls: [{ index: 0, id: 'a', function: { name: 'lookup', arguments: '{ "q": "a" }' } }, { index: 1, function: { arguments: '"b"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 70 } } }, '[DONE]'), { raw: true, chunkSize: 7 })
    const output = await events(openaiDriver.stream(invocation({ tools: [tool], config: { provider: 'openai', model: 'gpt-5.6', api_key: 'synthetic-key', reasoning_effort: 'high', max_tokens: 1000 } }), f.deps))
    const done = output.find(event => event.type === 'complete')!
    expect(done).toMatchObject({ type: 'complete', text: '你好', calls: [{ id: 'a', name: 'lookup', input: { q: 'a' }, rawArguments: '{ "q": "a" }' }, { id: 'b', input: { q: 'b' } }] })
    expect(output.filter(event => event.type === 'token')).toEqual([{ type: 'token', text: '你好' }])
    expect(output.find(event => event.type === 'usage')).toMatchObject({ usage: { input: 30, output: 8, cacheRead: 70, cacheWrite: 0, contextInput: 100 } })
    expect(f.requests[0]).toMatchObject({ url: 'https://api.openai.com/v1/chat/completions', headers: { Authorization: 'Bearer synthetic-key' }, body: { tools: [tool], tool_choice: 'auto', reasoning_effort: 'high', max_tokens: 1000, stream_options: { include_usage: true } } })
    expect(f.cancel).toHaveBeenCalledTimes(1)
  })
  it.each(['{"q":', '[]', 'null'])('截断或非对象参数%s标记拒派发，而非空对象正常工具调用', raw => {
    expect(normalizedToolCall('a', 'lookup', raw)).toMatchObject({ id: 'a', input: {}, parseError: raw === '{"q":' ? 'invalid_json' : 'not_object' })
  })
  it('缺usage不估算，兼容cache write不重复计入完整输入', () => {
    expect(normalizeOpenaiUsage(undefined).contextInput).toBeNull()
    expect(normalizeOpenaiUsage({ input_tokens: 100, cached_tokens: 60, cache_write_tokens: 15 })).toEqual({ input: 25, output: 0, cacheRead: 60, cacheWrite: 15, contextInput: 100 })
  })
  it('Chat流EOF没有finish不是正常空答，错误不包含上游正文或密钥', async () => {
    const f = transport(sse({ choices: [{ delta: { content: '半个回复' } }] }), { raw: true })
    await expect(events(openaiDriver.stream(invocation(), f.deps))).rejects.toMatchObject({ code: 'stream_incomplete' })
    const error = transport(sse({ error: { message: 'synthetic-secret 用户正文' } }), { raw: true })
    await expect(events(openaiDriver.stream(invocation(), error.deps))).rejects.toThrow('模型服务请求失败')
    expect(error.diagnose).toHaveBeenCalled()
  })
  it('真实Chat两次429后第三次成功，重试1/2沿共享节奏且Harness类别保持rate_limited', async () => {
    const rejected = transport({ error: { message: '合成上游限流' } }, { status: 429 }), success = transport(sse({ choices: [{ delta: { content: '最终成功' }, finish_reason: 'stop' }] }), { raw: true })
    const requests: JsonObject[] = [], pauses: number[] = [], input = invocation()
    const deps = { ...success.deps, transport: { request: async (...args: Parameters<typeof success.deps.transport.request>) => {
      requests.push(structuredClone(args[0].body) as JsonObject)
      return (requests.length <= 2 ? rejected.deps : success.deps).transport.request(...args)
    } } }
    const output = await events(streamWithRetry(() => openaiDriver.stream(input, deps), input.signal, { clock: { now: () => 0, sleep: async ms => { pauses.push(ms) } } }))
    expect(requests).toHaveLength(3); expect(requests[0]).toEqual(requests[1]); expect(requests[1]).toEqual(requests[2])
    expect(pauses).toEqual([5000, 5000])
    expect(output.filter(event => event.type === 'retry')).toMatchObject([{ attempt: 1, errorCode: 'rate_limited' }, { attempt: 2, errorCode: 'rate_limited' }])
    expect(output.at(-1)).toMatchObject({ type: 'complete', text: '最终成功' })
  })
  it('真实Chat的maxRetries=2只发送三次429请求，耗尽安全失败而不泄漏上游正文', async () => {
    const f = transport({ error: { message: 'synthetic-secret 上游私有正文' } }, { status: 429 }), input = invocation(), pauses: number[] = [], output: import('../../../src/agent/harness/contracts.js').ProviderEvent[] = []
    const failure = await (async () => {
      for await (const event of streamWithRetry(() => openaiDriver.stream(input, f.deps), input.signal, { maxRetries: 2, clock: { now: () => 0, sleep: async ms => { pauses.push(ms) } } })) output.push(event)
    })().catch(error => error as unknown)
    expect(failure).toMatchObject({ code: 'rate_limit', options: { retryable: true, status: 429 } })
    expect(JSON.stringify(failure)).not.toContain('synthetic-secret')
    expect(f.requests).toHaveLength(3); expect(f.cancel).toHaveBeenCalledTimes(3); expect(pauses).toEqual([5000, 5000])
    expect(output.filter(event => event.type === 'retry').map(event => event.type === 'retry' ? event.attempt : null)).toEqual([1, 2])
    expect(output.filter(event => event.type === 'complete')).toEqual([])
  })
  it('仅部分工具参数或私有思考后断流也标记已输出，不能按无可见token重放', async () => {
    for (const delta of [{ tool_calls: [{ index: 0, id: 'a', function: { name: 'lookup', arguments: '{"q":' } }] }, { reasoning_content: '合成私有思考' }]) {
      const encoded = new TextEncoder().encode(sse({ choices: [{ delta }] }))
      const f = transport({})
      f.deps.transport.request = async () => ({ status: 200, headers: {}, cancel: f.cancel, body: (async function* () { yield encoded; throw new Error('synthetic断流') })() })
      await expect(events(openaiDriver.stream(invocation(), f.deps))).rejects.toMatchObject({ options: { outputStarted: true } })
      expect(f.cancel).toHaveBeenCalledTimes(1)
    }
  })
  it('Chat媒体未获当前模型声明时在发送前拒绝', async () => {
    const f = transport({})
    await expect(openaiDriver.complete(invocation({ history: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'synthetic-image' } }] }] }), f.deps)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.requests).toEqual([])
  })
  it('URL猜出的Ollama策略不赋予普通BYOK内网权限，必须显式local配置', async () => {
    const policy = customPolicy({ name: 'ollama' })
    for (const provider of ['other', 'local', ' LOCAL ']) {
      const f = transport({ choices: [{ message: { content: '结果' }, finish_reason: 'stop' }] })
      await openaiDriver.complete(invocation({ policy, config: { provider, model: 'm', base_url: 'http://synthetic.example:11434' } }), f.deps)
      expect(f.requests[0]!.allowLocal).toBe(provider.trim().toLowerCase() === 'local')
    }
  })
  it('消费者提前return关闭真实响应，不预读完整流', async () => {
    const f = transport(sse({ choices: [{ delta: { content: '第一块' } }] }, { choices: [{ delta: { content: '第二块' }, finish_reason: 'stop' }] }), { raw: true, chunkSize: 1 })
    const iterator = openaiDriver.stream(invocation(), f.deps)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'token', text: '第一块' })
    const before = f.pulls(); await iterator.return?.()
    expect(f.pulls()).toBe(before); expect(f.cancel).toHaveBeenCalledTimes(1)
  })
  it('独立complete返回可见正文，JSON追加分支不额外发送response_format', async () => {
    const policy = customPolicy({ structuredOutput: () => ({ response_format: { type: 'json_object' } }) })
    for (const hasHistory of [false, true]) {
      const f = transport({ choices: [{ message: { content: '{"ok":true}', reasoning_content: '私有思考' }, finish_reason: 'stop' }] })
      const result = await openaiDriver.complete(invocation({ policy, outputMode: 'json', hasHistory }), f.deps)
      expect(result.text).toBe('{"ok":true}')
      expect((f.requests[0]!.body as Record<string, unknown>).response_format).toEqual(hasHistory ? undefined : { type: 'json_object' })
    }
  })
  it('无历史追加分支仍标记新增基础system，动态任务不进入缓存锚点且无空tools', async () => {
    const f = transport({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    await openaiDriver.complete(invocation({ purpose: 'branch', history: [{ role: 'user', content: '动态任务' }], stableHistoryCount: 0, hasHistory: false }), f.deps)
    expect((f.requests[0]!.body as JsonObject).messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: '固定规则', cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: '动态任务' },
    ])
    expect((f.requests[0]!.body as JsonObject).tools).toBeUndefined()
    const plain = transport({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    await openaiDriver.complete(invocation({ policy: customPolicy({ explicitCache: () => false }), purpose: 'branch', history: [{ role: 'user', content: '动态任务' }], stableHistoryCount: 0 }), plain.deps)
    expect((plain.requests[0]!.body as JsonObject).messages).toEqual([{ role: 'system', content: '固定规则' }, { role: 'user', content: '动态任务' }])
    const snapshot = transport({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    await openaiDriver.complete(invocation({ purpose: 'branch', history: [{ role: 'system', content: '固定规则' }, { role: 'system', content: '会话快照' }, { role: 'user', content: '动态任务' }], stableHistoryCount: 2 }), snapshot.deps)
    expect((snapshot.requests[0]!.body as JsonObject).messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: '固定规则\n\n---\n\n会话快照', cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: '动态任务' },
    ])
    const tools = transport({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    await openaiDriver.complete(invocation({ purpose: 'branch', tools: [tool] }), tools.deps)
    expect((tools.requests[0]!.body as JsonObject).tools).toEqual([tool]); expect((tools.requests[0]!.body as JsonObject).tool_choice).toBe('auto')
  })
  it('显式null输出预算保持provider默认，不被模型配置max_tokens覆盖', async () => {
    const f = transport({ choices: [{ message: { content: '可见' }, finish_reason: 'stop' }] })
    await openaiDriver.complete(invocation({ maxOutputTokens: null, config: { provider: 'openai', model: 'm', max_tokens: 123 } }), f.deps)
    expect((f.requests[0]!.body as JsonObject).max_tokens).toBeUndefined()
    const plain = { provider: 'openai', model: 'gpt-4o', api_format: 'responses' }
    expect(outputBudget(plain, openaiPolicy, null)).toBeNull()
    expect(outputBudget(plain, openaiPolicy, 80)).toBe(80)
  })
  it('独立Responses可见JSON与推理预算按真实模型处理，临时关闭思考不修改配置或发送续接', async () => {
    const config: ProviderConfig = { provider: 'minimax', model: 'MiniMax-M3', api_format: 'responses', thinking: 'adaptive', reasoning_persistence: 'continuation' }, original = structuredClone(config)
    const f = branchRuntime(config, { output_text: '错误聚合中的私有思考', output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: '私有思考' }] }, { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] })
    const identity = { ownerId: 'owner-synthetic', sessionId: 'session-synthetic', runId: 'run-synthetic' }
    try {
      expect(await f.runtime.completeText(identity, 'model-synthetic', '独立输入', 40)).toBe('{"ok":true}')
      const standalone = f.requests[0]!.body as JsonObject
      expect(standalone.max_output_tokens).toBeGreaterThanOrEqual(4096)
      expect(standalone.input).toEqual([{ role: 'user', content: '独立输入' }]); expect(standalone.include).toBeUndefined(); expect(standalone.previous_response_id).toBeUndefined()
      await f.runtime.completeBranch({ ...identity, modelIdentity: 'model-synthetic', stableSystem: '规则', delta: '输入', tools: [], maxOutputTokens: 900 })
      expect((f.requests[1]!.body as JsonObject).max_output_tokens).toBeGreaterThanOrEqual(4096)
      expect(await f.runtime.completeBranch({ ...identity, modelIdentity: 'model-synthetic', stableSystem: '规则', delta: '输入', tools: [], maxOutputTokens: 1024, thinking: 'disabled' })).toMatchObject({ output: '{"ok":true}' })
      const branch = f.requests[2]!.body as JsonObject
      expect(branch.max_output_tokens).toBe(1024); expect(branch.reasoning).toBeUndefined(); expect(config).toEqual(original)
      expect(await f.branch(false, 'disabled', 1024)).toMatchObject({ ok: true, output: { ok: true } })
      const json = f.requests[3]!.body as JsonObject
      expect(json.max_output_tokens).toBe(1024); expect(json.reasoning).toBeUndefined(); expect(config).toEqual(original)
    } finally { await f.runtime.close() }
  })
  it('真实Provider分支JSON解析只读可见正文，不从完整或未闭合thinking中取对象', async () => {
    for (const [content, valid] of [['<think>{"ok":false}</think>{"ok":true}', true], ['<think>{"ok":false}', false]] as const) {
      expect(parseStructuredJson(content)).toEqual(valid ? { ok: true } : {})
      const f = branchRuntime({ provider: 'openai', model: 'gpt-test' }, { choices: [{ message: { content }, finish_reason: 'stop' }] })
      try { expect(await f.branch(true)).toMatchObject({ ok: valid, output: valid ? { ok: true } : null }) }
      finally { await f.runtime.close() }
    }
  })
  it('实际usage独立交给受控hook，hook修改副本或失败不污染正常流和缺报语义', async () => {
    const f = transport(sse({ choices: [{ delta: { content: '可见' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } }), { raw: true })
    const captured: unknown[] = []
    const result = await events(openaiDriver.stream(invocation(), { ...f.deps, onUsage: (raw, normalized) => {
      captured.push(structuredClone({ raw, normalized })); (raw as Record<string, unknown>).prompt_tokens = 999; throw new Error('合成probe不可用')
    } }))
    expect(captured).toEqual([{ raw: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } }, normalized: { input: 40, output: 7, cacheRead: 60, cacheWrite: 0, contextInput: 100 } }])
    expect(result.find(event => event.type === 'usage')).toMatchObject({ usage: { contextInput: 100 } })
    expect(result.at(-1)).toMatchObject({ type: 'complete', text: '可见' })
    const missing = transport({ choices: [{ message: { content: '可见' }, finish_reason: 'stop' }] }), noUsage: unknown[] = []
    const complete = await openaiDriver.complete(invocation(), { ...missing.deps, onUsage: (raw, normalized) => noUsage.push({ raw, normalized }) })
    expect(noUsage).toEqual([{ raw: null, normalized: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null } }])
    expect(complete.usage.contextInput).toBeNull()
  })
  it('已取消请求在transport前停止，不把取消识别为协议失败', async () => {
    const controller = new AbortController(); controller.abort(new ProviderError('cancelled'))
    const f = transport({})
    await expect(openaiDriver.complete(invocation({ signal: controller.signal }), f.deps)).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.requests).toEqual([])
  })
  it('读取非成功HTTP响应正文时取消仍返回cancelled，不能被429分类覆盖', async () => {
    const controller = new AbortController()
    const f = transport({ error: { message: '合成服务限流' } }, { status: 429, chunkSize: 4, afterChunk: () => controller.abort() })
    await expect(openaiDriver.complete(invocation({ signal: controller.signal }), f.deps)).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.cancel).toHaveBeenCalledTimes(1)
  })
})
