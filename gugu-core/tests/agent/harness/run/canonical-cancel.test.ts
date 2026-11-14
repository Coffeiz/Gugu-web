import { createHash } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { Executor } from "../../../../src/agent/executor/executor.js"
import type { CanonicalContextPorts,CanonicalHarnessContext,CanonicalMessage,HarnessPorts,Lease,PersistedHistoryRow,PersistenceDelta,RunCheckpoint,RunEvent,RunIdentity,RunStore } from "../../../../src/agent/harness/index.js"
import { blocks,createCanonicalHarness,HarnessError,loadSessionHistory,restorePreparedContext,stableJson } from "../../../../src/agent/harness/index.js"

const identity: RunIdentity = { ownerId: 'owner-synthetic', sessionId: 'session-synthetic', runId: 'first-run' }
const call = { id: 'completed-call', name: 'synthetic_lookup', input: { query: '合成查询' } }

describe('真实Canonical取消收尾与下一Run回放', () => {
  it('工具完成后取消保留完整pair和部分正文，压缩候选不推进baseline，下一Run按历史顺序恢复', async () => {
    let entryId = 0
    const services = {
      nextId: () => `entry-${++entryId}`,
      digest: (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
    }
    const prefix: CanonicalMessage[] = [{ role: 'system', content: '合成固定规则' }]
    const accessScopeHash = services.digest({ ownerId: identity.ownerId, sessionId: identity.sessionId, access: 'owner' })
    let baselineSeq = 0
    let sequence = 3
    const rows: PersistedHistoryRow[] = [
      { ...identity, id: 'history-1', conversationSeq: 1, role: 'user', content: '先前问题' },
      { ...identity, id: 'history-2', conversationSeq: 2, role: 'assistant', content: '先前回答' },
      { ...identity, id: 'first-user', conversationSeq: 3, role: 'user', content: '执行本轮查询' },
    ]
    const contextPorts: CanonicalContextPorts = {
      ...services,
      references: { dehydrate: async (entry) => structuredClone(entry.message), hydrate: async (entry) => structuredClone(entry.message) },
      finalization: { complete: vi.fn(async () => undefined) },
      load: async (id) => {
        const loaded = await loadSessionHistory(id, { read: async () => ({ baselineSeq, rows: structuredClone(rows) }) })
        const first = id.runId === identity.runId
        return {
          modelIdentity: 'synthetic-model', contextWindow: 100, accessScopeHash,
          capabilities: { toolNames: ['synthetic_lookup'], tools: [{ name: 'synthetic_lookup', schema: { type: 'object' } }] },
          input: {
            ...id, fixedPrefix: prefix, history: loaded.rows,
            currentUser: { persistedMessageId: first ? 'first-user' : 'next-user', message: { role: 'user', content: first ? '执行本轮查询' : '继续处理' } }
          }
        }
      },
      preparation: { ...services, buildRag: async () => ({ tail: [] }) },
      prepareRequest: async () => ({ prefix, dynamicTail: [] }),
      compaction: { summarize: vi.fn(async () => '合成压缩候选') },
      currentRequest: (_id, input) => ({
        sourceCheckpointDigest: input.checkpointDigest, accessScopeHash: input.accessScopeHash,
        area: input.materialized.area.snapshot(), requestPrefix: input.materialized.area.requestPrefix,
        dynamicTail: input.materialized.area.dynamicTail, systemPrompt: '合成固定规则', tools: [],
        projection: { ...input.materialized.area.identity(input.modelIdentity), dynamicTailSize: 0, wire: { synthetic: true } }
      }),
      stageContinuation: async () => 'synthetic-continuation', releaseContinuations: vi.fn(async () => undefined),
      diagnoseCompactionFailure: vi.fn(),
    }
    const restore = (context: CanonicalHarnessContext) => restorePreparedContext(context.prepared, context.identity,
      { ...services, prepareRequest: () => contextPorts.prepareRequest(context.identity) }, contextPorts.references)
    const checkpoints = new Map<string, RunCheckpoint<CanonicalHarnessContext>>()
    const outbox = new Map<string, RunEvent>()
    const leases = new Map<string, Lease>()
    const markers = new Set<string>()
    const listeners = new Map<string, () => void>()
    const histories: { outcome: string; text: string; delta: PersistenceDelta }[] = []
    const appliedCompactions: string[] = []
    const nextRequests: CanonicalMessage[][] = []
    const key = (id: RunIdentity) => stableJson([id.ownerId, id.sessionId, id.runId])
    let fence = 0
    // 测试Data端口按真实delta物化合成行；它不代表SQL事务、加密或分布式lease的生产验收。
    const store: RunStore<CanonicalHarnessContext> = {
      read: async (id) => structuredClone(checkpoints.get(key(id)) ?? null),
      create: async (checkpoint, lease, events) => {
        expect(checkpoints.has(key(checkpoint.identity))).toBe(false)
        expect(leases.get(checkpoint.identity.sessionId)?.fence).toBe(lease.fence)
        checkpoints.set(key(checkpoint.identity), structuredClone(checkpoint))
        events.forEach((event) => outbox.set(event.id, event))
      },
      commit: async (change) => {
        expect(change.expectedVersion).toBe(checkpoints.get(key(change.identity))?.version)
        expect(leases.get(change.identity.sessionId)?.fence).toBe(change.lease.fence)
        let persisted: { outcome: string; text: string; delta: PersistenceDelta } | null = null
        if (change.history && change.history.outcome !== 'silent') {
          const prepared = await restore(change.history.context)
          persisted = {
            outcome: change.history.outcome, text: change.history.text,
            delta: prepared.area.persistenceDelta(change.history.outcome === 'success' ? 'success' : 'interruption')
          }
        }
        checkpoints.set(key(change.identity), structuredClone(change.checkpoint))
        change.events.forEach((event) => outbox.set(event.id, event))
        if (persisted) {
          histories.push(persisted)
          for (const entry of persisted.delta.entries) rows.push({
            ownerId: change.identity.ownerId, sessionId: change.identity.sessionId,
            id: `stored-${++sequence}`, conversationSeq: sequence, runId: change.identity.runId,
            roundId: entry.roundId, canonicalBatchId: entry.batchId, role: entry.message.role,
            content: '', contentJson: structuredClone(entry.message.content)
          })
          if (persisted.text) rows.push({
            ownerId: change.identity.ownerId, sessionId: change.identity.sessionId,
            id: `display-${++sequence}`, conversationSeq: sequence, runId: change.identity.runId, role: 'assistant',
            content: persisted.text + (persisted.outcome === 'interruption' ? '\n\n[本轮已中止，以上内容未完成]' : '')
          })
          if (persisted.outcome === 'success') {
            for (const item of change.history!.context.compactions) appliedCompactions.push(item.id)
            if (change.history!.context.compactions.length) baselineSeq = 2
          }
        }
      },
      pendingEvents: async (id) => [...outbox.values()].filter((event) => key(event.identity) === key(id)),
      acknowledgeEvents: async (_id, ids) => { ids.forEach((id) => outbox.delete(id)) },
    }
    const runtime: Omit<HarnessPorts<CanonicalHarnessContext>, 'context' | 'execution' | 'reply'> = {
      clock: { now: () => '2026-01-01T00:00:00.000Z' }, store,
      leases: {
        acquire: async (id) => {
          if (leases.has(id.sessionId)) return null
          const lease = { token: `synthetic-lease-${++fence}`, fence }
          leases.set(id.sessionId, lease); return lease
        },
        assert: async (id, lease) => { if (leases.get(id.sessionId)?.fence !== lease.fence) throw new HarnessError('lease_lost', '合成租约失效') },
        release: async (id, lease) => { if (leases.get(id.sessionId)?.fence === lease.fence) leases.delete(id.sessionId) },
      },
      cancellation: {
        isRequested: async (id) => markers.has(key(id)), request: async (id) => { markers.add(key(id)) },
        notify: async (id) => { listeners.get(key(id))?.() },
        subscribe: async (id, listener) => { listeners.set(key(id), listener); return () => { listeners.delete(key(id)) } },
      },
      provider: {
        stream: vi.fn<HarnessPorts<CanonicalHarnessContext>['provider']['stream']>(async function* (request) {
          if (request.identity.runId !== identity.runId) {
            nextRequests.push((await restore(request.context)).area.messages)
            yield { type: 'complete', text: '继续完成', calls: [] }; return
          }
          if (request.round === 1) {
            yield { type: 'usage', usage: { input: 20, output: 1, cacheRead: 65, cacheWrite: 0, contextInput: 85 } }
            yield { type: 'token', text: '执行前说明' }
            yield { type: 'complete', text: '执行前说明', calls: [call] }; return
          }
          yield { type: 'token', text: '尚未完成的分析' }
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve()
            else request.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        })
      },
      tools: {
        dispatch: vi.fn(async () => ({ kind: 'completed' as const, value: { ok: true, source: 'synthetic' }, successful: true, mutated: false })),
        reconcile: async () => ({ kind: 'unknown' })
      },
      interactions: { activate: async (_id, pending) => pending },
      sanitizeText: (text) => text, createStreamSanitizer: () => ({ feed: (text) => text, flush: () => '' }),
      presentError: () => ({ code: 'synthetic_failure', text: '合成失败' }), presentToolResult: async (value) => value,
      diagnose: vi.fn(), publish: vi.fn(async (event) => {
        if (event.type === 'final' && event.identity.runId === identity.runId) expect(histories.at(-1)?.outcome).toBe('interruption')
      }),
    }
    const makeHarness = () => createCanonicalHarness({
      context: contextPorts, runtime,
      executor: { executor: new Executor([]), authorize: async () => { throw new Error('此测试不应请求原生执行') } }
    })
    const harness = makeHarness()
    const source = harness.start(identity)
    const events: RunEvent[] = []
    while (true) {
      const next = await source.next()
      if (next.done) throw new Error('取消前不应先终结')
      events.push(next.value)
      if (next.value.type === 'token' && next.value.payload.text === '尚未完成的分析') break
    }
    expect(await harness.cancel(identity)).toBe(true)
    for await (const event of source) events.push(event)
    const cancelled = checkpoints.get(key(identity))!
    expect(cancelled).toMatchObject({ status: 'cancelled', completedToolCount: 1, text: '尚未完成的分析' })
    expect(cancelled.context!.compactions).toHaveLength(1)
    expect(contextPorts.compaction.summarize).toHaveBeenCalledOnce()
    expect(histories).toHaveLength(1)
    expect(histories[0]!.outcome).toBe('interruption')
    const delta = histories[0]!.delta
    expect(delta.batches).toHaveLength(1)
    expect(delta.entries.map((entry) => entry.message.role)).toEqual(['assistant', 'user'])
    expect(delta.batches[0]!.entries).toHaveLength(2)
    const [assistant, result] = delta.entries.map((entry) => entry.message)
    expect(blocks(assistant!.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: '执行前说明' }), expect.objectContaining({ type: 'tool_call', id: call.id }),
    ]))
    expect(blocks(result!.content)).toEqual([expect.objectContaining({ type: 'tool_result', tool_call_id: call.id, content: JSON.stringify({ ok: true, source: 'synthetic' }) })])
    expect(histories[0]!.text).toBe('尚未完成的分析')
    expect(events.at(-1)?.payload).toMatchObject({ status: 'cancelled', text: '' })
    expect(contextPorts.finalization.complete).not.toHaveBeenCalled()
    expect(appliedCompactions).toEqual([])
    expect(baselineSeq).toBe(0)
    expect(rows.filter((row) => row.role === 'summary')).toEqual([])
    expect(leases.size).toBe(0)

    const nextIdentity = { ...identity, runId: 'next-run' }
    rows.push({ ...nextIdentity, id: 'next-user', conversationSeq: ++sequence, role: 'user', content: '继续处理' })
    for await (const _event of makeHarness().start(nextIdentity)) { /* 下一Run实际准备及模型轮次。 */ }
    expect(nextRequests).toHaveLength(1)
    const messages = nextRequests[0]!
    const text = stableJson(messages)
    expect(text.indexOf('先前问题')).toBeLessThan(text.indexOf('先前回答'))
    expect(text.indexOf('先前回答')).toBeLessThan(text.indexOf('执行本轮查询'))
    expect(text.indexOf('执行本轮查询')).toBeLessThan(text.indexOf('tool_call'))
    expect(text.indexOf('tool_call')).toBeLessThan(text.indexOf('tool_result'))
    expect(text.indexOf('tool_result')).toBeLessThan(text.indexOf('尚未完成的分析'))
    expect(text.indexOf('尚未完成的分析')).toBeLessThan(text.indexOf('继续处理'))
    expect(text).toContain('[本轮已中止，以上内容未完成]')
    expect(text).not.toContain('合成压缩候选')
    expect(messages.flatMap((message) => blocks(message.content)).filter((block) => block.type === 'tool_call')).toHaveLength(1)
    expect(messages.flatMap((message) => blocks(message.content)).filter((block) => block.type === 'tool_result')).toHaveLength(1)
    expect(runtime.tools.dispatch).toHaveBeenCalledOnce()
    expect(runtime.provider.stream).toHaveBeenCalledTimes(3)
    expect(contextPorts.finalization.complete).toHaveBeenCalledOnce()
  })
})
