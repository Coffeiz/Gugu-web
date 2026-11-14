import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { Block,CanonicalMessage,ContextServices,EntryInput,Json,OpaqueProviderProjection } from "../../../../src/agent/harness/index.js"
import { MessageArea,appendCanonicalEvents,atomicMessageUnits,buildCanonicalContext,canonicalEventStats,canonicalToolRound,canonicalizeMessage,contextDiagnostics,groupHistoryUnits,isInternalUserMessage,lastUserIndex,normalizeHistoryMessage,redactToolRequestHeaders,refreshCanonicalToolSchemas,renderCanonicalEvents,stableJson,toolSchemaDigest,userTextFromMessage } from "../../../../src/agent/harness/index.js"

function services(): ContextServices {
  let id = 0
  return { nextId: () => `entry-${++id}`, digest: value => createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16) }
}
const user = (content: string): CanonicalMessage => ({ role: 'user', content })
describe('Canonical 历史与 ledger 不变量', () => {
  it('最后真实user跳过系统提醒和内部上下文，包含图片的真实文字仍可提取', () => {
    const messages: CanonicalMessage[] = [user('上一轮'), user('[system-reminder]\n当前时间\n[/system-reminder]'),
    user('当前问题'), { role: 'user', content: [{ type: 'runtime-context', text: '工作区' }] }, { role: 'system', content: '系统' }]
    expect(isInternalUserMessage(messages[1])).toBe(true); expect(isInternalUserMessage(messages[3])).toBe(true)
    expect(lastUserIndex(messages)).toBe(2); expect(userTextFromMessage(messages[2])).toBe('当前问题')
    const image: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', source: { type: 'url' } }] }
    expect(isInternalUserMessage(image)).toBe(false); expect(userTextFromMessage(image)).toBe('看这张图')
    expect(lastUserIndex([messages[1], messages[3], messages[4]])).toBeNull()
    expect(userTextFromMessage({ role: 'system', content: '不是用户' })).toBe('')
  })
  it.each(['content', 'content_json'] as const)('legacy完整时间提醒%s转成time-context后Provider事件投影逐字节保留', field => {
    const text = '[system-reminder]\n08-27 18:27\n[/system-reminder]'
    const normalized = normalizeHistoryMessage({ role: 'user', ...(field === 'content' ? { content: text } : { content_json: [{ type: 'text', text }] }) })
    expect(normalized.contentBlocks).toEqual([{ type: 'time-context', text }])
    expect(renderCanonicalEvents([{ role: 'user', content: normalized.contentBlocks }])).toEqual([{ role: 'user', content: [{ type: 'text', text }] }])
  })
  it('Provider分支prefix投影失败直接暴露，不能回退到空历史', () => {
    const area = new MessageArea(services(), [user('真实历史')]), failure = new Error('投影失败')
    expect(() => area.project({ project: () => { throw failure } }, 'model')).toThrow(failure)
    expect(area.messages).toEqual([user('真实历史')])
  })
  it('Schema与tool_result独立消息但同round/batch，最近相同schema去重，换实现必须重申', () => {
    const service = services(), area = new MessageArea(service)
    const pair = area.appendBatch([{ message: { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'get_tool_schema', arguments: '{}' }] }, source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-1' },
    { message: { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: 'ok' }] }, source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-1' }], { kind: 'tool-round' })
    const schema = { name: 'read', input_schema: { type: 'object' } }
    const event: Block = { type: 'tool-schema', tool_name: 'read', schema_version: 1, schema_digest: toolSchemaDigest(schema, service), implementation_digest: 'impl-1', schema }
    const options = { batchId: pair[0]!.batchId!, roundId: 'round-1' }
    expect(appendCanonicalEvents(area, [event, event], options)).toHaveLength(1)
    expect(area.messages[1]!.content).toEqual([{ type: 'tool_result', tool_call_id: 'a', content: 'ok' }])
    expect(area.messages[2]!.content).toEqual([event]); expect(area.persistenceDelta('success').batches).toHaveLength(1)
    expect(appendCanonicalEvents(area, [{ ...event, implementation_digest: 'impl-2' }], options)).toHaveLength(1)
    expect(appendCanonicalEvents(area, [event], options)).toHaveLength(1)
    const stats = canonicalEventStats(area.messages)
    expect(stats.byType['tool-schema']).toBe(3); expect(stats.schemaDigests).toEqual([String(event.schema_digest)])
    expect(stableJson(stats)).not.toContain('input_schema')
  })
  it('schema刷新只影响请求，事件保持原block位置且不清理工具正文中的业务null', () => {
    const event: Block = { type: 'tool-schema', tool_name: 'read', schema_digest: 'old', schema: { name: 'read' }, implementation_digest: 'impl' }
    const area = new MessageArea(services(), [{ role: 'user', content: [event] }])
    refreshCanonicalToolSchemas(area, [{ ...event, schema_digest: 'new', schema: { name: 'read', changed: true } }])
    expect(area.persistenceDelta('success').entries).toEqual([])
    const messages: CanonicalMessage[] = [{ role: 'user', content: [{ type: 'time-context', text: '消息时间', unused: null }, { type: 'text', text: '正文' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: { value: null } }] }]
    const rendered = renderCanonicalEvents(messages)
    expect(rendered[0]!.content).toEqual([{ type: 'text', text: '消息时间' }, { type: 'text', text: '正文' }])
    expect(rendered[1]!.content).toEqual(messages[1]!.content)
    expect(messages[0]!.content).toEqual([{ type: 'time-context', text: '消息时间', unused: null }, { type: 'text', text: '正文' }])
  })
  it('稳定system/snapshot/history/current分区独立，诊断仅指纹和结构计数', () => {
    const ports = services()
    const base = buildCanonicalContext({ fixedParts: [{ role: 'system', content: '静态人格' }, { role: 'system', content: '[system-reminder]\n快照\n[/system-reminder]' }], history: [user('历史')] })
    const changed = buildCanonicalContext({ fixedParts: [{ role: 'system', content: '静态人格' }, { role: 'system', content: '[system-reminder]\n快照\n[/system-reminder]' }], history: [user('历史')], currentTurn: [user('变化正文')] })
    const before = contextDiagnostics(base, ports), after = contextDiagnostics(changed, ports)
    expect(before.sectionDigests.staticSystem).toBe(after.sectionDigests.staticSystem)
    expect(before.sectionDigests.canonicalHistory).toBe(after.sectionDigests.canonicalHistory)
    expect(before.sectionDigests.currentTurn).not.toBe(after.sectionDigests.currentTurn)
    expect(before.canonicalDigest).not.toBe(after.canonicalDigest)
    expect(base.staticSystem).toHaveLength(1); expect(base.sessionSnapshot).toHaveLength(1)
    expect(stableJson(after)).not.toContain('变化正文')
  })
  it('引用只保留稳定字段，未知块保留为稳定文本，不改调用方', () => {
    const input: Record<string, Json> = {
      role: 'user', content_json: [{ type: 'text', text: '合成消息' }, { type: 'future', value: '保留' }],
      quoted_text: '合成引用', files: [{ attach_id: 'a', name: '合成.png', url: 'https://example.invalid/secret', token: 'synthetic' }],
      platform_user_id: 'member', platform_user_name: '小北', sent_at: '2026-11-13T00:00:00Z'
    }
    const before = structuredClone(input), envelope = normalizeHistoryMessage(input)
    expect(input).toEqual(before)
    expect(envelope.quote).toEqual({ type: 'quote', text: '合成引用' })
    expect(envelope.attachments).toEqual([{ type: 'attachment_ref', attach_id: 'a', name: '合成.png' }])
    expect(envelope.sender).toEqual({ id: 'member', name: '小北' })
    expect(envelope.unknownBlockCount).toBe(1)
    expect(envelope.contentBlocks[1]).toEqual({ type: 'text', text: '{"type":"future","value":"保留"}', source_type: 'future' })
  })
  it('工具组只配对相同id，budget完整保留连续的多工具结果', () => {
    const history: CanonicalMessage[] = [user('之前'), { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', content: '结果a', tool_call_id: 'a' }, { role: 'tool', content: '结果b', tool_call_id: 'b' }, user('之后')]
    expect(atomicMessageUnits(history)).toEqual([[0], [1, 2, 3], [4]])
    expect(groupHistoryUnits(history).map(unit => unit.kind)).toEqual(['message', 'tool_turn', 'message', 'message'])
    expect(groupHistoryUnits([history[1]!, { role: 'tool', content: '错误配对', tool_call_id: 'c' }]).map(unit => unit.kind)).toEqual(['message', 'message'])
  })
  it('工具原始参数字节串保持，私有推理不写入Canonical', () => {
    const message = canonicalizeMessage({
      role: 'assistant', content: [{ type: 'thinking', thinking: '私有' }], reasoning_content: '私有',
      tool_calls: [{ id: 'a', function: { name: 'search', arguments: '{ "x": 1 }' } }]
    })
    expect(message).toEqual({ role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'search', arguments: '{ "x": 1 }' }] })
  })
  it('Canonical工具批次只记录实际dispatch的前缀，保留原始参数字节和错误回执', () => {
    const calls = [{ id: 'a', name: 'read', input: { x: 1 }, rawArguments: '{ "x": 1 }' },
    { id: 'b', name: 'delete', input: { x: 2 } }]
    const history = canonicalToolRound({ text: '执行中', calls, dispatched: [{ callId: 'a', content: '失败结果', isError: true, toolName: 'read' }] })
    expect(history).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '执行中' }, { type: 'tool_call', id: 'a', name: 'read', arguments: '{ "x": 1 }' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'a', content: '失败结果', is_error: true, tool_name: 'read' }] }])
    expect(stableJson(history)).not.toContain('"id":"b"')
    expect(calls[0]!.rawArguments).toBe('{ "x": 1 }')
  })
  it('历史工具header递归脱敏而真实调用参数不变，无header字符串逐字节保留', () => {
    const raw = '{ "headers": {"Authorization":"synthetic-secret"}, "body": {"nested": [{"HeAdErS":{"X-Token":"synthetic-token"}}]} }'
    const redacted = redactToolRequestHeaders(raw)
    expect(String(redacted)).not.toContain('synthetic-secret'); expect(String(redacted)).not.toContain('synthetic-token')
    expect(JSON.parse(String(redacted)).headers).toEqual({ Authorization: '[已隐藏]' })
    expect(raw).toContain('synthetic-secret')
    expect(redactToolRequestHeaders('{ "query": "合成查询" }')).toBe('{ "query": "合成查询" }')
    expect(redactToolRequestHeaders('{ headers: broken')).toBe('[请求参数已隐藏]')
    const payload = { headers: { Authorization: '[已隐藏]' } }
    expect(redactToolRequestHeaders(payload)).toBe(payload)
  })
  it('快照和entry读取不能修改ledger，动态前缀不进入durable delta', () => {
    const area = new MessageArea(services(), [user('已恢复')])
    area.configureRequest([{ role: 'system', content: '人格' }]); area.setDynamicTail([user('动态提醒')])
    const entry = area.append(user('新增'), { source: 'rag', persistencePolicy: 'commit_on_success' })
    entry.message.content = '外部修改'; area.entries[0]!.message.content = '外部修改'; area.snapshot().entries[0]!.message.content = '外部修改'
    expect(area.messages).toEqual([user('已恢复'), user('新增')])
    expect(area.persistenceDelta('success').entries.map(value => value.message)).toEqual([user('新增')])
    expect(stableJson(area.snapshot())).not.toContain('人格')
    expect(stableJson(area.snapshot())).not.toContain('动态提醒')
  })
  it.each(['success', 'interruption', 'failure'] as const)('持久策略按%s终态筛选', outcome => {
    const area = new MessageArea(services())
    for (const policy of ['already_persisted', 'commit_on_success', 'commit_on_interruption', 'request_only', 'reconstruct_on_restore'] as const)
      area.append(user(policy), { persistencePolicy: policy })
    const expected = outcome === 'success' ? ['commit_on_success'] : outcome === 'interruption' ? ['commit_on_success', 'commit_on_interruption'] : []
    expect(area.persistenceDelta(outcome).entries.map(entry => entry.message.content)).toEqual(expected)
  })
  it('批次单次推进revision且恢复后保留相同收据边界和metadata指纹', () => {
    const port = services(), area = new MessageArea(port)
    area.appendBatch([{ message: user('a'), source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-1' },
    { message: user('b'), source: 'tool_round', persistencePolicy: 'commit_on_success', roundId: 'round-1' }], { kind: 'tool-round' })
    expect(area.revision).toBe(1)
    expect(area.entries.map(entry => entry.sequence)).toEqual([0, 1])
    const frozen = area.entries[0]!
    const delta = area.persistenceDelta('success')
    const recovered = MessageArea.restore(port, area.snapshot())
    expect(recovered.persistenceDelta('success')).toEqual(delta)
    expect(recovered.requestPrefix).toEqual([])
    expect(recovered.dynamicTail).toEqual([])
    const corrupted = area.snapshot(); corrupted.batches[0]!.metadata.kind = 'corrupted'
    expect(() => MessageArea.restore(port, corrupted)).toThrow('指纹')
    area.append(user('后来'))
    expect(area.entries.map(entry => entry.sequence)).toEqual([0, 1, 2])
    expect(frozen.message).toEqual(user('a'))
  })
  it('batch metadata读出是独立深副本，不能从snapshot或delta改写原ledger', () => {
    const area = new MessageArea(services()), metadata: Record<string, Json> = { kind: 'tool-round', nested: { generation: 1 }, tags: ['原始'] }
    area.appendBatch([{ message: user('回执'), source: 'tool_round', persistencePolicy: 'commit_on_success' }], metadata)
    const original = area.snapshot(), delta = area.persistenceDelta('success'), snapshot = area.snapshot()
    metadata.kind = '外部修改'; (metadata.nested as Record<string, Json>).generation = 2
      ; (delta.batches[0]!.metadata.nested as Record<string, Json>).generation = 3
      ; (snapshot.batches[0]!.metadata.tags as Json[]).push('读副本修改')
    expect(area.snapshot()).toEqual(original)
    expect(area.persistenceDelta('success').batches[0]!.metadata).toEqual({ kind: 'tool-round', nested: { generation: 1 }, tags: ['原始'] })
  })
  it('裸Canonical消息列表不能冒充EntryInput批次，错误输入整批拒绝且ledger不推进', () => {
    const area = new MessageArea(services()), original = area.snapshot()
    const bare = [user('缺少entry封套')]
    expect(() => area.appendBatch(bare as unknown as EntryInput[])).toThrow('Canonical批次')
    expect(area.snapshot()).toEqual(original)
    const accepted = area.appendBatch(bare.map(message => ({ message, source: 'user', persistencePolicy: 'already_persisted' })))
    expect(accepted[0]!.message).toEqual(bare[0]); expect(accepted[0]!.sequence).toBe(0)
  })
  it('新Canonical批次拒绝wire和私有推理，整批拒绝不推进revision', () => {
    const area = new MessageArea(services())
    for (const message of [{ role: 'tool', content: 'wire', tool_call_id: 'a' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] }] as CanonicalMessage[]) {
      expect(() => area.appendBatch([{ message: user('合法') }, { message }])).toThrow('Canonical批次')
      expect(area.revision).toBe(0); expect(area.entries).toEqual([])
    }
  })
  it('修订保留entry身份和seq，拒绝并发覆盖与错误工具id', () => {
    const area = new MessageArea(services())
    const entry = area.append({ role: 'user', content: [{ type: 'tool_result', tool_call_id: 'call', content: '等待确认' }] }, { persistencePolicy: 'commit_on_interruption' })
    const revision = area.revision
    expect(() => area.resolveToolResult(entry.entryId, '完成', 'other')).toThrow('唯一匹配')
    const resumed = area.resolveToolResult(entry.entryId, { status: 'success' }, 'call')
    expect(resumed.entryId).toBe(entry.entryId); expect(resumed.sequence).toBe(entry.sequence)
    expect(resumed.message.content).toEqual([{ type: 'tool_result', tool_call_id: 'call', content: '{"status":"success"}' }])
    expect(() => area.reviseEntry(entry.entryId, user('过期'), revision)).toThrow('revision')
  })
  it('相同baseline不推进revision，缩窗保留已持久消息身份与batch', () => {
    const area = new MessageArea(services())
    area.configureRequest([user('冻结前缀')])
    area.setDynamicTail([user('本轮动态尾部')])
    const first = area.append(user('a'), { source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: 'db-1' })
    area.append(user('b'))
    area.replaceBaseline(area.messages, area.revision); expect(area.revision).toBe(2)
    area.replaceBaseline([user('a')], area.revision)
    expect(area.entries[0]!.entryId).toBe(first.entryId)
    expect(area.requestPrefix).toEqual([user('冻结前缀')])
    expect(area.dynamicTail).toEqual([user('本轮动态尾部')])
    expect(area.persistenceDelta('success').userAnchorSequence).toBe(0)
  })
  it.each(['areaRevision', 'areaDigest', 'entryCount', 'prefixDigest', 'modelIdentity'] as const)('投影精确校验%s，拒绝陈旧wire', field => {
    const area = new MessageArea(services(), [user('历史')]); area.configureRequest([user('前缀')])
    const projection: OpaqueProviderProjection<CanonicalMessage[]> = { ...area.identity('model-a'), wire: area.messages, dynamicTailSize: 0 }
    expect(area.matchesProjection(projection, 'model-a')).toBe(true)
    const invalid = { ...projection, [field]: typeof projection[field] === 'number' ? Number(projection[field]) + 1 : 'invalid' }
    expect(area.matchesProjection(invalid, 'model-a')).toBe(false)
    expect(() => area.project({ project: () => invalid }, 'model-a')).toThrow('身份')
  })
})
