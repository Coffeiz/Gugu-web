import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { CanonicalMessage,ContextServices,Json,OpaqueProviderProjection,ReflectionProjectionPort,SummaryGenerationPorts } from "../../../../src/agent/harness/index.js"
import {
MessageArea,ReflectionSnapshots,appendReflectionHistory,applyCompaction,compactContext,createCompactionSummarizer,deterministicSummary,enforceProviderOverflow,formatCompactedSummary,isContextOverflowError,
matchedAtomicUnits,providerInputTokens,reflectionRecoveryPolicy,resolveCompactionLimits,shouldCompact,stableJson,stripToolCallInputs,summaryOutputExhausted,toolCallIds,toolResultIds,trimOldestHistory,validateCompactSummary
} from "../../../../src/agent/harness/index.js"
function services(): ContextServices {
  let id = 0
  return { nextId: () => `id-${++id}`, digest: value => createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16) }
}
const user = (content: string): CanonicalMessage => ({ role: 'user', content })
const accessScopeHash = 'scope-owner'
const history = (size: number): CanonicalMessage[] => Array.from({ length: size }, (_, index) => ({ ...user(`消息${index}`), _history_id: String(index + 1) }))
function legacyToolRound(shape: 'anthropic' | 'openai' | 'canonical'): CanonicalMessage[] {
  if (shape === 'openai') return [{ role: 'assistant', content: null, tool_calls: ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } })) },
  ...['a', 'b'].map(id => ({ role: 'tool', tool_call_id: id, content: `结果${id}` }))]
  const calls = ['a', 'b'].map((id): Json => shape === 'anthropic' ? { type: 'tool_use', id, name: 'read', input: {} } : { type: 'tool_call', id, name: 'read', arguments: {} })
  const results = ['a', 'b'].map((id): Json => shape === 'anthropic' ? { type: 'tool_result', tool_use_id: id, content: `结果${id}` } : { type: 'tool_result', tool_call_id: id, content: `结果${id}` })
  return [{ role: 'assistant', content: calls }, { role: shape === 'canonical' ? 'tool' : 'user', content: results }]
}
describe('实际Provider用量和超限预算', () => {
  it('结构化异常body含循环或BigInt时仍识别输入超限，不执行访问器', () => {
    let getters = 0
    const body: Record<string, unknown> = { error: { type: 'context_length_exceeded', message: 'too long' }, size: 1n }
    body.self = body
    Object.defineProperty(body, 'trap', { enumerable: true, get() { getters++; throw new Error('不能执行访问器') } })
    const error = Object.assign(new Error('provider request rejected'), { body })
    expect(isContextOverflowError(error)).toBe(true)
    expect(getters).toBe(0)
    expect(isContextOverflowError(new Error('HTTP status 413 in an unrelated proxy diagnostic'))).toBe(false)
  })
  it('当前请求包含cache read/write的输入才有权触发85%，未知或跨模型保持未知', () => {
    const usage = { requestId: 'request', modelIdentity: 'model', freshInput: 10, cacheRead: 70, cacheWrite: 5 }
    expect(providerInputTokens(usage, 'request', 'model')).toBe(85)
    expect(shouldCompact(85, 100)).toBe(true); expect(shouldCompact(84, 100)).toBe(false)
    expect(providerInputTokens(usage, 'other', 'model')).toBeNull()
    expect(providerInputTokens(usage, 'request', 'other')).toBeNull()
    expect(providerInputTokens({ ...usage, freshInput: null }, 'request', 'model')).toBeNull()
    expect(shouldCompact(null, 100)).toBe(false)
  })
  it.each(['maximum context length', 'context window exceeded', 'input token count exceeds', 'request_too_large', 'prompt is too long', 'context_length_exceeded', 'invalid params, context window exceeds limit (2013)', 'request entity too large', 'request too large'])('识别输入超限%s', message => {
    expect(isContextOverflowError(new Error(message))).toBe(true)
  })
  it.each(['max_tokens maximum context length', 'maximum output limit', 'output token limit', 'invalid api key', 'HTTP 400 bad request', 'HTTP status 413 in an unrelated proxy diagnostic'])('输出限制不误判输入超限%s', message => {
    expect(isContextOverflowError(new Error(message))).toBe(false)
  })
  it('递归cause和413有界解析，不受循环异常引用影响', () => {
    const error: Record<string, unknown> = { cause: { body: { error: { code: 'context_length_exceeded' } } } }; error.__context__ = error
    expect(isContextOverflowError(error)).toBe(true)
    expect(isContextOverflowError({ status_code: 413 })).toBe(true)
  })
  it.each([[3, 3, 0], [40, 10, 1]])('超限时%i单元保留%i个，revision只变化%i次', (size, kept, revision) => {
    const area = new MessageArea(services(), history(size)); area.configureRequest([user('固定前缀')])
    const result = enforceProviderOverflow(area)
    expect(area.messages).toHaveLength(kept); expect(area.revision).toBe(revision)
    expect(result.droppedMessages).toBe(size - kept); expect(area.requestPrefix).toEqual([user('固定前缀')])
  })
  it('多个固定prefix下protectedFrom使用完整请求坐标，overflow完整保留显式受保护尾部', () => {
    const original = history(30), prefix: CanonicalMessage[] = [{ role: 'system', content: '固定人格' }, user('固定快照'), user('固定目录')]
    original[29] = user('受保护的收尾')
    const area = new MessageArea(services(), original)
    area.configureRequest(prefix); area.setDynamicTail([user('请求动态tail')])
    const result = enforceProviderOverflow(area, { from: prefix.length + 28 })
    expect(result.changed).toBe(true); expect(result.droppedMessages).toBe(18)
    expect(area.requestPrefix).toEqual(prefix); expect(area.dynamicTail).toEqual([user('请求动态tail')])
    expect(area.messages).toEqual(original.slice(18)); expect(area.messages.slice(-2)).toEqual(original.slice(28))
    expect([...area.requestPrefix, ...area.messages].slice(0, 3)).toEqual(prefix)
    expect(area.messages.at(-1)!.content).toBe('受保护的收尾')
  })
  it('最新工具交换完整保留，当前用户原文不缩短，工具文本缩到2048字符', () => {
    const area = new MessageArea(services(), [user('用户原文'), { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'read', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '合成结果'.repeat(1000) }] }])
    const result = enforceProviderOverflow(area, { anchorIndex: 0, from: 1 })
    expect(result.changed).toBe(true); expect(result.droppedMessages).toBe(0)
    expect(area.messages[0]).toEqual(user('用户原文'))
    expect(stableJson(area.messages[2])).toContain('工具输出因请求超限已截短')
    expect(stableJson(area.messages[1])).toContain('"id":"a"')
  })
})
describe('压缩候选、并发和完整轮边界', () => {
  it('真正compact的branch从固定prefix起连续包含全部原历史和保留尾部，工具和输出预算原样传递', async () => {
    const service = services(), area = new MessageArea(service, [user('## 项目\n- 合成项目'), ...history(13)])
    const prefix: CanonicalMessage[] = [{ role: 'system', content: '快照固定前缀' }], seen: unknown[] = []
    const tools: Json[] = [{ name: 'read', input_schema: { type: 'object' } }]
    area.configureRequest(prefix)
    const fullHistory = area.messages
    const port: SummaryGenerationPorts<string> = {
      ...service, pauseBeforeRetry: async () => { }, diagnostic: () => { },
      transformProjection: () => { throw new Error('小历史不裁切') }, provider: {
        isInputRejected: () => false, complete: async request => {
          seen.push(structuredClone(request)); expect(request.stableSystem).toBe('独立稳定system'); expect(request.tools).toEqual(tools)
          expect(request.maxOutputTokens).toBe(321); expect(request.canonicalHistory).toEqual([...prefix, ...fullHistory])
          expect(request.canonicalHistory!.at(-1)).toEqual(fullHistory.at(-1)); expect(request.delta).toContain('压缩任务')
          return { output: '有效摘要', usage: { output: 5, finish_reason: 'stop' } }
        }
      }
    }
    const summarizer = createCompactionSummarizer({
      ownerId: 'owner', sessionId: 'session', runId: 'run', stableSystem: '独立稳定system', tools,
      contextTokens: 32000, maxOutputTokens: 321, instruction: '压缩任务'
    }, port)
    const capture = {
      summarize: async (input: Parameters<typeof summarizer.summarize>[0]) => {
        expect(input.compressible).toEqual(fullHistory.slice(1, 4)); expect(input.compressible).not.toContainEqual(prefix[0])
        return summarizer.summarize(structuredClone(input))
      }
    }
    const candidate = await compactContext(area, capture, { modelIdentity: 'model' })
    expect(seen).toHaveLength(1); expect(candidate.changed).toBe(true)
    expect(candidate.messages[0]).toEqual(fullHistory[0]); expect(candidate.messages.slice(-10)).toEqual(fullHistory.slice(-10))
  })
  it('空或仅保留窗历史不产生无summary候选；有效候选摘要后一定有保留的真实尾部', async () => {
    for (const size of [0, 1, 10]) {
      let calls = 0
      const area = new MessageArea(services(), history(size))
      const result = await compactContext(area, { summarize: async () => { calls++; return '摘要' } }, { modelIdentity: 'model' })
      expect(result.changed).toBe(false); expect(calls).toBe(0); expect(result.messages).toEqual(area.messages)
    }
    const area = new MessageArea(services(), history(12))
    const candidate = await compactContext(area, { summarize: async () => '有效摘要' }, { modelIdentity: 'model' })
    expect(candidate.changed).toBe(true); expect(candidate.messages[0]!.content).toBe(formatCompactedSummary('有效摘要'))
    expect(candidate.messages.slice(1)).toEqual(history(12).slice(-10)); expect(candidate.messages.at(-1)).toEqual(history(12).at(-1))
  })
  it('末尾只有调用无结果时仍是一个完整原子单元', () => {
    expect(matchedAtomicUnits([{ role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'read', arguments: '{}' }] }])).toEqual([[0]])
  })
  it.each(['anthropic', 'openai', 'canonical'] as const)('legacy%s三形态的两个并行调用与全部结果不能拆单元', shape => {
    const round = legacyToolRound(shape), messages = [user('之前'), ...round, user('之后')]
    expect(matchedAtomicUnits(messages)).toEqual([[0], Array.from({ length: round.length }, (_, index) => index + 1), [round.length + 1]])
    const area = new MessageArea(services(), messages)
    expect(matchedAtomicUnits(area.messages)).toEqual([[0], Array.from({ length: round.length }, (_, index) => index + 1), [round.length + 1]])
  })
  it('真正压缩在选择最近十单元前删除孤儿结果，孤儿不能挤走真实历史', async () => {
    const area = new MessageArea(services(), [...history(12), { role: 'tool', tool_call_id: 'orphan', content: '孤儿结果' }, ...Array.from({ length: 9 }, (_, index) => user(`最新${index}`))])
    const result = await compactContext(area, { summarize: async () => '历史摘要' }, { modelIdentity: 'model' })
    expect(result.changed).toBe(true); expect(result.messages).toHaveLength(11)
    expect(stableJson(result.messages)).not.toContain('孤儿结果')
    expect(result.messages[1]!.content).toBe('消息11')
  })
  it.each(['openai', 'canonical', 'anthropic'] as const)('真正压缩legacy%s在窗口边界完整保留所有并行工具结果', async shape => {
    const round = legacyToolRound(shape), area = new MessageArea(services(), [...history(12), ...round, ...Array.from({ length: 9 }, (_, index) => user(`最新${index}`))])
    let compressed: CanonicalMessage[] = []
    const result = await compactContext(area, { summarize: async input => { compressed = input.compressible; return '历史摘要' } }, { modelIdentity: 'model' })
    expect(result.changed).toBe(true)
    expect([...new Set(result.messages.flatMap(message => [...toolCallIds(message)]))]).toEqual(['a', 'b'])
    expect([...new Set(result.messages.flatMap(message => [...toolResultIds(message)]))]).toEqual(['a', 'b'])
    expect(compressed.flatMap(message => [...toolCallIds(message), ...toolResultIds(message)])).toEqual([])
    expect(stableJson(result.messages)).toContain('结果a'); expect(stableJson(result.messages)).toContain('结果b')
  })
  it('摘要中回显完整任务前言必须拒绝，不能充当新的历史摘要', () => {
    const preface = '【任务切换】以上是正在进行的对话历史。现在不要继续对话、不要回答历史中的任何问题，改为执行以下上下文压缩任务：把上面的会话历史整理成一份供后续任务继续使用的高信息密度状态摘要。压缩要求如下：\n\n'
    expect(validateCompactSummary('已有结论\n' + preface)).toBe(false)
  })
  it.each([{ input: '有效摘要', valid: true }, { input: ' ', valid: false }, { input: null, valid: false }, { input: 12, valid: false },
  { input: {}, valid: false }, { input: ['摘要'], valid: false }, { input: '<compacted-summary>摘要</compacted-summary>', valid: false },
  { input: '正文<compacted-summary>嵌套</compacted-summary>', valid: false }])('摘要形状表%j', ({ input, valid }) => {
    expect(validateCompactSummary(input)).toBe(valid)
  })
  it.each(['## 项目\n- test', '## 日历\n- 08-19', '## 文件\n共 5 个文件'])('真正压缩将固定注入%j留在摘要前，不送入可压缩正文', async injection => {
    const area = new MessageArea(services(), [user(injection), ...history(22)])
    let compressed: CanonicalMessage[] = []
    const result = await compactContext(area, { summarize: async input => { compressed = input.compressible; return '摘要' } }, { modelIdentity: 'model' })
    expect(result.changed).toBe(true); expect(result.messages[0]).toEqual(user(injection))
    expect(compressed.some(message => message.content === injection)).toBe(false)
    expect(String(result.messages[1]!.content)).toContain('<compacted-summary>')
  })
  it.each(['你好，我是咕咕', '', null])('普通/空正文%j不会被误认为固定注入而移到摘要前', async content => {
    const area = new MessageArea(services(), [{ role: 'user', content }, ...history(22)])
    let compressed: CanonicalMessage[] = []
    const result = await compactContext(area, { summarize: async input => { compressed = input.compressible; return '摘要' } }, { modelIdentity: 'model' })
    expect(result.changed).toBe(true); expect(String(result.messages[0]!.content)).toContain('<compacted-summary>')
    expect(compressed.some(message => message.content === content)).toBe(true)
  })
  it('已有wire摘要作为previousSummary完整传递，不作为普通历史再次压缩', async () => {
    const previous = '<compacted-summary>\n旧摘要\n</compacted-summary>', area = new MessageArea(services(), [user(previous), ...history(22)])
    const result = await compactContext(area, {
      summarize: async input => {
        expect(input.previousSummary).toBe(previous)
        expect(input.compressible.some(message => message.content === previous)).toBe(false)
        return '新摘要'
      }
    }, { modelIdentity: 'model' })
    expect(result.changed).toBe(true)
  })
  it('真实用户提及摘要标记不变成previousSummary、不丢当前用户锚点，合法NOTICE摘要仍兼容', async () => {
    const request = '帮我看下 <compacted-summary> 是什么格式', area = new MessageArea(services(), [...history(12), user(request), { role: 'assistant', content: '最新执行轮' }])
    const result = await compactContext(area, { summarize: async input => { expect(input.previousSummary).toBeNull(); return '摘要' } },
      { modelIdentity: 'model', window: { anchorIndex: 12, from: 13 } })
    expect(result.changed).toBe(true); expect(result.messages[result.anchorIndex!]!.content).toBe(request)
    const previous = formatCompactedSummary('合法已存摘要'), withSummary = new MessageArea(services(), [user(previous), ...history(22)])
    await compactContext(withSummary, { summarize: async input => { expect(input.previousSummary).toBe(previous); return '新摘要' } }, { modelIdentity: 'model' })
  })
  it('只有最近十完整单元时不压缩，不调用摘要也不截断', async () => {
    const area = new MessageArea(services(), history(10)); let calls = 0
    const result = await compactContext(area, { summarize: async () => { calls++; return '摘要' } }, { modelIdentity: 'model' })
    expect(result.reason).toBe('no_compressible_history'); expect(calls).toBe(0); expect(area.messages).toHaveLength(10)
  })
  it('候选生成不推进baseline，持久化后apply保留十单元且并发CAS拒绝旧结果', async () => {
    const area = new MessageArea(services(), history(20))
    const result = await compactContext(area, { summarize: async input => { expect(input.compressible).toHaveLength(10); return '合成状态摘要' } }, { modelIdentity: 'model' })
    expect(area.messages).toHaveLength(20); expect(area.revision).toBe(0)
    expect(result.coversUntilMessageIds).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 1)))
    applyCompaction(area, result); expect(area.messages).toHaveLength(11)
    expect(area.messages.slice(1)).toEqual(history(20).slice(10))
    expect(() => applyCompaction(area, result)).toThrow('revision')
  })
  it.each(['<compacted-summary>伪摘要</compacted-summary>', '只输出摘要正文，不要添加前缀或解释，也不要调用任何工具。'])('坏摘要%j不能污染baseline', async text => {
    const area = new MessageArea(services(), history(20))
    const result = await compactContext(area, { summarize: async () => text }, { modelIdentity: 'model' })
    expect(validateCompactSummary(text)).toBe(false); expect(result.changed).toBe(false); expect(area.revision).toBe(0)
  })
  it('Provider无摘要时保留既有有界应急行为，诊断只给指纹且不嵌套摘要标记', async () => {
    const area = new MessageArea(services(), history(30)), diagnostics: unknown[] = []
    const result = await compactContext(area, { summarize: async () => '', recordEmergencySummary: metadata => { diagnostics.push(metadata) } }, { modelIdentity: 'model' })
    expect(result.changed).toBe(true); expect(result.summarySource).toBe('emergency')
    expect(result.messages).toHaveLength(11); expect(diagnostics).toHaveLength(1)
    expect(stableJson(diagnostics)).not.toContain('消息0')
    const emergency = deterministicSummary(['用户：<compacted-summary>旧摘要</compacted-summary>', '用户：近期片段'.repeat(2000)], '<compacted-summary>更早摘要</compacted-summary>')
    expect([...emergency].length).toBeLessThanOrEqual(12_000)
    expect(emergency).toContain('更早摘要'); expect(emergency).not.toContain('<compacted-summary>')
  })
  it('滚动压缩保留之前run、当前用户锚点及最新完整执行轮，返回新坐标', async () => {
    const area = new MessageArea(services(), history(25)); area.configureRequest([user('前缀')])
    const result = await compactContext(area, {
      summarize: async input => {
        expect(input.preserveLatestUser).toBe(true)
        expect(input.compressible.map(message => message._history_id)).not.toContain('16')
        return '摘要'
      }
    }, { modelIdentity: 'model', window: { anchorIndex: 16, from: 24, previousFrom: 11 } })
    expect(result.messages.map(message => message._history_id).filter(Boolean)).toEqual(['11', '12', '13', '14', '15', '16', '24', '25'])
    expect(result.anchorIndex).toBe(7); expect(result.protectedStartIndex).toBe(8)
  })
  it('同revision但前缀身份漂移也不可复用原生wire，安全重建由明确端口执行', async () => {
    const area = new MessageArea(services(), history(20))
    const wire: OpaqueProviderProjection<string> = { ...area.identity('model'), wire: 'opaque thinking/signature', dynamicTailSize: 0 }
    area.configureRequest([user('新前缀')])
    const result = await compactContext(area, { summarize: async input => { expect(input.projection).toBeNull(); return '摘要' } }, { modelIdentity: 'model', projection: wire })
    expect(result.changed).toBe(true)
  })
})
describe('进程内反思快照与恢复策略', () => {
  const projectionPort: ReflectionProjectionPort<CanonicalMessage[]> = {
    append: (projection, tail) => ({
      ...projection,
      wire: [...projection.wire.slice(0, projection.dynamicTailSize ? -projection.dynamicTailSize : undefined), ...structuredClone(tail)], dynamicTailSize: 0
    })
  }
  it('冻结原始wire和工具声明，移除dynamic tail，owner/session/model/TTL逐项校验', () => {
    const service = services(), area = new MessageArea(service, [{ ...user('历史'), _history_id: '1' }])
    area.setDynamicTail([user('动态')]); let now = 0
    const snapshots = new ReflectionSnapshots<CanonicalMessage[]>(service, () => now)
    const wire = [{ role: 'assistant', content: [{ type: 'thinking', signature: 'native-signature' }] }, user('动态')]
    const snapshot = snapshots.capture({
      ownerId: 'owner', sessionId: 'session', runId: 'run', modelIdentity: 'model', accessScopeHash, area,
      projection: { ...area.identity('model'), wire, dynamicTailSize: 1 }, replyText: '回复', systemPrompt: '人格', tools: [{ name: 'search' }]
    }, projectionPort)!
    expect(snapshot.projection.wire).toEqual([wire[0], { role: 'assistant', content: '回复' }])
    snapshot.projection.wire[0]!.content = '外部修改'
    expect(stableJson(snapshots.peek({ ownerId: 'owner', sessionId: 'session' }, 'model', accessScopeHash))).toContain('native-signature')
    expect(snapshots.peek({ ownerId: 'other', sessionId: 'session' }, 'model', accessScopeHash)).toBeNull()
    expect(snapshots.peek({ ownerId: 'owner', sessionId: 'other' }, 'model', accessScopeHash)).toBeNull()
    expect(snapshots.peek({ ownerId: 'owner', sessionId: 'session' }, 'other', accessScopeHash)).toBeNull()
    now = 900_001
    expect(snapshots.peek({ ownerId: 'owner', sessionId: 'session' }, 'model', accessScopeHash)).toBeNull()
  })
  it('持久化前缀边界不精确匹配拒绝追加，sibling读取不消费原快照', () => {
    const service = services(), area = new MessageArea(service, [{ ...user('历史'), _history_id: '1' }])
    const snapshots = new ReflectionSnapshots<CanonicalMessage[]>(service, () => 0)
    const snapshot = snapshots.capture({
      ownerId: 'owner', sessionId: 'session', runId: 'run', modelIdentity: 'model', accessScopeHash, area,
      projection: { ...area.identity('model'), wire: area.messages, dynamicTailSize: 0 }, replyText: '回复', systemPrompt: '', tools: []
    }, projectionPort)!
    const persistedPrefix = [{ id: '1', sequence: 0, message: user('历史') }]
    expect(() => appendReflectionHistory(snapshot, { ownerId: 'owner', sessionId: 'session', modelIdentity: 'model', accessScopeHash, persistedPrefixIds: ['wrong'], persistedPrefix, messages: [] }, projectionPort, service)).toThrow('持久化边界')
    expect(() => appendReflectionHistory(snapshot, { ownerId: 'owner', sessionId: 'session', modelIdentity: 'model', accessScopeHash, persistedPrefixIds: ['1'], persistedPrefix: [{ ...persistedPrefix[0]!, message: user('同id不同正文') }], messages: [] }, projectionPort, service)).toThrow('持久化边界')
    const appended = appendReflectionHistory(snapshot, { ownerId: 'owner', sessionId: 'session', modelIdentity: 'model', accessScopeHash, persistedPrefixIds: ['1'], persistedPrefix, messages: [user('后续被动消息')] }, projectionPort, service)
    expect(appended.wire.at(-1)).toEqual(user('后续被动消息'))
    expect(snapshots.peek({ ownerId: 'owner', sessionId: 'session' }, 'model', accessScopeHash)!.projection.wire).toHaveLength(2)
  })
  it('内存快照容量LRU与显式丢弃有效，保存最后主请求usage与压缩标记', () => {
    const service = services(), area = new MessageArea(service, [user('历史')])
    const snapshots = new ReflectionSnapshots<CanonicalMessage[]>(service, () => 0, 900_000, 2)
    const capture = (sessionId: string): void => {
      snapshots.capture({
        ownerId: 'owner', sessionId, runId: 'run', modelIdentity: 'model', accessScopeHash, area,
        projection: { ...area.identity('model'), wire: area.messages, dynamicTailSize: 0 }, replyText: '回复', systemPrompt: '', tools: [], providerContextInput: 85, providerCompacted: true
      }, projectionPort)
    }
    capture('a'); capture('b'); snapshots.peek({ ownerId: 'owner', sessionId: 'a' }, 'model', accessScopeHash); capture('c')
    expect(snapshots.peek({ ownerId: 'owner', sessionId: 'b' }, 'model', accessScopeHash)).toBeNull()
    const found = snapshots.peek({ ownerId: 'owner', sessionId: 'a' }, 'model', accessScopeHash)!
    expect(found.providerContextInput).toBe(85); expect(found.providerCompacted).toBe(true)
    snapshots.discard({ ownerId: 'owner', sessionId: 'a' })
    expect(snapshots.peek({ ownerId: 'owner', sessionId: 'a' }, 'model', accessScopeHash)).toBeNull()
  })
  it('同owner/session/model按访问作用域隔离，缺binding不返回旧owner前缀，同主Run sibling仍可共享', () => {
    const service = services(), ownerArea = new MessageArea(service, [user('owner私有项目资料')]), cache = new ReflectionSnapshots<CanonicalMessage[]>(service, () => 0)
    const input = { ownerId: 'owner', sessionId: 'session', runId: 'run', modelIdentity: 'model', systemPrompt: '人格', tools: [], replyText: '回复' }
    expect(cache.capture({ ...input, area: ownerArea, projection: { ...ownerArea.identity('model'), wire: ownerArea.messages, dynamicTailSize: 0 } }, projectionPort)).toBeNull()
    cache.capture({ ...input, accessScopeHash, area: ownerArea, projection: { ...ownerArea.identity('model'), wire: ownerArea.messages, dynamicTailSize: 0 } }, projectionPort)
    expect(cache.peek(input, 'model')).toBeNull()
    expect(cache.peek(input, 'model', 'scope-member')).toBeNull()
    const memberArea = new MessageArea(service, [user('当前群成员资料')])
    cache.capture({ ...input, accessScopeHash: 'scope-member', area: memberArea, projection: { ...memberArea.identity('model'), wire: memberArea.messages, dynamicTailSize: 0 } }, projectionPort)
    expect(stableJson(cache.peek(input, 'model', 'scope-member'))).not.toContain('owner私有项目资料')
    expect(stableJson(cache.peek(input, 'model', accessScopeHash))).toContain('owner私有项目资料')
    cache.discard(input)
    expect(cache.peek(input, 'model', 'scope-member')).toBeNull(); expect(cache.peek(input, 'model', accessScopeHash)).toBeNull()
  })
  it.each(['group', 'member'] as const)('普通%s反思跨进程缺快照等待，显式压力压缩才重建', scope => {
    expect(reflectionRecoveryPolicy(scope, false, 'idle')).toBe('defer')
    expect(reflectionRecoveryPolicy(scope, false, 'context-pressure')).toBe('rebuild')
    expect(reflectionRecoveryPolicy(scope, true, 'idle')).toBe('reuse')
  })
})
describe('摘要请求的实际超窗恢复', () => {
  it('清空工具参数保留类型/id/结果，完整单元裁半不拆工具组或最后一组', () => {
    const original: CanonicalMessage[] = [{ role: 'system', content: 'system' },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'search', arguments: '{ "query": "large" }' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '完整结果' }] }, user('中间'), user('最新')]
    const stripped = stripToolCallInputs(original)
    expect(stripped.changedCalls).toBe(1)
    expect(stripped.messages[1]!.content).toEqual([{ type: 'tool_call', id: 'a', name: 'search', arguments: '{}' }])
    expect(stripped.messages[2]).toEqual(original[2])
    expect(stableJson(original[1])).toContain('large')
    expect(trimOldestHistory(stripped.messages).messages).toEqual([original[0], original[3], original[4]])
  })
  it('预算来自模型配置且输出截断识别以Provider finish reason为准', () => {
    expect(resolveCompactionLimits(100, 30)).toEqual({ contextTokens: 100, inputTokens: 70, outputTokens: 30 })
    expect(resolveCompactionLimits(100, 300).outputTokens).toBe(99)
    expect(() => resolveCompactionLimits(0, 10)).toThrow('context_tokens')
    expect(summaryOutputExhausted({ output: 30, finish_reason: 'stop' }, 30)).toBe(false)
    expect(summaryOutputExhausted({ output: 30, finish_reason: 'length' }, 30)).toBe(true)
    expect(summaryOutputExhausted({ output: 30 }, 30)).toBe(true)
    expect(summaryOutputExhausted(null, 30)).toBe(false)
  })
  it('只在明确超窗后依次清工具输入、裁旧单元，第三次请求不改原历史', async () => {
    const original = [...history(12), { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'read', arguments: { query: '完整参数' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '结果' }] }] as CanonicalMessage[]
    const sent: CanonicalMessage[][] = [], tasks: string[] = []
    const port: SummaryGenerationPorts<string> = {
      ...services(), diagnostic: () => { }, pauseBeforeRetry: async () => { },
      transformProjection: () => { throw new Error('不应变换不存在的wire') }, provider: {
        isInputRejected: () => false,
        complete: async input => {
          sent.push(structuredClone(input.canonicalHistory!)); tasks.push(input.delta)
          if (sent.length < 3) throw new Error('maximum context length')
          return { output: '最终有效摘要', usage: { output: 5, finish_reason: 'stop' } }
        }
      }
    }
    const summarizer = createCompactionSummarizer({ ownerId: 'owner', sessionId: 'session', runId: 'run', stableSystem: '', tools: [], contextTokens: 1000, maxOutputTokens: 100, instruction: '合成压缩任务' }, port)
    const result = await summarizer.summarize({ history: original, compressible: original.slice(0, 4), previousSummary: '旧摘要', projection: null, preserveLatestUser: true })
    expect(result).toBe('最终有效摘要'); expect(sent).toHaveLength(3)
    expect(stableJson(sent[0])).toContain('完整参数'); expect(stableJson(sent[1])).not.toContain('完整参数')
    expect(sent[2]!.length).toBeLessThan(sent[1]!.length)
    expect(sent[2]!.slice(-2)).toEqual(sent[1]!.slice(-2))
    expect(tasks[1]).toContain('以对应的工具结果为准'); expect(tasks[2]).toContain('不要推测被裁切的消息')
    expect(stableJson(original)).toContain('完整参数')
  })
  it('Provider输出截断不能作为成功摘要，普通错误不触发裁窗', async () => {
    let transforms = 0, calls = 0
    const port: SummaryGenerationPorts<string> = {
      ...services(), diagnostic: () => { }, pauseBeforeRetry: async () => { },
      transformProjection: projection => { transforms++; return { projection, changedMessages: 1 } }, provider: {
        isInputRejected: () => false,
        complete: async () => { calls++; return { output: '不完整摘要', usage: { output: 100, finish_reason: 'length' } } }
      }
    }
    const summarizer = createCompactionSummarizer({ ownerId: 'owner', sessionId: 'session', runId: 'run', stableSystem: '', tools: [], contextTokens: 1000, maxOutputTokens: 100, instruction: '任务' }, port)
    const input = { history: history(20), compressible: history(10), previousSummary: null, projection: null, preserveLatestUser: false }
    expect(await summarizer.summarize(input)).toBe(''); expect(calls).toBe(1); expect(transforms).toBe(0)
    port.provider.complete = async () => { calls++; throw new Error('ordinary failure') }
    expect(await summarizer.summarize(input)).toBe(''); expect(calls).toBe(3); expect(transforms).toBe(0)
  })
})
