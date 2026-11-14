import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { Block,CanonicalMessage,HistoryReaderPort,PersistedHistoryRow,PreparationPorts,PrepareContextInput } from "../../../../src/agent/harness/index.js"
import { buildRunRagContext,canonicalToolRound,compactContext,formatAttachmentReferences,formatGroupMessage,formatHistoricalText,inlineMessageTime,limitImageBlocks,loadSessionHistory,normalizeHistoryMessage,prepareContext,protectedMessageIds,renderCanonicalEvents,restoreHistoryMessage,selectImageSnapshots,selectSessionHistory,stableJson } from "../../../../src/agent/harness/index.js"
const identity = { ownerId: 'owner', sessionId: 'session' }
const user = (content: string): CanonicalMessage => ({ role: 'user', content })
function row(id: number, extra: Partial<PersistedHistoryRow> = {}): PersistedHistoryRow {
  return { ...identity, id: String(id), conversationSeq: id, role: 'user', content: `消息${id}`, ...extra }
}
function ports(): PreparationPorts {
  let id = 0
  return {
    nextId: () => `entry-${++id}`, digest: value => createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16),
    buildRag: async () => ({ tail: [user('合成检索')] })
  }
}
describe('历史加载的水位、所有权与顺序', () => {
  it('连续继续与三次相同失败回复完整恢复，成功和失败工具结果各一次，当前输入只追加一次', async () => {
    const fallback = '这轮没有接住请求，请换种说法。'
    const rows = [row(1, { content: '创建事件和笔记' }),
      row(2, { role: 'assistant', contentJson: [{ type: 'tool_call', id: 'event-call', name: 'create_event', arguments: { title: '合成事件' } }] }),
      row(3, { contentJson: [{ type: 'tool_result', tool_call_id: 'event-call', content: '{"ok":true}' }] }),
      row(4, { role: 'assistant', contentJson: [{ type: 'tool_call', id: 'note-call', name: 'note_create', arguments: { title: '合成笔记' } }] }),
      row(5, { contentJson: [{ type: 'tool_result', tool_call_id: 'note-call', content: '{"error":"合成失败"}', is_error: true }] }),
      row(6, { role: 'assistant', content: fallback }), row(7, { content: '继续' }),
      row(8, { role: 'assistant', content: fallback }), row(9, { content: '继续' }),
      row(10, { role: 'assistant', content: fallback }), row(11, { content: '换句话说明后继续' })]
    const prepared = await prepareContext({ ...identity, fixedPrefix: [], history: rows, preparedRag: { tail: [] },
      currentUser: { persistedMessageId: '11', message: user('换句话说明后继续') } }, ports())
    const messages = prepared.area.messages
    const text = (message: CanonicalMessage) => typeof message.content === 'string' ? message.content
      : (message.content as Block[]).filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(messages.filter(message => message.role === 'assistant' && text(message) === fallback)).toHaveLength(3)
    expect(messages.filter(message => typeof message.content === 'string' && message.content.endsWith('【消息正文】\n继续'))).toHaveLength(2)
    expect(messages.filter(message => typeof message.content === 'string' && message.content.endsWith('换句话说明后继续'))).toHaveLength(1)
    const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content as Block[] : [])
    expect(blocks.filter(block => block.type === 'tool_call').map(block => block.id)).toEqual(['event-call', 'note-call'])
    expect(blocks.filter(block => block.type === 'tool_result').map(block => block.tool_call_id)).toEqual(['event-call', 'note-call'])
    expect(blocks.find(block => block.type === 'tool_result' && block.tool_call_id === 'note-call')).toMatchObject({ is_error: true, content: '{"error":"合成失败"}' })
    expect(prepared.area.persistenceDelta('success').entries).toEqual([])
  })
  it('早期历史不进入新RAG持久增量，RAG锚定本轮用户而非旧历史', async () => {
    const prepared = await prepareContext({ ...identity, fixedPrefix: [], history: [row(1), row(2)],
      preparedRag: { tail: [user('本轮RAG')] }, currentUser: { persistedMessageId: '3', message: user('本轮问题') } }, ports())
    expect(prepared.area.entries.map(entry => entry.source)).toEqual(['restored_history', 'restored_history', 'rag', 'user'])
    const delta = prepared.area.persistenceDelta('success')
    expect(delta.entries.map(entry => entry.message.content)).toEqual(['本轮RAG'])
    expect(delta.userAnchorSequence).toBe(prepared.area.entries.at(-1)!.sequence)
    expect(delta.userAnchorSequence).toBeGreaterThan(prepared.area.entries[1]!.sequence)
  })
  it.each(['image', 'input_audio', 'video'].flatMap(type => [false, true].map(reference => ({ type, reference }))))('当前媒体与可选引用保留在请求但不重复持久化：%j', async ({ type, reference }) => {
    const media: Block = { type, source: { type: 'base64', data: 'synthetic-media' } }
    const content: Block[] = [...(reference ? [{ type: 'knowledge-context', scope: 'explicit-reference', text: '用户引用' }] : []), { type: 'text', text: '查看附件' }, media]
    const prepared = await prepareContext({ ...identity, fixedPrefix: [], history: [], preparedRag: { tail: [] },
      currentUser: { persistedMessageId: '1', message: { role: 'user', content } } }, ports())
    const blocks = prepared.area.messages.flatMap(message => Array.isArray(message.content) ? message.content as Block[] : [])
    expect(blocks.filter(block => block.type === type)).toEqual([media])
    expect(stableJson(blocks)).toContain('查看附件')
    expect(blocks.some(block => block.type === 'knowledge-context')).toBe(reference)
    expect(prepared.area.persistenceDelta('success').entries).toEqual([])
    expect(content.at(-1)).toEqual(media)
  })
  it('两成员批次带各自quote/附件/时间，下一Run按原始owned rows恢复相同顺序与Provider前缀', async () => {
    const port = ports(), members = [{ id: 'member-a', name: '小北', body: '第一条问题', quote: '第一条引用', time: '10:01' },
    { id: 'member-b', name: '小南', body: '第二条问题', quote: '第二条引用', time: '10:02' }]
    const files = members.map((_, index): Block[] => [{ type: 'attachment_ref', attach_id: `file-${index + 1}`, kind: 'text', name: `合成附件${index + 1}`, ext: 'txt' }])
    const currentUsers = members.map((member, index) => ({
      rawText: member.body, persistedMessageId: String(index + 1), messageTime: member.time,
      message: user(formatGroupMessage({
        body: member.body, senderId: member.id, senderName: member.name, quote: member.quote,
        attachmentIds: files[index]!.map(file => String(file.attach_id)), attachmentContext: formatAttachmentReferences(files[index]!)
      }))
    }))
    const first = await prepareContext({ ...identity, groupChat: true, fixedPrefix: [], history: [], currentUsers, preparedRag: { tail: [] } }, port)
    const rows = members.map((member, index) => row(index + 1, {
      content: member.body, chatType: 'group', senderId: member.id, senderName: member.name,
      quote: member.quote, files: files[index], createdAt: `2026-08-25T00:0${index + 1}:00Z`
    }))
    port.formatMessageTime = timestamp => String(timestamp).includes('00:01') ? '10:01' : '10:02'
    const next = await prepareContext({ ...identity, groupChat: true, userTimezone: 'Asia/Shanghai', fixedPrefix: [], history: rows, preparedRag: { tail: [] } }, port)
    expect(renderCanonicalEvents(next.area.messages).map(message => ({ role: message.role, content: message.content })))
      .toEqual(renderCanonicalEvents(first.area.messages).map(message => ({ role: message.role, content: message.content })))
    expect(first.area.entries.map(entry => entry.persistedMessageId)).toEqual(['1', '2'])
    expect(next.area.entries.map(entry => entry.persistedMessageId)).toEqual(['1', '2'])
  })
  it('Canonical知识/技能事件不切断真实用户时间边界，也不向事件复制用户时间封套', async () => {
    const port = ports(), calls: unknown[] = [], timestamp = '2026-08-25T00:26:00Z'
    port.formatMessageTime = (value, timezone) => { calls.push([value, timezone]); return '2026-08-25 08:26' }
    const knowledge: Block = { type: 'knowledge-context', scope: 'owner-rag', text: '合成近期天气', content_hash: 'rag-1' }
    const skill: Block = { type: 'skill-schema', skill_name: 'weather', tools: ['http_get'] }
    const prepared = await prepareContext({
      ...identity, fixedPrefix: [], userTimezone: 'Asia/Shanghai', preparedRag: { tail: [] }, history: [
        row(1, { content: '今天天气如何', sentAt: timestamp }), row(2, { contentJson: [knowledge], createdAt: timestamp }),
        row(3, { contentJson: [skill], createdAt: timestamp }), row(4, { content: '好潮湿' }),
      ]
    }, port)
    expect(prepared.area.messages.map(message => message.role)).toEqual(['user', 'user', 'user', 'user'])
    expect(prepared.area.messages.map(message => message.content)).toEqual(['【消息时间】2026-08-25 08:26\n【消息正文】\n今天天气如何', [knowledge], [skill], '【消息正文】\n好潮湿'])
    expect(calls).toEqual([[timestamp, 'Asia/Shanghai']])
  })
  it('保留窗口以完整batch计数：keep2只保留最后两单元，超过单位数量则保留全部', () => {
    const rows = [row(1), row(2, { canonicalBatchId: 'tool-round', role: 'assistant', contentJson: [{ type: 'tool_call', id: 'a', name: 'read', arguments: {} }] }),
    row(3, { canonicalBatchId: 'tool-round', contentJson: [{ type: 'tool_result', tool_call_id: 'a', content: '结果' }] }), row(4), row(5)]
    expect([...protectedMessageIds(rows, 2)]).toEqual(['4', '5'])
    expect([...protectedMessageIds(rows, 3)]).toEqual(['2', '3', '4', '5'])
    expect([...protectedMessageIds(rows, 10)]).toEqual(['1', '2', '3', '4', '5'])
  })
  it('一轮RAG/引用/工具结果模拟持久回放为下一Run前缀，独立消息边界不漂移且动态tail不回放', async () => {
    const port = ports(), first = await prepareContext({
      ...identity, fixedPrefix: [], history: [], preparedRag: {
        tail: [
          { role: 'user', content: [{ type: 'knowledge-context', text: '检索知识', scope: 'rag' }] },
          { role: 'user', content: [{ type: 'tool-schema', tool_name: 'read', schema: { name: 'read' } }] },
        ]
      }, currentUser: { message: { role: 'user', content: [{ type: 'knowledge-context', scope: 'explicit-reference', text: '用户引用' }, { type: 'text', text: '当前问题' }] } },
      extraReminder: '本次动态tail'
    }, port)
    const toolRound = canonicalToolRound({ text: '读取', calls: [{ id: 'a', name: 'read', input: {} }], dispatched: [{ callId: 'a', toolName: 'read', content: '读取结果' }] })
    first.area.appendBatch(toolRound.map(message => ({ message, source: 'tool_round', persistencePolicy: 'commit_on_success' })))
    first.area.append({ role: 'assistant', content: '最终回复' }, { source: 'agent_followup', persistencePolicy: 'commit_on_success' })
    const rows = first.area.entries.map((entry, index): PersistedHistoryRow => row(index + 1, {
      role: entry.message.role, source: entry.source,
      ...(typeof entry.message.content === 'string' ? { content: entry.message.content } : { contentJson: entry.message.content })
    }))
    const next = await prepareContext({ ...identity, fixedPrefix: [], history: rows, preparedRag: { tail: [] }, currentUser: { message: user('下一Run问题') } }, port)
    const comparable = (messages: CanonicalMessage[]) => renderCanonicalEvents(messages).map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    }))
    expect(comparable(next.area.messages.slice(0, first.area.messages.length))).toEqual(comparable(first.area.messages))
    expect(next.area.messages).toHaveLength(first.area.messages.length + 1); expect(next.area.dynamicTail).toEqual([])
    expect(stableJson(next.area.messages)).not.toContain('本次动态tail')
    expect(first.area.messages[0]!.content).toEqual([{ type: 'knowledge-context', text: '检索知识', scope: 'rag' }])
    expect(stableJson(next.area.messages.slice(0, 2))).not.toContain('【消息正文】')
    const current = next.area.messages[2]!.content as Block[]
    expect(current.findIndex(block => block.type === 'knowledge-context')).toBeLessThan(current.findIndex(block => block.type === 'text' && block.text === '当前问题'))
  })
  it('inline压缩摘要与下一Run正式summary恢复有相同Provider前缀和最近完整尾部', async () => {
    const port = ports(), first = await prepareContext({ ...identity, fixedPrefix: [], history: Array.from({ length: 12 }, (_, index) => row(index + 1)), preparedRag: { tail: [] } }, port)
    const candidate = await compactContext(first.area, { summarize: async () => '保留旧决定' }, { modelIdentity: 'model' })
    expect(candidate.changed).toBe(true)
    const rows = candidate.messages.map((message, index): PersistedHistoryRow => row(index + 1, index === 0
      ? { role: 'summary', content: '保留旧决定' }
      : { role: message.role, content: typeof message.content === 'string' ? message.content : '', contentJson: Array.isArray(message.content) ? message.content : null }))
    const next = await prepareContext({ ...identity, fixedPrefix: [], history: rows, preparedRag: { tail: [] } }, port)
    const text = (message: CanonicalMessage) => typeof message.content === 'string' ? message.content : (message.content as Block[]).map(block => block.text).join('\n')
    expect(next.area.messages.map(text)).toEqual(candidate.messages.map(text))
    expect(next.area.messages.map(message => message.role)).toEqual(candidate.messages.map(message => message.role))
  })
  it('恢复历史在未知块文本化之前移除私有推理，不能以source_type包装泄漏', () => {
    const restored = restoreHistoryMessage(row(1, {
      role: 'assistant', contentJson: [{ type: 'redacted_thinking', data: 'private-data' },
      { type: 'thinking', thinking: 'private-thinking' }, { type: 'reasoning_content', text: 'private-reasoning' }, { type: 'text', text: '可见回复' }]
    }))
    expect(stableJson(restored)).not.toContain('private-')
    expect(restored.content).toEqual([{ type: 'text', text: '可见回复' }])
  })
  it('已查看工具结果嵌套媒体递归变占位，避免旧base64回放；原始行不被修改', () => {
    const original = row(1, {
      role: 'tool', contentJson: [{
        type: 'tool_result', tool_call_id: 'a', content: [{ type: 'text', text: '结果' },
        { type: 'image', source: { type: 'base64', data: 'private-large-media' } }, { nested: { type: 'image_url', image_url: { url: 'data:image/png;base64,large' } } }]
      }]
    })
    const restored = restoreHistoryMessage(original)
    expect(stableJson(restored)).not.toContain('base64'); expect(stableJson(restored)).not.toContain('private-large-media')
    expect(stableJson(restored)).toContain('[图片已查看]'); expect(stableJson(original)).toContain('private-large-media')
  })
  it('图片/文件附件引用走各自回读通道，voice不重复注入，均不含媒体载荷', () => {
    const refs = formatAttachmentReferences([{ type: 'attachment_ref', attach_id: 'image', kind: 'image', name: '合成图' },
    { type: 'attachment_ref', attach_id: 'file', kind: 'binary', name: '合成表', ext: 'xlsx' }, { type: 'attachment_ref', attach_id: 'voice', kind: 'voice' }])
    expect(refs).toContain('read_file(items='); expect(refs).toContain('save_uploaded_file'); expect(refs).toContain('合成表.xlsx')
    expect(refs).not.toContain('attach_id=voice'); expect(refs).not.toContain('base64')
    expect(refs.slice(0, refs.indexOf('save_uploaded_file'))).not.toContain('attach_id=file')
  })
  it('群sender/quote/附件属于模型上下文分区，不改数据库原文，不注入runtime权限', () => {
    const envelope = normalizeHistoryMessage({ role: 'user', content: '继续', quoted_text: '合成引用', platform_user_id: 'member', platform_user_name: '小北', files: [{ attach_id: 'file', kind: 'text', ext: 'md' }] })
    const original = structuredClone(envelope), rendered = formatHistoricalText(envelope, true)
    expect(rendered).toContain('平台 ID：member\n显示名：小北\n【消息正文】\n继续')
    expect(rendered).toContain('【引用消息】\n合成引用'); expect(rendered).toContain('【附件 ID】\nfile')
    expect(envelope).toEqual(original)
    const privateText = formatHistoricalText(envelope, false)
    expect(privateText).toContain('💬 用户引用/回复了一条历史消息'); expect(privateText).not.toContain('【发言人元数据】')
  })
  it.each([[0, 5, 5], [3, 5, 5], [7, 5, 7], [5, 0, 5]])('baseline=%i与summary覆盖=%i取有效水位%i', (baseline, covers, expected) => {
    const rows = [row(20, { role: 'summary', content: '摘要', coversUntilSeq: covers }), ...Array.from({ length: 10 }, (_, index) => row(index + 1))]
    const selected = selectSessionHistory(identity, rows, baseline)
    expect(selected.effectiveBaselineSeq).toBe(expected)
    expect(selected.rows[0]!.role).toBe('summary')
    expect(selected.rows.slice(1).every(item => item.conversationSeq > expected)).toBe(true)
  })
  it('连续正文无100/500条上限，不恢复尚未消费的早落库用户', () => {
    const rows = Array.from({ length: 601 }, (_, index) => row(index + 1))
    rows.push(row(602, { runId: 'im-pending:synthetic' }))
    expect(selectSessionHistory(identity, rows, 0).rows).toHaveLength(601)
  })
  it('平台时间优先于先持久化的助手输出，同毫秒anchor前缀在原始行前', () => {
    const rows = [row(1, { role: 'assistant', platformSentMs: 3000 }), row(2, { platformSentMs: 2000 }),
    row(3, { platformSentMs: 2000, historyAnchorSeq: 2 })]
    expect(selectSessionHistory(identity, rows, 0).rows.map(item => item.id)).toEqual(['3', '2', '1'])
  })
  it('微秒事件顺序保留，消息正文不参与排序', () => {
    const rows = [row(1, { createdAt: '2026-11-13T00:00:00.000002Z' }), row(2, { createdAt: '2026-11-13T00:00:00.000001Z' })]
    expect(selectSessionHistory(identity, rows, 0).rows.map(item => item.id)).toEqual(['2', '1'])
  })
  it.each([{ ownerId: 'foreign' }, { sessionId: 'foreign' }])('拒绝Reader返回跨归属行%j', extra => {
    expect(() => selectSessionHistory(identity, [row(1, extra)], 0)).toThrow('归属')
  })
  it('引用恢复不得改变消息id或边界，取消在装载后阻止继续使用', async () => {
    await expect(loadSessionHistory(identity, {
      read: async () => ({ baselineSeq: 0, rows: [row(1)] }),
      hydrateReferences: async () => [row(2)]
    })).rejects.toThrow('边界')
    const cancel = new AbortController()
    await expect(loadSessionHistory(identity, { read: async () => { cancel.abort(); return { baselineSeq: 0, rows: [row(1)] } } }, cancel.signal)).rejects.toThrow()
  })
  it('引用hydrate中取消即使返回合法行也不能成功返回；图片sizes取消后不再读取payload', async () => {
    const referenceCancel = new AbortController()
    await expect(loadSessionHistory(identity, {
      read: async () => ({ baselineSeq: 0, rows: [row(1)] }),
      hydrateReferences: async (_, rows) => { referenceCancel.abort(new Error('合成引用取消')); return [...rows] }
    }, referenceCancel.signal)).rejects.toThrow('合成引用取消')
    const imageCancel = new AbortController(); let payloadReads = 0
    await expect(loadSessionHistory(identity, {
      read: async () => ({ baselineSeq: 0, rows: [row(1)] }), images: {
        readSizes: async () => { imageCancel.abort(new Error('合成图片取消')); return new Map([['1', 10]]) },
        readPayloads: async () => { payloadReads++; return new Map() },
      }
    }, imageCancel.signal, { loadImages: true })).rejects.toThrow('合成图片取消')
    expect(payloadReads).toBe(0)
  })
  it('最新run只保护最后十完整round，尾部无run身份时不钉住旧run', () => {
    const rows = Array.from({ length: 15 }, (_, index) => row(index + 1, { runId: 'run-a', roundId: `round-${index + 1}` }))
    expect([...protectedMessageIds(rows)]).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 6)))
    rows.push(row(16))
    expect([...protectedMessageIds(rows)]).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 7)))
  })
  it('legacy完整batch不在十单元保留窗口边界被拆开', () => {
    const rows = [row(1, { canonicalBatchId: 'pair' }), row(2, { canonicalBatchId: 'pair' }),
    ...Array.from({ length: 9 }, (_, index) => row(index + 3))]
    expect(protectedMessageIds(rows).size).toBe(11)
  })
  it('图片最近48用户消息、8MiB字节及12块预算分别约束', () => {
    const rows = Array.from({ length: 60 }, (_, index) => row(index + 1))
    const sizes = new Map(rows.map(item => [item.id, 1024]))
    sizes.set('60', 9 * 1024 * 1024)
    const selected = selectImageSnapshots(rows, sizes)
    expect(selected.ids).toHaveLength(12); expect(selected.ids[0]).toBe('59')
    const images = Array.from({ length: 15 }, () => ({ type: 'image', source: 'synthetic' }))
    const limited = limitImageBlocks(new Map([['59', images], ['58', images]]), selected.ids)
    expect(limited.get('59')).toHaveLength(12); expect(limited.has('58')).toBe(false)
    expect(selectImageSnapshots(rows, new Map([['1', 1]])).ids).toEqual([])
  })
  it('多图按最新消息优先共享块数和总字节预算，正文不受影响', () => {
    const rows = [row(1), row(2), row(3)]
    const size = 3 * 1024 * 1024
    const selected = selectImageSnapshots(rows, new Map([['1', size], ['2', size], ['3', size]]))
    expect(selected.ids).toEqual(['3', '2']); expect(selected.bytes).toBe(2 * size)
    const five = Array.from({ length: 5 }, (_, index) => ({ type: 'image', source: String(index) }))
    const limited = limitImageBlocks(new Map([['1', five], ['2', five], ['3', five]]), ['3', '2', '1'])
    expect([limited.get('1')!.length, limited.get('2')!.length, limited.get('3')!.length]).toEqual([2, 5, 5])
    expect(rows.map(item => item.content)).toEqual(['消息1', '消息2', '消息3'])
  })
  it('主历史读取二阶段只查48候选及12消息，主prepare保留首发完整媒体封套不重复时间/引用', async () => {
    const rows = Array.from({ length: 60 }, (_, index) => row(index + 1)), calls: string[][] = []
    const payload: Block[] = [{ type: 'text', text: '【消息时间】首发时间\n【消息正文】\n首发引用和正文' }, ...Array.from({ length: 15 }, () => ({ type: 'image', source: { type: 'base64', data: 'synthetic-image' } }))]
    const reader: HistoryReaderPort = {
      read: async () => ({ baselineSeq: 0, rows }), images: {
        readSizes: async (owner, ids) => { expect(owner).toEqual(identity); calls.push([...ids]); return new Map(ids.map(id => [id, id === '60' ? 9 * 1024 * 1024 : 1024])) },
        readPayloads: async (owner, ids) => { expect(owner).toEqual(identity); calls.push([...ids]); return new Map(ids.map(id => [id, id === '59' ? payload : []])) },
      }
    }
    const loaded = await loadSessionHistory(identity, reader, undefined, { loadImages: true })
    expect(calls[0]).toHaveLength(48); expect(calls[0]![0]).toBe('60'); expect(calls[0]!.at(-1)).toBe('13')
    expect(calls[1]).toHaveLength(12); expect(calls[1]![0]).toBe('59')
    expect(loaded.rows.filter(value => value.providerImageContent)).toHaveLength(1)
    const prepared = await prepareContext({ ...identity, history: loaded.rows, fixedPrefix: [], allowHistoricalImages: true }, ports())
    expect(prepared.area.messages.find(message => message._history_id === '59')!.content).toEqual(payload.slice(0, 13))
    expect(rows[58]!.providerImageContent).toBeUndefined()
  })
  it('图片能力关闭不读BLOB；开启却未注入端口、返回范围外payload必须明确拒绝', async () => {
    let imageReads = 0
    const reader: HistoryReaderPort = {
      read: async () => ({ baselineSeq: 0, rows: [row(1)] }), images: {
        readSizes: async () => { imageReads++; return new Map([['1', 10]]) },
        readPayloads: async () => new Map([['foreign', [{ type: 'image', source: 'forbidden' }]]]),
      }
    }
    await loadSessionHistory(identity, reader); expect(imageReads).toBe(0)
    await expect(loadSessionHistory(identity, { read: reader.read }, undefined, { loadImages: true })).rejects.toThrow('端口')
    await expect(loadSessionHistory(identity, reader, undefined, { loadImages: true })).rejects.toThrow('未授权')
  })
})
describe('统一当前轮组装', () => {
  it('主准备链恢复本地化历史时间/quote/附件/group sender，Provider只需转换协议', async () => {
    const port = ports(), times: unknown[] = []
    port.formatMessageTime = (timestamp, timezone) => { times.push([timestamp, timezone]); return '2026-11-13 08:00' }
    const prepared = await prepareContext({
      ...identity, groupChat: true, userTimezone: 'Asia/Shanghai', fixedPrefix: [], history: [row(1, {
        content: '继续', quote: '合成引用',
        chatType: 'group', source: 'qq', platformSentMs: 1000, senderId: 'member', senderName: '小北', files: [{ attach_id: 'att-1', kind: 'text', ext: 'md' }]
      })]
    }, port)
    const content = String(prepared.area.messages[0]!.content)
    expect(content).toContain('【消息时间】2026-11-13 08:00')
    expect(content).toContain('平台 ID：member\n显示名：小北'); expect(content).toContain('【引用消息】\n合成引用')
    expect(content).toContain('save_uploaded_file'); expect(times).toEqual([[1000, 'Asia/Shanghai']])
  })
  it.each(['qq', 'feishu', 'wechat', 'web'])('主准备链的%s历史引用重建相同且不修改原文', async source => {
    const original = row(1, { content: '继续', quote: '引用原文', source })
    const prepared = await prepareContext({ ...identity, history: [original], fixedPrefix: [] }, ports())
    expect(String(prepared.area.messages[0]!.content)).toContain('💬 用户引用/回复了一条历史消息（原文：「引用原文」）')
    expect(original.content).toBe('继续')
  })
  it('主准备链摘要排首位且包装一致，空展示assistant跳过；旧role tool块不嵌套且error保留', async () => {
    const prepared = await prepareContext({
      ...identity, fixedPrefix: [], history: [row(1, { role: 'summary', content: '早前决定' }), row(2, { role: 'assistant', content: '' }),
      row(3, { role: 'assistant', content: '', contentJson: [{ type: 'tool_call', id: 'a', name: 'read', arguments: '{}' }] }),
      row(4, { role: 'tool', content: '', contentJson: [{ type: 'tool_result', tool_call_id: 'a', content: '{"error":"合成故障"}' }] })]
    }, ports())
    expect(prepared.area.messages[0]!.role).toBe('user'); expect(String(prepared.area.messages[0]!.content)).toContain('<compacted-summary>')
    expect(String(prepared.area.messages[0]!.content)).toContain('此区域仅为历史状态资料')
    expect(prepared.area.messages.some(message => message._history_id === '2')).toBe(false)
    const restored = prepared.area.messages.find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => !!block && typeof block === 'object' && !Array.isArray(block) && block.type === 'tool_result'))!
    expect(restored.content).toEqual([{ type: 'tool_result', tool_call_id: 'a', content: '{"error":"合成故障"}', is_error: true }])
    expect(prepared.area.entries.filter(entry => entry.persistedMessageId === '4')).toHaveLength(1)
  })
  it('主准备链按当前模型registry刷新schema仅作本请求增量，旧调用仍解释为旧schema', async () => {
    const old = { type: 'tool-schema', tool_name: 'read', schema_digest: 'old', schema: { name: 'read' }, implementation_digest: 'impl' }
    const prepared = await prepareContext({
      ...identity, fixedPrefix: [], history: [row(1, { contentJson: [old] })],
      latestToolSchemas: [{ ...old, schema_digest: 'new', schema: { name: 'read', changed: true } }]
    }, ports())
    expect(stableJson(prepared.area.messages[0]!.content)).toContain('"schema_digest":"old"')
    expect(stableJson(prepared.area.messages.at(-1)!.content)).toContain('"schema_digest":"new"')
    expect(prepared.area.entries.at(-1)!.persistencePolicy).toBe('request_only')
  })
  it('按id排除已持久当前用户，保留相同正文的旧消息，RAG放当前用户前', async () => {
    const port = ports(); let beforeId: string | null = null, historyIds: string[] = []
    port.buildRag = async input => { beforeId = input.beforeMessageId; historyIds = input.history.map(item => item.id); return { tail: [user('RAG')] } }
    const prepared = await prepareContext({
      ...identity, history: [row(1, { content: '相同' }), row(2, { content: '相同' })],
      fixedPrefix: [], currentUser: { message: user('相同'), persistedMessageId: '2' }, extraReminder: '请求提醒'
    }, port)
    expect(beforeId).toBe('2'); expect(historyIds).toEqual(['1'])
    expect(prepared.area.messages.map(item => item.content)).toEqual(['【消息正文】\n相同', 'RAG', '【消息正文】\n相同'])
    expect(prepared.area.persistenceDelta('success').entries.map(item => item.message)).toEqual([user('RAG')])
    expect(prepared.area.dynamicTail).toEqual([user('[system-reminder]\n请求提醒\n[/system-reminder]')])
  })
  it('RAG主链以本轮真实query召回，不把历史/引用/工具结果/时间/动态补充替代用户原文', async () => {
    const port = ports(), seen: { query: string; beforeMessageId: string | null; ids: string[] }[] = []
    port.buildRag = async input => { seen.push({ query: input.query, beforeMessageId: input.beforeMessageId, ids: input.history.map(item => item.id) }); return { tail: [user('RAG输出不回流query')] } }
    const input: PrepareContextInput = {
      ...identity, fixedPrefix: [user('系统前缀')], history: [row(1, { content: '历史正文' }), row(2, { content: '已持久当前正文' })],
      currentUser: {
        persistedMessageId: '2', rawText: '  当前真实问题？\n保留换行  ', messageTime: '10:20', message: {
          role: 'user', content: [
            { type: 'knowledge-context', text: '引用文档' }, { type: 'runtime-context', text: '运行补充' }, { type: 'tool_result', tool_call_id: 'a', content: '工具结果' },
            { type: 'text', text: '渲染后正文' }, { type: 'image', source: '当前图片' }]
        }
      }, extraReminder: '动态补充', snapshotText: '快照检索上下文'
    }
    await prepareContext(input, port)
    await prepareContext({ ...input, query: '' }, port)
    expect(seen).toEqual([{ query: '  当前真实问题？\n保留换行  ', beforeMessageId: '2', ids: ['1'] }, { query: '', beforeMessageId: '2', ids: ['1'] }])
  })
  it('群batch查询只取真实text且不重复单条入口，相同正文的独立消息均保留', async () => {
    const port = ports(); let query = ''
    port.buildRag = async input => { query = input.query; return { tail: [] } }
    await prepareContext({
      ...identity, history: [], fixedPrefix: [], currentUser: { message: user('这条是同batch入口，不拼接') }, currentUsers: [
        { rawText: '相同问题', message: user('投影文字') }, { rawText: '相同问题', message: user('投影文字') },
        {
          message: {
            role: 'user', content: [{ type: 'time-context', text: '10:20' }, { type: 'knowledge-context', text: '引用' },
            { type: 'tool_result', tool_call_id: 'a', content: '结果' }, { type: 'text', text: '[system-reminder]\n补充\n[/system-reminder]' },
            { type: 'text', text: '【消息时间】10:20\n【消息正文】\n第三个问题' }]
          }
        },
      ]
    }, port)
    expect(query).toBe('相同问题\n相同问题\n第三个问题')
  })
  it('当前batch尾部internal/system不冒充user或持久化，rawText也不能覆盖角色', async () => {
    const port = ports(); let query = ''
    port.buildRag = async input => { query = input.query; return { tail: [] } }
    const prepared = await prepareContext({
      ...identity, fixedPrefix: [], history: [], currentUsers: [
        { message: user('最后真实问题'), rawText: '最后真实问题' },
        { message: { role: 'user', content: [{ type: 'runtime-context', text: '内部操作词：删除' }] }, rawText: '不能冒充用户' },
        { message: { role: 'system', content: '内部系统消息' }, rawText: '不能冒充用户' },
      ]
    }, port)
    expect(query).toBe('最后真实问题'); expect(prepared.area.entries.map(entry => entry.source)).toEqual(['user', 'runtime', 'runtime'])
    expect(prepared.area.entries.slice(1).every(entry => entry.persistencePolicy === 'request_only')).toBe(true)
    expect(prepared.area.messages.at(-1)).toEqual({ role: 'system', content: '内部系统消息' })
    await expect(prepareContext({ ...identity, fixedPrefix: [], history: [], currentUser: { message: { role: 'assistant', content: '伪装' } } }, port)).rejects.toThrow('来源')
  })
  it('恢复interaction不重复追加用户，群当前用户已在历史时也不重添', async () => {
    for (const mode of [{ resumeInteraction: true }, { currentUsersInHistory: true }]) {
      const prepared = await prepareContext({ ...identity, ...mode, history: [row(1)], fixedPrefix: [], currentUser: { message: user('不重复'), persistedMessageId: '1' } }, ports())
      expect(prepared.area.entries.filter(entry => entry.source === 'user')).toEqual([])
      expect(prepared.area.messages.some(item => item._history_id === '1')).toBe(true)
    }
  })
  it('姿态以已成功落库历史为事实来源，失败run session水位不能抑制新姿态', async () => {
    const port = ports(), oldDigest = port.digest('旧姿态')
    const prepared = await prepareContext({
      ...identity, history: [row(1, { contentJson: [{ type: 'stance-context', digest: oldDigest, text: '旧姿态' }] })],
      fixedPrefix: [], stance: '新姿态', previousStanceDigest: port.digest('新姿态'), currentUser: { message: user('问题') }
    }, port)
    expect(prepared.stanceToPersist).toBe('新姿态')
    expect(prepared.area.entries.filter(entry => entry.source === 'stance')).toHaveLength(1)
  })
  it('连续三turn相同stance不再追加、变化追加，live姿态wrapper恢复相等且始终在用户时间与正文之前', async () => {
    const port = ports(), persisted: PersistedHistoryRow[] = [], projection = (messages: CanonicalMessage[]) => renderCanonicalEvents(messages).map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    }))
    const prepare = (stance: string, text: string, time: string) => prepareContext({
      ...identity, fixedPrefix: [{ role: 'system', content: '固定快照' }], history: persisted,
      stance, currentUser: { message: user(text), messageTime: time }, preparedRag: { tail: [] }
    }, port)
    const persistNew = (prepared: Awaited<ReturnType<typeof prepare>>) => {
      for (const entry of prepared.area.entries.filter(entry => entry.source !== 'restored_history')) persisted.push(row(persisted.length + 1,
        { role: entry.message.role, source: entry.source, ...(typeof entry.message.content === 'string' ? { content: entry.message.content } : { contentJson: entry.message.content }) }))
    }
    const first = await prepare('执行', '一', '10:01')
    expect(first.area.entries.map(entry => entry.source)).toEqual(['stance', 'user'])
    expect(first.area.messages[0]!.content).toEqual([{ type: 'stance-context', digest: port.digest('执行'), text: '[system-reminder]\n执行\n[/system-reminder]' }])
    expect(first.area.messages[1]!.content).toBe('【消息时间】10:01\n【消息正文】\n一')
    expect(first.stanceToPersist).toBe('执行'); persistNew(first)
    const second = await prepare('执行', '二', '10:02')
    expect(second.area.entries.filter(entry => entry.source === 'stance')).toEqual([]); expect(second.stanceToPersist).toBeNull()
    expect(projection(second.area.messages.slice(0, 2))).toEqual(projection(first.area.messages)); persistNew(second)
    const third = await prepare('记录', '三', '10:03')
    expect(projection(third.area.messages.slice(0, 3))).toEqual(projection(second.area.messages))
    expect(third.area.entries.slice(-2).map(entry => entry.source)).toEqual(['stance', 'user']); expect(third.stanceToPersist).toBe('记录')
    expect(third.area.messages.at(-2)!.content).toEqual([{ type: 'stance-context', digest: port.digest('记录'), text: '[system-reminder]\n记录\n[/system-reminder]' }])
    expect(third.area.messages.at(-1)!.content).toBe('【消息时间】10:03\n【消息正文】\n三')
    expect(stableJson(third.area.messages)).toContain('执行')
  })
  it('preparedRag主prepare直接使用已召回结果，不二次召回且保持stance→RAG→用户时间正文顺序', async () => {
    const port = ports(); let recalls = 0
    port.buildRag = async () => { recalls++; throw new Error('已准备RAG不能重新召回') }
    const rag = { tail: [{ role: 'user', content: [{ type: 'knowledge-context', scope: 'owner-rag', text: '已召回知识' }] }] } as { tail: CanonicalMessage[] }
    const prepared = await prepareContext({ ...identity, fixedPrefix: [], history: [], preparedRag: rag, stance: '执行', currentUser: { message: user('问题'), messageTime: '10:20' } }, port)
    expect(recalls).toBe(0); expect(prepared.area.entries.map(entry => entry.source)).toEqual(['stance', 'rag', 'user'])
    expect(prepared.area.messages[1]!.content).toEqual(rag.tail[0]!.content)
    expect(prepared.area.messages[2]!.content).toBe('【消息时间】10:20\n【消息正文】\n问题')
    await prepareContext({ ...identity, fixedPrefix: [], history: [], preparedRag: { tail: [] }, currentUser: { message: user('空召回也不能重查') } }, port)
    expect(recalls).toBe(0)
  })
  it.each([{}, { resumeInteraction: true }, { currentUsersInHistory: true }])('共享RAG入口与主prepare在%j复用相同有效历史/query/水位，预召回后不重查', async mode => {
    const port = ports(), seen: unknown[] = [], input: PrepareContextInput = {
      ...identity, ...mode, fixedPrefix: [], query: '真实query',
      history: [row(1), row(2, { contentJson: [{ type: 'time-context', text: 'legacy独立时间' }] }), row(3)],
      currentUser: { persistedMessageId: '3', message: user('当前用户') }, snapshotText: '真实快照'
    }
    port.buildRag = async request => { seen.push({ query: request.query, before: request.beforeMessageId, ids: request.history.map(item => item.id), snapshot: request.snapshotText }); return { tail: [user('召回')] } }
    const preparedRag = await buildRunRagContext(input, port)
    await prepareContext({ ...input, preparedRag }, port)
    expect(seen).toEqual([{
      query: '真实query', before: 'resumeInteraction' in mode ? null : '3',
      ids: 'resumeInteraction' in mode || 'currentUsersInHistory' in mode ? ['1', '3'] : ['1'], snapshot: '真实快照'
    }])
  })
  it('共享RAG入口在外部IO前验证历史归属，preparedRag复用也不能绕过归属或取消', async () => {
    const port = ports(); let calls = 0
    port.buildRag = async () => { calls++; return { tail: [] } }
    const input: PrepareContextInput = { ...identity, fixedPrefix: [], history: [row(1, { ownerId: 'foreign' })], preparedRag: { tail: [] } }
    await expect(buildRunRagContext(input, port)).rejects.toThrow()
    await expect(buildRunRagContext({ ...input, preparedRag: undefined }, port)).rejects.toThrow()
    const controller = new AbortController(); controller.abort()
    await expect(buildRunRagContext({ ...input, history: [] }, port, controller.signal)).rejects.toThrow()
    const secondController = new AbortController()
    port.buildRag = async () => { calls++; secondController.abort(); return { tail: [] } }
    await expect(buildRunRagContext({ ...input, history: [], preparedRag: undefined }, port, secondController.signal)).rejects.toThrow()
    expect(calls).toBe(1)
  })
  it('独立legacy时间行过滤，混合canonical事件和真实用户保留', async () => {
    const prepared = await prepareContext({
      ...identity, history: [row(1, { contentJson: [{ type: 'time-context', text: '旧时间' }] }),
      row(2, { contentJson: [{ type: 'time-context', text: '时间' }, { type: 'text', text: '正文' }] })], fixedPrefix: []
    }, ports())
    expect(prepared.area.messages.flatMap(item => item._history_id ?? [])).toEqual(['2'])
  })
  it('批量群用户原序、各自消息时间，引用和附件entry保留来源', async () => {
    const prepared = await prepareContext({
      ...identity, history: [], fixedPrefix: [], currentUsers: [
        { message: { role: 'user', content: [{ type: 'knowledge-context', scope: 'explicit-reference', text: '引用' }] }, persistedMessageId: '1', messageTime: '10:01' },
        { message: { role: 'user', content: [{ type: 'image', source: 'request-only' }] }, persistedMessageId: '2', messageTime: '10:02' },
      ]
    }, ports())
    expect(prepared.area.entries.slice(-2).map(entry => entry.source)).toEqual(['reference', 'attachment'])
    expect(prepared.area.persistenceDelta('success').entries.every(entry => entry.source === 'rag')).toBe(true)
    expect(prepared.area.persistenceDelta('success').userAnchorSequence).toBe(2)
  })
  it('时间封套不重复正文标签，已包装text block只前插时间', () => {
    expect(inlineMessageTime('【消息正文】\n原文', '10:00')).toBe('【消息时间】10:00\n【消息正文】\n原文')
    expect(inlineMessageTime([{ type: 'text', text: '【消息正文】\n原文' }], null)).toEqual([{ type: 'text', text: '【消息正文】\n原文' }])
  })
})
