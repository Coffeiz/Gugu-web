import { describe, expect, it, vi } from 'vitest'
import type { CanonicalHarnessContext, CanonicalMessage } from '../../../src/agent/harness/contracts.js'
import type { CanonicalContextPorts, HarnessPorts } from '../../../src/agent/harness/ports.js'
import { createCanonicalHarness } from '../../../src/agent/harness/index.js'
import { createReflectionFinalizer, ReflectionSnapshots } from '../../../src/agent/harness/context/reflection.js'
import { connectProviderHarness } from '../../../src/agent/providers/runtime.js'
import type { JsonObject, ProviderConfig, ProviderHttpRequest, ProviderWire } from '../../../src/agent/providers/contracts.js'
import { ProviderError } from '../../../src/agent/providers/errors.js'
import { streamWithRetry } from '../../../src/agent/providers/retry.js'
import { providerSelection } from '../../../src/agent/providers/registry.js'
import { insertResponsesReasoning, responsesContent, responsesDriver, responsesInput, responsesInstructions, responsesOutputText, responsesTools } from '../../../src/agent/providers/openai-responses.js'
import { openaiPolicy } from '../../../src/agent/providers/openai.js'
import { customPolicy, digest, events, invocation, sse, tool, transport } from './openai-fixtures.js'
import { collect, fixture, identity } from '../harness/run/fixtures.js'

/** 只替换存储及HTTP边界；上下文准备、工具轮、Provider和收尾均走生产组合。 */
function responsesHarness(scripts: readonly string[], continuation: boolean) {
  let id = 0, next = 0
  const sent: ProviderHttpRequest[] = []
  const prefix: CanonicalMessage[] = [{ role: 'system', content: '[system-reminder]\n会话快照' }]
  const config: ProviderConfig = { provider: 'openai', model: 'gpt-test', api_format: 'responses', reasoning_persistence: continuation ? 'continuation' : 'off' }
  const complete = vi.fn<CanonicalContextPorts['finalization']['complete']>(async () => undefined)
  const context: CanonicalContextPorts = {
    digest, nextId: () => `responses-entry-${++id}`,
    load: async () => ({ modelIdentity: 'model-a', contextWindow: 10000, accessScopeHash: digest(identity), capabilities: { toolNames: ['lookup'], tools: [{ name: 'lookup', schema: tool }] },
      input: { ...identity, fixedPrefix: prefix, history: [], preparedRag: { tail: [] }, currentUser: { persistedMessageId: 'current', message: { role: 'user', content: '读取合成信息' } } } }),
    preparation: { buildRag: async () => ({ tail: [] }) }, prepareRequest: async () => ({ prefix, dynamicTail: [] }),
    references: { dehydrate: async entry => structuredClone(entry.message), hydrate: async entry => structuredClone(entry.message) },
    compaction: { summarize: async () => { throw new Error('本用例不应压缩') } }, finalization: { complete },
    currentRequest: () => { throw new Error('必须接实际Provider冻结请求') },
    stageContinuation: async () => { throw new Error('必须接实际Provider续接') }, releaseContinuations: async () => undefined, diagnoseCompactionFailure: () => undefined,
  }
  const connected = connectProviderHarness(context, {
    transport: { request: async (request, signal) => {
      sent.push(structuredClone(request))
      const script = scripts[next++]
      if (script === undefined) throw new Error('合成Responses脚本耗尽')
      return transport(script, { raw: true }).deps.transport.request(request, signal)
    } },
    resolve: async () => ({ modelIdentity: 'model-a', accessScopeHash: digest(identity), config, systemPrompt: '基础人格' }),
    clock: { now: () => 0, sleep: async () => undefined },
  })
  const external = fixture([]), runtime = external.ports as unknown as HarnessPorts<CanonicalHarnessContext>
  const harness = createCanonicalHarness({ context: connected.context, executor: { authorize: async () => { throw new Error('不得进入系统执行器') }, executor: { execute: async () => { throw new Error('不得执行进程') } } }, runtime: { ...runtime, provider: connected.provider } })
  return { ...connected, harness, sent, complete, external, config }
}

