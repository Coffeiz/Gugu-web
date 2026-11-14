import { vi } from 'vitest'
import type {
HarnessPorts,Lease,ProviderEvent,
ReplyFacts,
RunCheckpoint,RunEvent,RunIdentity,
RunStore,
ToolResult
} from "../../../../src/agent/harness/index.js"
import { createRunHarness,HarnessError } from "../../../../src/agent/harness/index.js"

/** 多职责行为套件共享的明确fake adapter，不注册任何测试。 */
export type Context = readonly string[]

export type MutablePorts = { -readonly [K in keyof HarnessPorts<Context>]: HarnessPorts<Context>[K] }

export const identity: RunIdentity = { ownerId: 'owner-synthetic', sessionId: 'session-synthetic', runId: 'run-synthetic' }

export const usage = { input: 3, output: 2, cacheRead: 5, cacheWrite: 1, contextInput: 9 }

export const toolCall = { id: 'call-synthetic', name: 'lookup', input: { query: '合成输入' } }

export const replyFacts: ReplyFacts = { empty: false, narration: false, announcesIntent: false, endsWithColon: false, toolProgressOnly: false, requiresTools: false, decisionDodge: false, decisionGuardEnabled: true, prompts: { narration: '合成叙述提醒', intent: '合成意图提醒', colon: '合成冒号提醒', tools: '合成工具提醒', decision: '合成决策提醒' }, emptyFallback: '合成空回复文案' }

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function* stream(events: readonly ProviderEvent[]) { yield* events }

export async function collect<C>(source: AsyncGenerator<RunEvent, RunCheckpoint<C>>) {
  const events: RunEvent[] = []
  while (true) {
    const next = await source.next()
    if (next.done) return { events, state: next.value }
    events.push(next.value)
  }
}

export function fixture(rounds: readonly (readonly ProviderEvent[])[] = [[{ type: 'token', text: '合成回复' }, { type: 'usage', usage }, { type: 'complete', text: '合成回复', calls: [] }]]) {
  const records = new Map<string, RunCheckpoint<Context>>()
  const outbox = new Map<string, RunEvent>()
  const histories: { outcome: string; context: Context; text: string }[] = []
  const order: string[] = []
  const markers = new Set<string>()
  const listeners = new Map<string, () => void>()
  const leases = new Map<string, Lease>()
  const receipts = new Set<string>()
  let nextFence = 0
  let call = 0
  const idKey = (id: RunIdentity) => JSON.stringify([id.ownerId, id.sessionId, id.runId])
  const ports: MutablePorts = {
    clock: { now: () => '2026-01-01T00:00:00Z' },
    store: {
      read: vi.fn(async (id) => records.get(idKey(id)) ?? null),
      create: vi.fn<RunStore<Context>['create']>(async (state, lease, events) => {
        const k = idKey(state.identity)
        if (records.has(k) || leases.get(k)?.fence !== lease.fence) throw new Error('合成冲突')
        records.set(k, structuredClone(state))
        events.forEach((event) => outbox.set(event.id, event))
      }),
      commit: vi.fn<RunStore<Context>['commit']>(async (change) => {
        const k = idKey(change.identity)
        if (records.get(k)?.version !== change.expectedVersion || leases.get(k)?.fence !== change.lease.fence) throw new Error('合成冲突')
        if (change.interactionReceipt && receipts.has(change.interactionReceipt)) throw new Error('合成重复收据')
        // 所有验证先完成，再一起提交，模拟一个事务。
        records.set(k, structuredClone(change.checkpoint))
        change.events.forEach((event) => outbox.set(event.id, event))
        if (change.interactionReceipt) receipts.add(change.interactionReceipt)
        if (change.history) { histories.push(change.history); order.push('history') }
      }),
      pendingEvents: vi.fn(async (id) => [...outbox.values()].filter((event) => idKey(event.identity) === idKey(id)).sort((a, b) => a.sequence - b.sequence)),
      acknowledgeEvents: vi.fn<RunStore<Context>['acknowledgeEvents']>(async (_id, ids) => { ids.forEach((eventId) => outbox.delete(eventId)) }),
    },
    leases: {
      acquire: vi.fn(async (id) => {
        const k = idKey(id)
        if (leases.has(k)) return null
        const lease = { token: `lease-${++nextFence}`, fence: nextFence }
        leases.set(k, lease)
        return lease
      }),
      assert: vi.fn(async (id, lease) => {
        if (leases.get(idKey(id))?.fence !== lease.fence) throw new HarnessError('lease_lost', '租约失效')
      }),
      release: vi.fn(async (id, lease) => {
        if (leases.get(idKey(id))?.fence === lease.fence) leases.delete(idKey(id))
      }),
    },
    cancellation: {
      isRequested: vi.fn(async (id) => markers.has(idKey(id))),
      request: vi.fn(async (id) => { markers.add(idKey(id)); order.push('cancel_marker') }),
      notify: vi.fn(async (id) => { order.push('cancel_notify'); listeners.get(idKey(id))?.() }),
      subscribe: vi.fn(async (id, listener) => { listeners.set(idKey(id), listener); return () => { listeners.delete(idKey(id)) } }),
    },
    provider: { stream: vi.fn(() => stream(rounds[call++] ?? [{ type: 'complete', text: '', calls: [] }])) },
    context: {
      assertIdentity: (id, context) => { if (context[0] !== idKey(id)) throw new HarnessError('not_found', '运行不存在') },
      checkpointToolResult: vi.fn(async (_scope, result) => result),
      restoreToolResult: vi.fn(async (_scope, result) => result),
      prepare: vi.fn(async (id) => [idKey(id), 'prepared']),
      afterRound: vi.fn<HarnessPorts<Context>['context']['afterRound']>(async (context, result) => [...context, `assistant:${result.text}`, ...result.calls.map((item) => `call:${item.id}`)]),
      afterTool: vi.fn(async (context, item, result) => result.kind === 'completed' && result.executed === false ? context : [...context, `tool:${item.id}:${result.kind}`]),
      resumeInteraction: vi.fn(async (context, pending) => [...context, `answer:${pending.id}`]),
      recoverOverflow: vi.fn(async (context) => ({ context, applied: false })),
      afterUsage: vi.fn(async (context) => ({ context, applied: false })),
      appendReminder: vi.fn(async (context, prompt) => [...context, `reminder:${prompt}`]),
    },
    tools: {
      dispatch: vi.fn(async (): Promise<ToolResult> => ({ kind: 'completed', value: '合成结果', successful: true, mutated: false })),
      reconcile: vi.fn(async (): Promise<ToolResult> => ({ kind: 'unknown' })),
    },
    interactions: { activate: vi.fn(async (_id, request) => request) },
    execution: { execute: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })) },
    reply: { evaluate: vi.fn(async () => 'accept' as const) },
    sanitizeText: (text) => text,
    createStreamSanitizer: () => ({ feed: (text) => text, flush: () => '' }),
    presentError: () => ({ code: 'upstream_failed', text: '上游暂时不可用' }),
    presentToolResult: async (value) => value,
    publish: vi.fn(async (event) => { order.push(`publish:${event.type}`) }),
    diagnose: vi.fn(),
  }
  return { ports, records, histories, outbox, order, markers, leases, receipts, idKey, harness: createRunHarness(ports) }
}
