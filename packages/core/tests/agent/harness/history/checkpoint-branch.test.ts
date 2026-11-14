import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { BranchInput,BranchPorts,CanonicalMessage,ContextReferenceCodec,ContextServices,Json,PreparedContext } from "../../../../src/agent/harness/index.js"
import { MessageArea,assertDurableCanonical,restorePreparedContext,runContextBranch,savePreparedContext,stableJson } from "../../../../src/agent/harness/index.js"
const identity = { ownerId: 'owner', sessionId: 'session' }
const user = (content: Json): CanonicalMessage => ({ role: 'user', content })
function services(): ContextServices {
  let id = 0
  return { nextId: () => `id-${++id}`, digest: value => createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16) }
}
describe('安全上下文checkpoint', () => {
  it.each(['null', 'missing-role', 'role', 'tool-id', 'invalid-block'] as const)('ledger codec损坏%s必须在生成可提交checkpoint前拒绝', async corruption => {
    const area = new MessageArea(services())
    area.append({ role: 'user', _history_id: 'history', content: [{ type: 'tool_result', tool_call_id: 'call', content: '结果' }] }, { source: 'tool_round' })
    const codec: ContextReferenceCodec = {
      hydrate: async entry => entry.message, dehydrate: async entry => {
        if (corruption === 'null') return null as unknown as CanonicalMessage
        const value = structuredClone(entry.message)
        if (corruption === 'missing-role') delete (value as Record<string, Json>).role
        if (corruption === 'role') value.role = 'assistant'
        if (corruption === 'tool-id') ((value.content as Json[])[0] as Record<string, Json>).tool_call_id = 'other'
        if (corruption === 'invalid-block') value.content = [{ type: 'not-canonical', text: '无效' }]
        return value
      }
    }
    await expect(savePreparedContext({ area, rag: { tail: [] }, stanceToPersist: null, protectedHistoryStart: null }, identity, codec)).rejects.toThrow()
  })
  it('临时媒体必须dehydrate成稳定引用，重启重算prefix/tail且保留batch/entry/seq', async () => {
    const ports = services(), area = new MessageArea(ports)
    area.appendBatch([{ message: user([{ type: 'image', source: { type: 'base64', data: 'synthetic-base64' } }]), source: 'attachment', persistencePolicy: 'already_persisted', persistedMessageId: 'db-1' },
    { message: user('工具结果'), source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-1' }], { kind: 'tool-round' })
    area.configureRequest([user('旧前缀')]); area.setDynamicTail([user('旧动态')])
    area.protectedHistoryStart = 1
    const prepared: PreparedContext = { area, rag: { tail: [] }, stanceToPersist: null, protectedHistoryStart: 1 }
    const codec: ContextReferenceCodec = {
      dehydrate: async (entry, owner) => { expect(owner).toEqual(identity); return entry.source === 'attachment' ? user([{ type: 'attachment_ref', attach_id: 'att-1' }]) : entry.message },
      hydrate: async (entry, owner) => { expect(owner).toEqual(identity); return entry.source === 'attachment' ? user([{ type: 'image', source: { type: 'base64', data: 'newly-authorized' } }]) : entry.message },
    }
    const saved = await savePreparedContext(prepared, identity, codec)
    expect(stableJson(saved)).not.toContain('base64'); expect(stableJson(saved)).not.toContain('旧前缀'); expect(stableJson(saved)).not.toContain('旧动态')
    const restored = await restorePreparedContext(saved, identity, { ...ports, prepareRequest: async () => ({ prefix: [user('新前缀')], dynamicTail: [user('新动态')] }) }, codec)
    expect(restored.area.entries.map(entry => [entry.entryId, entry.sequence, entry.roundId])).toEqual(area.entries.map(entry => [entry.entryId, entry.sequence, entry.roundId]))
    expect(restored.area.persistenceDelta('success')).toEqual(area.persistenceDelta('success'))
    expect(restored.area.requestPrefix).toEqual([user('新前缀')]); expect(restored.area.dynamicTail).toEqual([user('新动态')])
    expect(restored.protectedHistoryStart).toBe(1)
  })
  const unsafeBlocks: Json[] = [{ type: 'image', source: 'payload' }, { type: 'attachment_ref', attach_id: 'a', url: 'https://example.invalid' },
  { type: 'thinking', signature: 'private' }, { type: 'attachment_ref', attach_id: 'a', token: 'private' },
  { type: 'tool_result', content: { execution_grant: '合成执行凭证' } },
  { type: 'tool_result', content: { confirmation_grant: '合成确认凭证' } }]
  it.each(unsafeBlocks)('拒绝未固化的媒体/凭据%j', block => {
    expect(() => assertDurableCanonical(block)).toThrow()
  })
  it('可信Schema属性名与业务结果字段不误判成Provider私有signature', () => {
    expect(() => assertDurableCanonical({ type: 'tool-schema', schema: { input_schema: { type: 'object', properties: { signature: { type: 'string' } } } } })).not.toThrow()
    expect(() => assertDurableCanonical({ type: 'tool_result', tool_call_id: 'a', content: { signature: '业务签名字段' } })).not.toThrow()
  })
  it('归属或完整性失败在调用引用hydrate之前拒绝，不能越权读附件', async () => {
    const ports = services(), area = new MessageArea(ports, [user('历史')]); let calls = 0
    const codec: ContextReferenceCodec = { dehydrate: async entry => entry.message, hydrate: async entry => { calls++; return entry.message } }
    const prepared: PreparedContext = { area, rag: { tail: [] }, stanceToPersist: null, protectedHistoryStart: null }
    const saved = await savePreparedContext(prepared, identity, codec)
    const restorePorts = { ...ports, prepareRequest: async () => ({ prefix: [], dynamicTail: [] }) }
    await expect(restorePreparedContext(saved, { ...identity, ownerId: 'other' }, restorePorts, codec)).rejects.toThrow('归属')
    saved.area.entries[0]!.message.content = '破坏'
    await expect(restorePreparedContext(saved, identity, restorePorts, codec)).rejects.toThrow('指纹')
    expect(calls).toBe(0)
  })
  it('引用固化期间ledger变化拒绝混合revision的checkpoint', async () => {
    const area = new MessageArea(services(), [user('历史')])
    await expect(savePreparedContext({ area, rag: { tail: [] }, stanceToPersist: null, protectedHistoryStart: null }, identity,
      { dehydrate: async entry => { area.append(user('并发消息')); return entry.message }, hydrate: async entry => entry.message })).rejects.toThrow('已变化')
  })
})
describe('压缩/反思共用分支编排', () => {
  const input: BranchInput<string> = { ...identity, runId: 'run-1', stableSystem: '人格', delta: '任务', tools: [], scope: 'owner' }
  function ports(outputs: Json[]): BranchPorts<string> & { calls: BranchInput<string>[]; pauses: number[]; diagnostics: string[] } {
    const calls: BranchInput<string>[] = [], pauses: number[] = [], diagnostics: string[] = []
    return {
      ...services(), calls, pauses, diagnostics, pauseBeforeRetry: async attempt => { pauses.push(attempt) },
      diagnostic: (_, metadata) => { diagnostics.push(stableJson(metadata)) }, provider: {
        isInputRejected: () => false,
        complete: async request => { calls.push(request); return { output: outputs.shift() ?? null, usage: { cache_read: 10 } } }
      }
    }
  }
  it('只追加任务一次，scope/revision属于metadata，空输出有限重试并暂停', async () => {
    const port = ports(['', '有效摘要'])
    const result = await runContextBranch(input, { name: 'compaction', outputMode: 'text', maxRetries: 1 }, port)
    expect(result.ok).toBe(true); expect(result.attempts).toBe(2); expect(result.output).toBe('有效摘要')
    expect(port.calls.map(call => call.delta)).toEqual(['任务', '任务']); expect(port.pauses).toEqual([2])
    expect(result.metadata.scope).toBe('owner'); expect(result.usage).toEqual({ cache_read: 10 })
  })
  it.each([['', 'output_empty'], [{}, 'output_empty'], [[], 'schema_invalid'], ['   ', 'schema_invalid']] as const)('非法JSON响应%j归类为%s', async (output, reason) => {
    const result = await runContextBranch(input, { name: 'reflection' }, ports([structuredClone(output) as Json]))
    expect(result.ok).toBe(false); expect(result.output).toBeNull(); expect(result.reason).toBe(reason)
  })
  it('敏感输入拒绝和compaction超窗不重复相同请求，异常正文只进受限diagnostic', async () => {
    for (const sensitive of [true, false]) {
      const port = ports([])
      port.provider.complete = async () => { throw new Error(sensitive ? 'private response body' : 'maximum context length') }
      port.provider.isInputRejected = () => sensitive
      const result = await runContextBranch(input, { name: 'compaction', maxRetries: 2 }, port)
      expect(result.attempts).toBe(1); expect(result.reason).toBe('provider_error')
      expect(result.providerErrorCode).toBe(sensitive ? 'input_sensitive' : null)
      expect(port.diagnostics.join('')).not.toContain('private response body')
      expect(port.diagnostics.join('')).not.toContain('run-1')
    }
  })
  it('cache singleflight仅反思追加复用开启，Provider wire保持opaque', async () => {
    const area = new MessageArea(services())
    for (const name of ['reflection', 'compaction'] as const) {
      const port = ports([{ summary: 'ok' }]); let singleflight = false
      port.provider.complete = async request => { singleflight = request.cacheSingleflight; expect(request.projection!.wire).toBe('opaque signature'); return { output: { summary: 'ok' }, usage: null } }
      const result = await runContextBranch({ ...input, projection: { ...area.identity('model'), wire: 'opaque signature', dynamicTailSize: 0 } }, { name }, port)
      expect(result.ok).toBe(true); expect(singleflight).toBe(name === 'reflection')
    }
  })
  it('只读分支Provider篡改请求不影响原始投影/工具或主continuation', async () => {
    const port = ports([{ summary: 'ok' }]), area = new MessageArea(services())
    const original: BranchInput<string> = { ...input, projection: { ...area.identity('model'), wire: 'opaque-native-prefix', dynamicTailSize: 0 }, tools: [{ name: 'search' }] }
    const before = structuredClone(original)
    port.provider.complete = async request => { request.projection!.wire = 'mutated'; request.tools[0] = { name: 'mutated' }; return { output: { summary: 'ok' }, usage: null } }
    await runContextBranch(original, { name: 'reflection' }, port)
    expect(original).toEqual(before)
  })
  it('取消不产生provider_error终态也不重试', async () => {
    const cancel = new AbortController(), port = ports([])
    port.provider.complete = async () => { cancel.abort(new Error('已取消')); throw new Error('底层中断') }
    await expect(runContextBranch(input, { name: 'reflection', maxRetries: 2 }, port, cancel.signal)).rejects.toThrow('已取消')
    expect(port.diagnostics).toEqual([])
  })
})