describe('Responses独立item、媒体及原生前缀协议', () => {
  it('Responses摘要清参和裁旧保留原生item身份，reasoning及工具图片随并行调用和全部结果同组裁切', async () => {
    const history: JsonObject[] = [
      { type: 'reasoning', id: 'rs-old', encrypted_content: 'old-encrypted', status: 'completed' }, { role: 'assistant', content: '旧轮说明' },
      { type: 'function_call', id: 'fc-a', call_id: 'a', name: 'lookup', arguments: '{ "q": "旧a" }' },
      { type: 'function_call', id: 'fc-b', call_id: 'b', name: 'lookup', arguments: '{"q":"旧b"}' },
      { type: 'function_call_output', call_id: 'b', output: '{"arguments":{"这是":"结果"}}' }, { type: 'function_call_output', call_id: 'a', output: '旧完整回执' },
      { role: 'user', content: [{ type: 'input_text', text: '工具返回了以下图片，请结合工具文字结果继续处理。' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' }] },
      { role: 'user', content: '较新问题' },
      { type: 'reasoning', id: 'rs-latest', encrypted_content: 'latest-encrypted', status: 'completed' },
      { type: 'function_call', id: 'fc-latest', call_id: 'latest', name: 'lookup', arguments: '{ "q": "最新" }' }, { type: 'function_call_output', call_id: 'latest', output: '最新完整回执' },
    ]
    const original = structuredClone(history), stripped = responsesDriver.transformHistory(history, 'strip-tool-inputs', 0)
    expect(stripped.changedMessages).toBe(3)
    const expected = structuredClone(original)
    for (const index of [2, 3, 9]) expected[index]!.arguments = '{}'
    expect(stripped.messages).toEqual(expected)
    const trimmed = responsesDriver.transformHistory(stripped.messages, 'trim-oldest-units', 0)
    expect(trimmed).toEqual({ messages: expected.slice(7), changedMessages: 7 })
    const protectedGroup = responsesDriver.transformHistory(stripped.messages, 'trim-oldest-units', 1)
    expect(protectedGroup.messages).toEqual([...expected.slice(0, 7), ...expected.slice(8)])
    expect(protectedGroup.changedMessages).toBe(1)
    for (const stage of [stripped, trimmed]) {
      const f = transport({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '摘要完成' }] }] })
      await responsesDriver.complete(invocation({ history: stage.messages, wireSystem: '原生冻结指令', purpose: 'branch', hasHistory: true, config: { provider: 'openai', model: 'gpt-test', image: true } }), f.deps)
      const body = f.requests[0]!.body as JsonObject
      expect(body.input).toEqual(stage.messages); expect(body.instructions).toBe('原生冻结指令')
    }
    expect(history).toEqual(original)
    expect(responsesDriver.transformHistory(stripped.messages, 'strip-tool-inputs', 0).changedMessages).toBe(0)
  })
  it('Responses孤儿reasoning、错配回执和未完成工具组不单独裁掉，最新正文前reasoning同组保护', () => {
    const history: JsonObject[] = [{ type: 'reasoning', id: 'rs-broken', encrypted_content: '保留异常组' },
      { type: 'function_call', id: 'fc-broken', call_id: 'broken', name: 'lookup', arguments: '{}' }, { type: 'function_call_output', call_id: 'foreign', output: '错配回执' },
      { role: 'user', content: '最旧可删正文' }, { role: 'user', content: '较新正文' },
      { type: 'reasoning', id: 'rs-latest', encrypted_content: '保留最新私有状态' }, { role: 'assistant', content: '最新回答' },
      { type: 'reasoning', id: 'rs-orphan', encrypted_content: '独立不明归属' }]
    const result = responsesDriver.transformHistory(history, 'trim-oldest-units', 0)
    expect(result.messages).toEqual([...history.slice(0, 3), ...history.slice(4)])
    expect(result.changedMessages).toBe(1)
  })
  it('canonical工具回放产生稳定item id，call id与原始参数不变，不修改源消息', () => {
    const raw = '{ "q": "合成搜索" }', canonical: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: '查询' }, { type: 'tool_call', id: 'call-a', name: 'lookup', arguments: raw }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call-a', content: '查询结果' }] },
    ]
    const original = structuredClone(canonical), config = { provider: 'openai', model: 'm', api_format: 'responses' }
    const projected = responsesDriver.project(canonical, config, openaiPolicy, { digest })
    expect(projected).toEqual([{ role: 'assistant', content: [{ type: 'input_text', text: '查询' }] },
      { type: 'function_call', id: `fc_legacy_${digest({ call_id: 'call-a', occurrence: 0 }).slice(0, 24)}`, call_id: 'call-a', name: 'lookup', arguments: raw },
      { type: 'function_call_output', call_id: 'call-a', output: '查询结果' }])
    expect(responsesDriver.project(canonical, config, openaiPolicy, { digest })).toEqual(projected)
    expect(canonical).toEqual(original)
  })
  it('旧历史重复call id按出现次数分配独立item id，缺digest不能用弱ID伪装冻结投影', () => {
    const row: JsonObject = { role: 'assistant', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
    const other: JsonObject = { role: 'assistant', tool_calls: [{ id: 'call-b', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
    const projected = responsesInput([row, row, other], { image: false, audio_formats: [], video: false }, digest)
    expect(projected.map(item => item.id)).toEqual([...([0, 1].map(occurrence => `fc_legacy_${digest({ call_id: 'call-a', occurrence }).slice(0, 24)}`)), `fc_legacy_${digest({ call_id: 'call-b', occurrence: 0 }).slice(0, 24)}`])
    expect(new Set(projected.map(item => item.id)).size).toBe(3)
    expect(responsesInput([row, row, other], { image: false, audio_formats: [], video: false }, digest)).toEqual(projected)
    expect(() => responsesInput([row], { image: false, audio_formats: [], video: false })).toThrow(ProviderError)
  })
  it('reasoning置于最新整组assistant文本/多个function call之前，冻结wire重入不重复', () => {
    const rows: JsonObject[] = [{ role: 'user', content: '旧问' }, { role: 'assistant', content: '旧答' }, { role: 'user', content: '新问' },
      { role: 'assistant', content: '新轮说明' }, { type: 'function_call', id: 'fc-a', call_id: 'a' }, { type: 'function_call', id: 'fc-b', call_id: 'b' }, { type: 'function_call_output', call_id: 'a', output: '结果' }]
    const continuation = { reasoning_items: [{ type: 'reasoning', id: 'rs-a', status: 'completed', encrypted_content: 'synthetic-encrypted' }, { type: 'reasoning', id: 'rs-incomplete', status: 'in_progress' }] }
    const projected = insertResponsesReasoning(rows, continuation)
    expect(projected[3]).toEqual(continuation.reasoning_items[0]); expect(projected[4]).toEqual(rows[3])
    expect(insertResponsesReasoning(projected, continuation)).toEqual(projected)
    expect(JSON.stringify(rows)).not.toContain('synthetic-encrypted')
    const toolOnly = rows.filter(row => row.content !== '新轮说明')
    expect(insertResponsesReasoning(toolOnly, continuation).slice(0, 4)).toEqual([...toolOnly.slice(0, 3), continuation.reasoning_items[0]])
  })
  it('基础system和snapshot均进入instructions，不能静默丢snapshot或重复基础前缀', () => {
    const parts = responsesInstructions([{ role: 'system', content: '基础' }, { role: 'system', content: [{ type: 'text', text: '快照' }] }], '基础\n策略')
    expect(parts).toEqual({ base: '基础\n策略', instructions: '基础\n策略\n\n---\n\n快照' })
    expect(responsesInput([{ role: 'system', content: '不该改成用户' }, { role: 'user', content: '' }, { role: 'user', content: [] }], { image: false, audio_formats: [], video: false })).toEqual([])
  })
  it.each(['mp3', 'wav'])('显式声明%s时将data URL变为纯base64并保留格式', format => {
    const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    expect(responsesContent([{ type: 'input_audio', input_audio: { data: `data:${mime};base64,AAAA`, format } }], { image: false, audio_formats: [format], video: false }))
      .toEqual([{ type: 'input_audio', input_audio: { data: 'AAAA', format } }])
  })
  it.each([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    { type: 'video_url', video_url: { url: 'https://synthetic.example/video' } },
    { type: 'input_video', video_url: 'https://synthetic.example/video' },
    { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
  ] as JsonObject[])('能力未声明的媒体%j在网络调用前明确拒绝', async media => {
    const f = transport({})
    await expect(responsesDriver.complete(invocation({ history: [{ role: 'user', content: [media] }] }), f.deps)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.requests).toEqual([])
  })
  it.each([
    { data: 'data:audio/flac;base64,AAAA', format: 'flac' },
    { data: 'data:audio/mpeg;base64,AAAA', format: 'wav' },
    { data: 'data:audio/mpeg,AAAA', format: 'mp3' },
  ])('音频声明与实际data URL不一致不能静默降级：%j', input_audio => {
    expect(() => responsesContent([{ type: 'input_audio', input_audio }], { image: false, audio_formats: ['mp3', 'wav'], video: false })).toThrow(ProviderError)
  })
  it('媒体映射保留图片detail/视频fps，工具schema从Chat嵌套改为Responses顶层', () => {
    expect(responsesContent([{ type: 'image_url', image_url: { url: 'synthetic-image', detail: 'high' } }, { type: 'video_url', video_url: { url: 'synthetic-video' }, fps: 2 }], { image: true, audio_formats: [], video: true }))
      .toEqual([{ type: 'input_image', image_url: 'synthetic-image', detail: 'high' }, { type: 'input_video', video_url: 'synthetic-video', fps: 2 }])
    expect(responsesTools([tool])).toEqual([{ type: 'function', name: 'lookup', description: '合成查询', parameters: { type: 'object', properties: { q: { type: 'string' } } } }])
    const original: JsonObject[] = [{ type: 'text', text: '第一段', source: 'history' }, { type: 'input_text', text: '第二段' },
      { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,QUJD' } }, { type: 'video_url', video_url: { url: 'data:video/mp4;base64,REVG' }, fps: 2, media_resolution: 'default' }]
    expect(responsesContent(original, { image: true, audio_formats: ['wav'], video: true })).toEqual([
      { type: 'input_text', text: '第一段', source: 'history' }, { type: 'input_text', text: '第二段' },
      { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } }, { type: 'input_video', video_url: 'data:video/mp4;base64,REVG', fps: 2, media_resolution: 'default' },
    ])
    expect(original[0]!.type).toBe('text')
  })
  it('Responses过滤所有空文本形状但保留结构图片，显式item id与call id分别回放', () => {
    const projected = responsesInput([{ role: 'assistant', content: '' }, { role: 'assistant', content: '  \n' }, { role: 'user', content: [] },
      { role: 'user', content: [{ type: 'input_text', text: '  ' }] }, { role: 'user', content: [{ type: 'input_image', image_url: 'synthetic-image' }] },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] }, { role: 'assistant', tool_calls: [{ id: 'call-a', responses_item_id: 'fc-saved', function: { name: 'lookup', arguments: '{}' } }] }],
    { image: true, audio_formats: [], video: false }, digest)
    expect(projected).toEqual([{ role: 'user', content: [{ type: 'input_image', image_url: 'synthetic-image' }] }, { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      { type: 'function_call', id: 'fc-saved', call_id: 'call-a', name: 'lookup', arguments: '{}' }])
    expect(openaiPolicy.responsesInputCapabilities({ provider: 'openai', model: 'm', image: true, audio: true, video: true })).toEqual({ image: true, audio_formats: ['mp3', 'wav'], video: false })
  })
  it('真实工具图片投影到请求input_image，工具音视频保留不支持说明而非发给不兼容上游', async () => {
    const canonical: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: [{ type: 'text', text: '工具正文' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'input_audio', input_audio: { format: 'wav', data: 'QUJD' } }, { type: 'video_url', video_url: { url: 'synthetic-video' } }] }] },
    ]
    const config = { provider: 'openai', model: 'm', image: true }, projected = responsesDriver.project(canonical, config, openaiPolicy, { digest })
    const f = transport({ status: 'completed', output_text: '已查看' })
    await responsesDriver.complete(invocation({ config, history: projected }), f.deps)
    const body = f.requests[0]!.body as Record<string, unknown>
    expect(JSON.stringify(body.input)).toContain('"type":"input_image"')
    expect(JSON.stringify(body.input)).toContain('不支持原生音频')
    expect(JSON.stringify(body.input)).not.toContain('QUJD')
    expect(JSON.stringify(body.input)).not.toContain('synthetic-video')
    expect(JSON.stringify(body.input)).toContain('工具返回了以下图片，请结合工具文字结果继续处理。')
    expect(projected).toEqual((f.requests[0]!.body as JsonObject).input)
  })
  it('同一真实Responses请求依次发送工具结果、工具图片和当前音视频，图片不混入结果正文', async () => {
    const selected = providerSelection({ provider: 'mimo', model: 'mimo-v2.6-pro', api_format: 'responses', image: true, audio: true, video: true })
    const canonical: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call-image', name: 'read_file', arguments: '{"file_id":7}' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call-image', content: [{ type: 'text', text: '已打开图片，见随附图像。' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }] }] },
      { role: 'user', content: [{ type: 'text', text: '【消息正文】\n' }, { type: 'text', text: '请分析这段音视频。' },
        { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,QUJD' } },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,REVG' }, fps: 2, media_resolution: 'default' }] },
    ]
    const original = structuredClone(canonical)
    const history = selected.driver.project(canonical, selected.config, selected.policy, { digest })
    const f = transport({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '已分析合成媒体。' }] }] })
    expect((await selected.driver.complete(invocation({ config: selected.config, policy: selected.policy, history }), f.deps)).text).toBe('已分析合成媒体。')
    const items = (f.requests[0]!.body as JsonObject).input as JsonObject[]
    expect(items).toEqual([
      { type: 'function_call', id: `fc_legacy_${digest({ call_id: 'call-image', occurrence: 0 }).slice(0, 24)}`, call_id: 'call-image', name: 'read_file', arguments: '{"file_id":7}' },
      { type: 'function_call_output', call_id: 'call-image', output: '已打开图片，见随附图像。' },
      { role: 'user', content: [{ type: 'input_text', text: '工具返回了以下图片，请结合工具文字结果继续处理。' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' }] },
      { role: 'user', content: [{ type: 'input_text', text: '【消息正文】\n' }, { type: 'input_text', text: '请分析这段音视频。' },
        { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } },
        { type: 'input_video', video_url: 'data:video/mp4;base64,REVG', fps: 2, media_resolution: 'default' }] },
    ])
    expect(String(items[1]!.output)).not.toContain('AQID')
    expect(canonical).toEqual(original); expect(f.requests).toHaveLength(1)
  })
  it('仅工具音视频在真实Responses请求中只形成调用和文字回执两项，不增加空媒体消息', async () => {
    const canonical: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call-media', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call-media', content: [{ type: 'text', text: '已读取媒体。' },
        { type: 'input_audio', input_audio: { data: 'data:audio/mpeg;base64,AAAA' } }, { type: 'video_url', video_url: { url: 'data:video/mp4;base64,BBBB' } }] }] },
    ]
    const history = responsesDriver.project(canonical, { model: 'm' }, openaiPolicy, { digest }), f = transport({ status: 'completed', output: [] })
    await responsesDriver.complete(invocation({ history }), f.deps)
    const items = (f.requests[0]!.body as JsonObject).input as JsonObject[]
    expect(items).toHaveLength(2)
    expect(items[0]!.type).toBe('function_call'); expect(items[1]!.type).toBe('function_call_output')
    expect(items[1]!.output).toContain('当前 API 协议不支持原生音频输入')
    expect(items[1]!.output).toContain('当前 API 协议不支持原生视频输入')
    expect(JSON.stringify(items)).not.toContain('AAAA'); expect(JSON.stringify(items)).not.toContain('BBBB')
  })
})

describe('Responses真实请求与流终态', () => {
  it('标准Canonical Harness准备的system snapshot实际进入首轮Responses instructions且保持冻结请求身份', async () => {
    const value = responsesHarness([sse({ type: 'response.output_text.delta', delta: '已读取合成信息。' }, { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3 } } })], false)
    try {
      const result = await collect(value.harness.start(identity))
      expect(result.state.status).toBe('completed'); expect(value.sent).toHaveLength(1)
      const body = value.sent[0]!.body as JsonObject
      expect(body.instructions).toBe('基础人格\n\n---\n\n[system-reminder]\n会话快照')
      // 与Python标准上下文一致：当前用户经正式准备后保留消息正文封套。
      expect(body.input).toEqual([{ role: 'user', content: '【消息正文】\n读取合成信息' }])
      expect(value.complete).toHaveBeenCalledTimes(1)
      const completed = value.complete.mock.calls[0]![0]
      expect(completed.requestSystemPrompt).toBe('基础人格')
      expect(completed.projection).toMatchObject({ modelIdentity: 'model-a', dynamicTailSize: 0, wire: { protocol: 'responses', system: body.instructions, messages: body.input } })
      expect(completed.request!.area.matchesProjection(completed.projection!, 'model-a')).toBe(true)
      expect(completed.request!.area.requestPrefix).toEqual([{ role: 'system', content: '[system-reminder]\n会话快照' }])
    } finally { await value.provider.close() }
  })
  it('Qwen Responses同一真实HTTP保留原生工具schema、low推理、100预算及标准化cache usage', async () => {
    const selected = providerSelection({ provider: 'qwen', model: 'qwen3.8-max', api_format: 'responses', thinking: 'adaptive', reasoning_effort: 'low' })
    const tools: JsonObject[] = [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }]
    const f = transport({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"ok"}' }] }], usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 7 } } })
    const result = await selected.driver.complete(invocation({ config: selected.config, policy: selected.policy, system: 'stable system',
      history: [{ role: 'user', content: '【消息正文】\n历史' }, { role: 'user', content: '压缩指令' }], tools, maxOutputTokens: 100, purpose: 'branch', hasHistory: true, outputMode: 'json' }), f.deps)
    expect(JSON.parse(result.text)).toEqual({ summary: 'ok' })
    expect(result.usage).toEqual({ input: 5, output: 3, cacheRead: 7, cacheWrite: 0, contextInput: 12 })
    const request = f.requests[0]!, body = request.body as JsonObject
    expect(request.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/responses')
    expect(body).toMatchObject({ instructions: 'stable system', input: [{ role: 'user', content: '【消息正文】\n历史' }, { role: 'user', content: '压缩指令' }], tools, max_output_tokens: 100, store: false, reasoning: { effort: 'low' } })
    expect(body.previous_response_id).toBeUndefined(); expect(body.response_format).toBeUndefined(); expect(body.text).toBeUndefined()
    expect(f.requests).toHaveLength(1)
  })
  it.each([true, false])('实际Harness工具轮冻结请求经ReflectionSnapshots再追加分支保留Responses前缀，continuation=%s', async enabled => {
    const reasoning: JsonObject = { type: 'reasoning', id: 'rs-main', status: 'completed', encrypted_content: 'synthetic-encrypted-prefix' }
    const value = responsesHarness([
      sse({ type: 'response.completed', response: { status: 'completed', output: [reasoning, { type: 'function_call', id: 'fc-main', call_id: 'call-main', name: 'lookup', arguments: '{ "q": "合成" }' }], usage: { input_tokens: 5, output_tokens: 2 } } }),
      sse({ type: 'response.output_text.delta', delta: '已整理合成结果。' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '已整理合成结果。' }] }], usage: { input_tokens: 12, output_tokens: 3 } } }),
      JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"合成摘要"}' }] }], usage: { input_tokens: 13, output_tokens: 4 } }),
    ], enabled)
    let serial = 0
    const snapshots = new ReflectionSnapshots<ProviderWire>({ digest, nextId: () => `reflection-${++serial}` }, () => 0)
    try {
      const projection = await value.provider.reflectionProjection(identity, 'model-a')
      const ready = vi.fn(async () => undefined)
      const finalizer = createReflectionFinalizer({ snapshots, projection, policy: async () => ({ enabled: true, scope: 'owner' }), notifyReady: ready })
      value.complete.mockImplementation(input => finalizer.complete(input))
      const result = await collect(value.harness.start(identity))
      expect(result.state.status).toBe('completed'); expect(value.external.ports.tools.dispatch).toHaveBeenCalledTimes(1)
      expect(value.sent).toHaveLength(2)
      const main = value.sent[1]!.body as JsonObject, mainRows = main.input as JsonObject[]
      const completion = value.complete.mock.calls[0]![0]
      expect(completion.projection).toMatchObject({ wire: { messages: mainRows, system: main.instructions } })
      expect(mainRows.some(row => row.type === 'reasoning')).toBe(enabled)
      expect(main.include).toEqual(enabled ? ['reasoning.encrypted_content'] : undefined)
      expect(mainRows.find(row => row.type === 'function_call')).toMatchObject({ id: 'fc-main', call_id: 'call-main', arguments: '{ "q": "合成" }' })
      const snapshot = snapshots.peek(identity, 'model-a', digest(identity))
      expect(snapshot).not.toBeNull()
      if (!snapshot) throw new Error('正式成功收尾必须捕获可复用反思快照')
      const before = structuredClone(snapshot)
      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ recovery: 'reuse', snapshotDigest: snapshot.digest, hadTools: true }))
      expect(snapshot.projection.wire.messages).toEqual([...mainRows, { role: 'assistant', content: '已整理合成结果。' }])
      const branch = await value.provider.completeBranch({ ...identity, modelIdentity: 'model-a', stableSystem: snapshot.systemPrompt, delta: '请输出反思摘要', tools: snapshot.tools, projection: snapshot.projection, outputMode: 'json' })
      expect(JSON.parse(String(branch.output))).toEqual({ summary: '合成摘要' })
      const body = value.sent[2]!.body as JsonObject
      expect(body.instructions).toBe(main.instructions); expect(body.tools).toEqual(main.tools)
      expect(body.prompt_cache_key).toBe(main.prompt_cache_key)
      expect(body.reasoning).toEqual(main.reasoning); expect(body.store).toBe(false); expect(main.store).toBe(false)
      expect(body.input).toEqual([...snapshot.projection.wire.messages, { role: 'user', content: '请输出反思摘要' }])
      expect((body.input as JsonObject[]).slice(0, mainRows.length)).toEqual(mainRows)
      expect(body.previous_response_id).toBeUndefined(); expect(body.text).toBeUndefined(); expect(body.include).toBeUndefined()
      expect(snapshots.peek(identity, 'model-a', digest(identity))).toEqual(before)
      expect(JSON.stringify(result.state)).not.toContain('synthetic-encrypted-prefix')
    } finally { await value.provider.close() }
  })
  it('request使用input/instructions，官方store=false及cache key不含当前query，工具变更使key变化', async () => {
    const keys: unknown[] = []
    for (const [query, snapshot, tools] of [['一', '快照', []], ['二', '快照', []], ['二', '新快照', []], ['二', '新快照', [tool]]] as const) {
      const f = transport({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '可见正文' }] }], output_text: '不应该泄漏的聚合思考' })
      const result = await responsesDriver.complete(invocation({ history: [{ role: 'system', content: '固定规则' }, { role: 'system', content: snapshot }, { role: 'user', content: query }], tools, maxOutputTokens: 123 }), f.deps)
      expect(result.text).toBe('可见正文')
      const request = f.requests[0]!, body = request.body as Record<string, unknown>
      expect(request.url).toBe('https://api.openai.com/v1/responses')
      expect(body.instructions).toBe(`固定规则\n\n---\n\n${snapshot}`); expect(body.messages).toBeUndefined(); expect(body.store).toBe(false)
      expect(body.tools).toEqual(tools.length ? [{ type: 'function', name: 'lookup', description: '合成查询', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] : [])
      expect(body.max_output_tokens).toBe(123); keys.push(body.prompt_cache_key)
    }
    expect(keys[0]).toBe(keys[1]); expect(keys[1]).toBe(keys[2]); expect(keys[2]).not.toBe(keys[3])
  })
  it('兼容端点不发送未经确认的store/prompt_cache_key，独立调用不重放私有reasoning', async () => {
    const f = transport({ status: 'completed', output_text: '可见' })
    await responsesDriver.complete(invocation({ config: { provider: 'other', model: 'm', base_url: 'https://synthetic.example/v1', reasoning_persistence: 'continuation' }, purpose: 'standalone', continuation: { reasoning_items: [{ type: 'reasoning', encrypted_content: 'secret' }] } }), f.deps)
    const body = f.requests[0]!.body as Record<string, unknown>
    expect(body.store).toBeUndefined(); expect(body.prompt_cache_key).toBeUndefined(); expect(body.include).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('secret')
  })
  it.each([
    ['openai', 'https://api.openai.com/v1', 'gpt-test', false], ['openai', 'https://gateway.example/v1', 'gpt-test', undefined],
    ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-max', false], ['glm', 'https://open.bigmodel.cn/api/v1', 'glm-5.3', false],
    ['deepseek', 'https://api.deepseek.com', 'deepseek-chat', undefined], ['minimax', 'https://api.minimaxi.com/v1', 'MiniMax-M3', undefined],
    ['mimo', 'https://api.xiaomimimo.com/v1', 'mimo-v2-flash', undefined],
  ] as const)('%s/%s的真实Responses请求只发送已确认store政策，不自动续链', async (provider, base_url, model, expected) => {
    const selected = providerSelection({ provider, base_url, model, api_format: 'responses' })
    const f = transport(sse({ type: 'response.completed', response: { status: 'completed', output: [] } }), { raw: true })
    await events(selected.driver.stream(invocation({ config: selected.config, policy: selected.policy }), f.deps))
    const body = f.requests[0]!.body as JsonObject
    expect(body.store).toBe(expected)
    expect(Object.hasOwn(body, 'store')).toBe(expected !== undefined)
    expect(body.previous_response_id).toBeUndefined()
  })
  it('流按output_index重建工具，保留Responses item身份和原始参数，reasoning仅进续接材料', async () => {
    const f = transport(sse(
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc-b', call_id: 'b', name: 'lookup' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-b', delta: '{"q":"b"}' },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc-a', call_id: 'a', name: 'lookup', arguments: '{ "q": "a" }' } },
      { type: 'response.output_text.delta', delta: '查询说明' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 80 } }, output: [{ type: 'function_call', id: 'fc-a', call_id: 'a', name: 'lookup', arguments: '{ "q": "a" }' }, { type: 'function_call', id: 'fc-b', call_id: 'b', name: 'lookup', arguments: '{"q":"b"}' }, { type: 'reasoning', id: 'rs-a', status: 'completed', encrypted_content: 'synthetic-private' }] } }), { raw: true, chunkSize: 5 })
    const output = await events(responsesDriver.stream(invocation({ config: { provider: 'openai', model: 'm', reasoning_persistence: 'continuation' } }), f.deps))
    expect(output.filter(event => event.type === 'token')).toEqual([{ type: 'token', text: '查询说明' }])
    expect(output.find(event => event.type === 'usage')).toMatchObject({ usage: { input: 20, output: 9, cacheRead: 80, contextInput: 100 } })
    expect(output.at(-1)).toMatchObject({ type: 'complete', calls: [{ id: 'a', responsesItemId: 'fc-a', rawArguments: '{ "q": "a" }' }, { id: 'b', responsesItemId: 'fc-b' }], continuation: { reasoning_items: [{ id: 'rs-a', encrypted_content: 'synthetic-private' }] } })
    expect((f.requests[0]!.body as Record<string, unknown>).include).toEqual(['reasoning.encrypted_content'])
    expect(f.cancel).toHaveBeenCalledTimes(1)
  })
  it('failed事件抛固定脱敏错误，即便已报usage也不能伪装成功空答', async () => {
    const f = transport(sse({ type: 'response.failed', response: { status: 'failed', usage: { input_tokens: 12 }, error: { code: 'server_error', message: 'synthetic-token 用户正文' } } }), { raw: true })
    const stream = responsesDriver.stream(invocation(), f.deps)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'usage', usage: { contextInput: 12 } })
    await expect(stream.next()).rejects.toThrow('模型服务请求失败')
    expect(f.diagnose).toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledTimes(1)
    for (const kind of ['response.failed', 'error']) for (const afterOutput of [false, true]) {
      const error = { code: 'internal_error', message: '合成私有错误正文' }
      const failure = transport(sse(...(afterOutput ? [{ type: 'response.output_text.delta', delta: '已有正文' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc-failed', call_id: 'call-failed', name: 'lookup', arguments: '{"q":"合成"}' } }] : []),
        kind === 'response.failed' ? { type: kind, response: { status: 'failed', error } } : { type: kind, ...error }), { raw: true })
      const emitted: import('../../../src/agent/harness/contracts.js').ProviderEvent[] = []
      await expect((async () => { for await (const event of responsesDriver.stream(invocation(), failure.deps)) emitted.push(event) })()).rejects.toMatchObject({ code: 'upstream' })
      expect(emitted.filter(event => event.type === 'complete')).toEqual([])
      expect(emitted.filter(event => event.type === 'token').map(event => event.type === 'token' ? event.text : '')).toEqual(afterOutput ? ['已有正文'] : [])
      expect(failure.requests).toHaveLength(1); expect(failure.cancel).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(failure.diagnose.mock.calls)).toContain('合成私有错误正文')
    }
  })
  it.each([
    { status: 405, message: 'method not allowed', expected: true },
    { status: 400, message: 'response input is invalid', expected: true },
    { status: 422, message: 'does not support responses', expected: true },
    { status: 400, message: 'Responses API payload shape rejected', expected: true },
    { status: 404, message: 'model not found', expected: false },
    { status: 400, message: 'invalid temperature', expected: false },
  ])('只有明确Responses兼容错误才标注协议不兼容：%j', async ({ status, message, expected }) => {
    const f = transport({ error: { message } }, { status })
    await expect(responsesDriver.complete(invocation(), f.deps)).rejects.toMatchObject({ options: { protocolIncompatible: expected, status } })
  })
  it('上下文超限优先于Responses兼容标记，不得要求清理可恢复的私有状态', async () => {
    const f = transport({ error: { code: 'context_length_exceeded', message: 'Responses endpoint maximum context length exceeded' } }, { status: 400 })
    await expect(responsesDriver.complete(invocation(), f.deps)).rejects.toMatchObject({ code: 'context_overflow', options: { protocolIncompatible: false } })
  })
  it.each([
    ['response.failed', false], ['response.failed', true], ['error', false], ['error', true],
  ] as const)('%s窗口超限在已有输出=%s时准确标注恢复边界，不输出完成或私有错误正文', async (kind, afterOutput) => {
    const error = { code: 'context_length_exceeded', message: 'maximum context length exceeded；合成私有超限正文' }
    const f = transport(sse(...(afterOutput ? [{ type: 'response.output_text.delta', delta: '已输出合成正文' }] : []),
      kind === 'response.failed' ? { type: kind, response: { status: 'failed', error } } : { type: kind, ...error }), { raw: true, chunkSize: 3 })
    const emitted: import('../../../src/agent/harness/contracts.js').ProviderEvent[] = []
    let caught: unknown
    try { for await (const event of responsesDriver.stream(invocation(), f.deps)) emitted.push(event) }
    catch (error) { caught = error }
    expect(caught).toBeInstanceOf(ProviderError)
    expect(caught).toMatchObject({ code: 'context_overflow', options: { requestStarted: true, outputStarted: afterOutput } })
    expect(String(caught)).not.toContain('合成私有超限正文')
    expect(emitted.filter(event => event.type === 'token')).toEqual(afterOutput ? [{ type: 'token', text: '已输出合成正文' }] : [])
    expect(emitted.some(event => event.type === 'complete')).toBe(false)
    expect(JSON.stringify(emitted)).not.toContain('合成私有超限正文')
    expect(f.requests).toHaveLength(1); expect(f.cancel).toHaveBeenCalledTimes(1)
  })
  it('incomplete保留实际终态与坏参数标记，没有completed/incomplete的EOF拒绝成功', async () => {
    const f = transport(sse({ type: 'response.incomplete', response: { status: 'incomplete', usage: { output_tokens: 10 }, incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', id: 'fc-a', call_id: 'a', name: 'lookup', arguments: '{"q":' }] } }), { raw: true })
    const output = await events(responsesDriver.stream(invocation({ maxOutputTokens: 10 }), f.deps))
    expect(output.at(-1)).toMatchObject({ type: 'complete', finishReason: 'incomplete', incompleteReason: 'max_output_tokens', calls: [{ parseError: 'invalid_json' }] })
    expect((f.requests[0]!.body as JsonObject).max_output_tokens).toBe(10)
    expect(output.find(event => event.type === 'usage')).toMatchObject({ usage: { output: 10 } })
    const broken = transport(sse({ type: 'response.output_text.delta', delta: '未完成' }), { raw: true })
    await expect(events(responsesDriver.stream(invocation(), broken.deps))).rejects.toMatchObject({ code: 'stream_incomplete' })
  })
  it('完成事件只有最终message也能交付可见正文，reasoning聚合不作为文本', async () => {
    const response = { status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '不应显示' }] }, { type: 'message', content: [{ type: 'output_text', text: '最终可见' }] }], output_text: '不应显示的聚合字段' }
    expect(responsesOutputText(response)).toBe('最终可见')
    const f = transport(sse({ type: 'response.completed', response }), { raw: true })
    expect((await events(responsesDriver.stream(invocation(), f.deps))).filter(event => event.type === 'token')).toEqual([{ type: 'token', text: '最终可见' }])
  })
  it('JSON追加分支不改变主前缀请求格式，独立请求可发送声明的JSON格式', async () => {
    const policy = customPolicy({ structuredOutput: () => ({ response_format: { type: 'json_object' } }) })
    for (const hasHistory of [false, true]) {
      const f = transport({ status: 'completed', output_text: '{"ok":true}' })
      await responsesDriver.complete(invocation({ policy, purpose: 'branch', hasHistory, outputMode: 'json' }), f.deps)
      expect((f.requests[0]!.body as Record<string, unknown>).text).toEqual(hasHistory ? undefined : { format: { type: 'json_object' } })
    }
  })
  it('Responses显式null预算不回落配置，实际原始usage独立上报且不进入Harness事件', async () => {
    const f = transport(sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 8, input_tokens_details: { cached_tokens: 70 } }, output: [] } }), { raw: true })
    const probes: unknown[] = []
    const output = await events(responsesDriver.stream(invocation({ maxOutputTokens: null, config: { provider: 'openai', model: 'm', max_tokens: 123 } }), { ...f.deps, onUsage: (raw, normalized) => { probes.push({ raw, normalized }); throw new Error('合成probe失败') } }))
    expect((f.requests[0]!.body as JsonObject).max_output_tokens).toBeUndefined()
    expect(probes).toEqual([{ raw: { input_tokens: 120, output_tokens: 8, input_tokens_details: { cached_tokens: 70 } }, normalized: { input: 50, output: 8, cacheRead: 70, cacheWrite: 0, contextInput: 120 } }])
    expect(output.find(event => event.type === 'usage')).toEqual({ type: 'usage', usage: { input: 50, output: 8, cacheRead: 70, cacheWrite: 0, contextInput: 120 } })
    const missing = transport({ status: 'completed', output_text: '可见' }), unknown: unknown[] = []
    await responsesDriver.complete(invocation(), { ...missing.deps, onUsage: (raw, normalized) => unknown.push({ raw, normalized }) })
    expect(unknown).toEqual([{ raw: null, normalized: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null } }])
  })
  it('已冻结Responses前缀追加反思保持instructions和cache key，原生reasoning与工具item逐字节保留', async () => {
    const input = invocation({ history: [{ role: 'system', content: '固定规则' }, { role: 'system', content: '会话快照' },
      { role: 'user', content: '问题' }, { type: 'reasoning', id: 'rs-a', status: 'completed', encrypted_content: 'synthetic-private' },
      { type: 'function_call', id: 'fc-a', call_id: 'a', name: 'lookup', arguments: '{ "q": 1 }' }, { type: 'function_call_output', call_id: 'a', output: '结果' }], tools: [tool] })
    const main = transport({ status: 'completed', output_text: '主回复' })
    await responsesDriver.complete(input, main.deps)
    const body = main.requests[0]!.body as JsonObject
    const branch = transport({ status: 'completed', output_text: '{}' })
    await responsesDriver.complete({ ...input, history: [...body.input as JsonObject[], { role: 'user', content: '反思任务' }], wireSystem: body.instructions, purpose: 'branch', hasHistory: true, outputMode: 'json' }, branch.deps)
    const branchBody = branch.requests[0]!.body as JsonObject
    expect(branchBody.instructions).toBe(body.instructions)
    expect(branchBody.prompt_cache_key).toBe(body.prompt_cache_key)
    expect((branchBody.input as JsonObject[]).slice(0, (body.input as JsonObject[]).length)).toEqual(body.input)
    expect(input.history[3]).toEqual({ type: 'reasoning', id: 'rs-a', status: 'completed', encrypted_content: 'synthetic-private' })
  })
  it('完整历史重放原始用户任务及工具结果，空历史或只有system在网络前拒绝', async () => {
    const history: JsonObject[] = [{ role: 'user', content: '搜索合成资料并保留校验词ORBIT-42' },
      { role: 'assistant', tool_calls: [{ id: 'a', responses_item_id: 'fc-a', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: '技能已加载' }]
    const f = transport(sse({ type: 'response.completed', response: { status: 'completed', output: [] } }), { raw: true })
    await events(responsesDriver.stream(invocation({ history }), f.deps))
    expect((f.requests[0]!.body as JsonObject).input).toEqual([{ role: 'user', content: '搜索合成资料并保留校验词ORBIT-42' },
      { type: 'function_call', id: 'fc-a', call_id: 'a', name: 'lookup', arguments: '{}' }, { type: 'function_call_output', call_id: 'a', output: '技能已加载' }])
    expect((f.requests[0]!.body as JsonObject).previous_response_id).toBeUndefined()
    for (const history of [[], [{ role: 'system', content: '规则' }]]) {
      const empty = transport({ status: 'completed', output: [] })
      await expect(responsesDriver.complete(invocation({ history }), empty.deps)).rejects.toMatchObject({ code: 'input_rejected' })
      expect(empty.requests).toEqual([])
    }
  })
  it('Responses共享重试保持两次完整input不变，不改用previous_response_id或自动切协议', async () => {
    const first = transport({ error: { message: '合成限流' } }, { status: 429 }), second = transport(sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '已恢复' }] }] } }), { raw: true })
    const requests: JsonObject[] = [], input = invocation()
    const deps = { ...second.deps, transport: { request: async (...args: Parameters<typeof second.deps.transport.request>) => {
      requests.push(structuredClone(args[0].body) as JsonObject)
      return (requests.length === 1 ? first.deps : second.deps).transport.request(...args)
    } } }
    const result = await events(streamWithRetry(() => responsesDriver.stream(input, deps), input.signal, { clock: { now: () => 0, sleep: async () => undefined } }))
    expect(requests).toHaveLength(2); expect(requests[0]!.input).toEqual(requests[1]!.input)
    expect(requests.every(request => !('previous_response_id' in request))).toBe(true)
    expect(result.filter(event => event.type === 'retry').map(event => event.type === 'retry' ? event.attempt : null)).toEqual([1])
    expect(result.at(-1)).toMatchObject({ type: 'complete', text: '已恢复' })
  })
  it('捕获的reasoning只在显式continuation时随完整后续历史回放，off配置清除include与私有项', async () => {
    const reasoning: JsonObject = { type: 'reasoning', id: 'rs-a', status: 'completed', summary: [], encrypted_content: 'synthetic-encrypted' }
    const config = { provider: 'openai', model: 'm', reasoning_persistence: 'continuation' }
    const first = transport(sse({ type: 'response.output_text.delta', delta: '查一下' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60 } },
      output: [reasoning, { type: 'function_call', id: 'fc-a', call_id: 'a', name: 'lookup', arguments: '{}' }] } }), { raw: true })
    const emitted = await events(responsesDriver.stream(invocation({ config }), first.deps))
    const done = emitted.find(event => event.type === 'complete')!
    if (done.type !== 'complete') throw new Error('测试需要已完成事件')
    expect(done.continuation).toEqual({ state_kind: 'openai_responses_reasoning', reasoning_items: [reasoning] })
    expect(emitted.find(event => event.type === 'usage')).toMatchObject({ usage: { input: 40, cacheRead: 60, output: 7 } })
    const messages: CanonicalMessage[] = [{ role: 'user', content: '请查日历' }, { role: 'assistant', content: '查一下' }, { role: 'user', content: '结果呢' }]
    for (const enabled of [true, false]) {
      const nextConfig = { ...config, reasoning_persistence: enabled ? 'continuation' : 'off' }
      const projected = responsesDriver.project(messages, nextConfig, openaiPolicy, { digest, continuation: done.continuation })
      const next = transport(sse({ type: 'response.completed', response: { status: 'completed', output: [] } }), { raw: true })
      await events(responsesDriver.stream(invocation({ config: nextConfig, history: projected }), next.deps))
      const body = next.requests[0]!.body as JsonObject
      expect((body.input as JsonObject[]).some(item => item.type === 'reasoning')).toBe(enabled)
      expect(body.include).toEqual(enabled ? ['reasoning.encrypted_content'] : undefined)
      expect(body.previous_response_id).toBeUndefined()
      if (enabled) expect((body.input as JsonObject[])[1]).toEqual(reasoning)
    }
  })
})
