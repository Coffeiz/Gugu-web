import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { projectAgentRunEvent } from '../../../src/agent/run/event-projection.js'
import { createCanonicalRunner } from '../../../src/agent/runner.js'
import type { createSubagentService } from '../../../src/agent/subagent/service.js'
import { createSearcherReferenceShell } from '../../../src/agent/subagent/searcher/references.js'
import { createDelegatedAgentHarness } from '../../../src/agent/subagent/runner.js'
import { searcherPreset } from '../../../src/agent/subagent/searcher/context.js'
import { createSubagentServiceTools } from '../../../src/agent/tools/subagent/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { AgentRunnerPorts, ToolPort } from '../../../src/agent/ports.js'
import type { CanonicalRunContext, ProviderEvent, RunIdentity, ToolCall } from '../../../src/agent/models.js'
import { collect, fixture, identity } from '../run/fixtures.js'

type Ports = Parameters<typeof createCanonicalRunner>[0]
const events = (text: string, calls: ToolCall[] = []): ProviderEvent[] => [
  ...(text ? [{ type: 'token' as const, text }] : []),
  { type: 'complete', text, calls },
]

function runtime(tools: ToolPort, provider: Ports['runtime']['provider'],
  definitions: Ports['context']['load']): Ports {
  const fake = fixture()
  let nextId = 0
  return {
    context: {
      digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      nextId: () => String(++nextId), load: definitions,
      preparation: { buildRag: async () => ({ tail: [] }) },
      references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
      async prepareRequest() { return { prefix: [], dynamicTail: [] } },
      currentRequest: () => null,
      stageContinuation: async () => { throw new Error('意外的模型续接') }, releaseContinuations: async () => {},
      compaction: { summarize: async () => '' },
      finalization: { complete: async () => {} },
      diagnoseCompactionFailure() {},
    },
    executor: { authorize: async () => { throw new Error('未授权原生工具') }, executor: { execute: async () => { throw new Error('未配置原生工具') } } },
    runtime: { ...fake.ports as unknown as AgentRunnerPorts<CanonicalRunContext>, provider, tools },
  }
}

it('Searcher 可以在第九轮后正常交付结果', async () => {
  const rounds: number[] = []
  const options = runtime({
    async dispatch() { return { kind: 'completed', successful: true, mutated: false, value: '合成证据' } },
    async reconcile() { return { kind: 'unknown' } },
  }, {
    async *stream({ round }) {
      rounds.push(round)
      yield* (round < 10
        ? events('', [{ id: '搜索-' + round, name: 'web_search', input: { query: '合成资料 ' + round } }])
        : events('已核对全部合成资料'))
    },
  }, async candidate => ({
    modelIdentity: '合成模型', contextWindow: 100_000, accessScopeHash: '合成授权',
    input: { ...candidate, fixedPrefix: [], history: [] },
    capabilities: { toolNames: ['web_search'], tools: [{ name: 'web_search', schema: {} }] },
  }))
  const child = { ...identity, sessionId: '2', runId: '多轮子运行' }
  const traces: unknown[] = []
  options.runtime.observation = { record(event) { traces.push(event.attributes?.subagent_trace) } }
  const harness = createDelegatedAgentHarness(searcherPreset,
    { parent: identity, identity: child, childId: 'aabbccdd', modelIdentity: '合成模型', input: { task: '执行十轮合成检查' } }, options)
  expect((await collect(harness.start(child))).state).toMatchObject({ status: 'completed', text: '已核对全部合成资料' })
  expect(rounds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(traces).toContainEqual({
    agent_id: 'builtin:searcher', child_id: 'aabbccdd',
    parent_session_id: identity.sessionId, parent_run_id: identity.runId,
  })
})

it('显式委派的 Shell 只处理单个文件引用', async () => {
  const refs: string[] = []
  const shell = createSearcherReferenceShell(async ref => {
    refs.push(ref)
    return { kind: 'completed', successful: true, mutated: false, value: { stdout: '合成证据' } }
  })
  const registry = createToolRegistry({ confirmationGatedDestructiveTools: [shell], authorize: async () => true })
  const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
    async execute() { throw new Error('委派引用不应调用命令解释器') } }
  for (const input of [{ command: 'cat -- 41; pwd' }, { command: 'cat -- ../41' },
    { command: 'cat -- 41', cwd: '..' }, { command: 'cat -- 41', scope: 'system' }]) {
    expect(await registry.tools.dispatch({ id: 'denied', name: 'shell', input }, scope))
      .toMatchObject({ kind: 'completed', successful: false })
  }
  const result = await registry.tools.dispatch({ id: 'allowed', name: 'shell', input: { command: 'cat -- 41' } }, scope)
  expect(result).toMatchObject({ kind: 'completed', successful: true, value: { stdout: '合成证据' } })
  expect(refs).toEqual(['41'])
})

it.each([
  ['confirmed', false],
  ['confirmed', true],
  ['cancelled', false],
] as const)('将 Shell 确认交给父会话，并在原子 Run 消费 %s 回执（重启=%s）', async (status, restart) => {
  const toolName = 'shell'
  const parent = identity
  const child = { ...parent, sessionId: '2', runId: '合成子运行' }
  const call = { id: '合成操作', name: toolName, input: {} }
  const modelIdentity = '合成模型'
  const persisted = fixture()
  let effects = 0
  const modelRounds: number[] = []
  const options = runtime({
    async dispatch(toolCall, scope) {
      expect(scope.identity).toEqual(child)
      if (!scope.resolution) return { kind: 'waiting', interaction: { id: '合成确认', kind: 'confirmation', toolCall } }
      expect(scope.resolution.receiptId).toBe('合成回执')
      effects++
      return { kind: 'completed', successful: true, mutated: false, value: '操作已完成' }
    },
    async reconcile() { return { kind: 'unknown' } },
  }, {
    async *stream({ round }) {
      modelRounds.push(round)
      yield* (round === 1 ? events('', [call]) : events('合成结果'))
    },
  }, async candidate => ({
    modelIdentity, contextWindow: 8000, accessScopeHash: '合成授权',
    input: { ...candidate, fixedPrefix: [], history: [] },
    capabilities: { toolNames: [toolName], tools: [{ name: toolName, schema: {} }] },
  }))
  const launch = { parent, identity: child, modelIdentity, input: { task: '合成操作' } }
  const reconstruct = () => createDelegatedAgentHarness(searcherPreset, launch, {
    ...options,
    runtime: { ...options.runtime, store: persisted.ports.store as unknown as Ports['runtime']['store'], leases: persisted.ports.leases },
  })
  const initial = reconstruct()
  const { state: waiting } = await collect(initial.start(child))
  expect(waiting.status).toBe('waiting')
  expect(waiting.pending?.toolCall).toEqual(call)
  expect(persisted.leases.size).toBe(0)
  expect(effects).toBe(0)
  const resumed = restart ? reconstruct() : initial
  const { state: outcome } = await collect(resumed.resume(child,
    { interactionId: '合成确认', receiptId: '合成回执', status, value: null }))
  expect(outcome.status).toBe('completed')
  if (status === 'confirmed') expect(outcome.text).toBe('合成结果')
  expect(modelRounds).toEqual(status === 'confirmed' ? [1, 2] : [1])
  expect(effects).toBe(status === 'confirmed' ? 1 : 0)
  expect(persisted.receipts.has('合成回执')).toBe(true)
})

const unexpected = async (): Promise<never> => { throw new Error('测试必须从普通 Runner 的工具端口执行') }
const toolContracts: ReturnType<typeof createSubagentService> = {
  start: unexpected, send: unexpected, sendToParent: unexpected, wait: unexpected, waitInbox: unexpected,
  inspect: unexpected, cancel: unexpected, cancelChildren: unexpected, catalog: unexpected,
}

it('父 Run 未调用 wait，子 Agent 的 final 仍在下一次模型调用前一次性交付', async () => {
  const finalMessage = '主动送达的子任务最终结论'
  const childId = 'a9ff0001'
  const received: string[] = []
  let ready = false
  const definitions = createSubagentServiceTools(toolContracts).filter(item => item.definition.name === 'agent_message')
  const tool = definitions[0]!
  const registry = createToolRegistry({ tools: [{
    ...tool,
    async execute() {
      return { kind: 'completed', successful: true, mutated: false, value: { action: 'spawn', run: { childId, status: 'queued' } } }
    },
  }], authorize: async () => true })
  const texts: string[] = []
  const options = runtime(registry.tools, {
    async *stream({ round, context }) {
      texts.push(JSON.stringify(context.prepared.area.entries))
      if (round === 1) yield* events('', [{ id: 'start', name: 'agent_message',
        input: { action: 'spawn', agentId: 'builtin:searcher', task: '合成研究' } }])
      else if (round === 2) {
        ready = true
        yield* events('等待子任务的初步回答。')
      } else yield* events('已经汇总子任务结果。')
    },
  }, async candidate => {
    const tools = await registry.capabilities(candidate)
    return { modelIdentity: '合成模型', contextWindow: 8000, accessScopeHash: '合成授权',
      input: { ...candidate, fixedPrefix: [], history: [], currentUser: { message: { role: 'user', content: '合成问题' } } },
      capabilities: { tools, toolNames: tools.map(item => item.name) } }
  })
  const baseStore = options.runtime.store
  const harness = createCanonicalRunner({
    ...options, runtime: { ...options.runtime, store: {
      ...baseStore,
      async readSubagentFinals() {
        return ready && received.length === 0 ? [{ childId, status: 'completed', finalMessage }] : []
      },
      async commit(change) {
        if (change.subagentFinalIds?.length) {
          expect(change.checkpoint.phase).toBe('provider')
          expect(JSON.stringify(change.checkpoint.context?.prepared.area.entries)).toContain(finalMessage)
          expect(change.checkpoint.displayTimeline).toContainEqual(expect.objectContaining({
            toolName: 'subagent_result', toolResult: { childId, status: 'completed', finalMessage },
          }))
        }
        await baseStore.commit(change)
        received.push(...change.subagentFinalIds ?? [])
      },
    } },
  })
  const completed = await collect(harness.start(identity))
  expect(completed.state.status).toBe('completed')
  const projected = (await Promise.all(completed.events.map(event =>
    projectAgentRunEvent(event, { async interaction() { throw new Error('不应产生交互') } }),
  ))).flat()
  expect(projected).toContainEqual(expect.objectContaining({
    type: 'display_event', item: expect.objectContaining({
      toolName: 'subagent_result', toolResult: { childId, status: 'completed', finalMessage },
    }),
  }))
  expect(received).toEqual([childId])
  expect(texts).toHaveLength(3)
  expect(texts[1]).not.toContain(finalMessage)
  expect(texts[2]?.split(finalMessage)).toHaveLength(2)
})

it.each(['指定子终态', '空参数收件箱'] as const)('父 Run 等待 %s 时释放租约，结果就绪后续跑一次', async mode => {
  const any = mode === '空参数收件箱'
  const childId = '01234567'
  const finalMessage = '合成持久等待结果'
  let ready = false
  let waitCalls = 0
  const consumed: string[] = []
  // 旧 checkpoint 仍可能包含 agent_wait，使用合成旧工具验证恢复兼容。
  const definitions = createSubagentServiceTools(toolContracts).filter(item => ['agent_message', 'agent_inbox'].includes(item.definition.name))
    .map(item => item.definition.name === 'agent_inbox' ? { ...item, requiresInteraction: true,
      definition: { name: 'agent_wait', schema: { type: 'function', function: {
        name: 'agent_wait', parameters: { type: 'object', properties: { childId: { type: 'string' } } },
      } } }, validate: (input: unknown) => ({ success: true as const, data: input }) } : item)
  const registry = createToolRegistry({ tools: definitions.map(tool => ({
    ...tool,
    async execute() {
      if (tool.definition.name === 'agent_wait') waitCalls++
      return { kind: 'completed', successful: true, mutated: false,
        value: tool.definition.name === 'agent_wait' ? (any ? { finals: [{ childId, status: 'completed' }] } : { childId, status: 'completed', finalMessage }) :
          { action: 'spawn', run: { childId, status: 'queued' } } }
    },
  })), authorize: async () => true })
  const options = runtime(registry.tools, {
    async *stream({ round, context }) {
      if (round === 1) yield* events('', [{ id: 'start', name: 'agent_message',
        input: { action: 'spawn', agentId: 'builtin:searcher', task: '合成研究' } }])
      else if (round === 2) yield* events('', [{ id: 'wait', name: 'agent_wait', input: any ? {} : { childId } }])
      else {
        expect(JSON.stringify(context.prepared.area.entries).split(finalMessage)).toHaveLength(2)
        yield* events('已收到子任务结果')
      }
    },
  }, async candidate => {
    const tools = await registry.capabilities(candidate)
    return { modelIdentity: '合成模型', contextWindow: 8000, accessScopeHash: '合成授权',
      input: { ...candidate, fixedPrefix: [], history: [] },
      capabilities: { tools, toolNames: tools.map(item => item.name) } }
  })
  const store = options.runtime.store
  const binding = { ...options, runtime: { ...options.runtime, store: {
    ...store,
    async readAgentInbox() { return [] },
    async isSubagentPending(_id: RunIdentity, child: string) { return child === childId && !ready },
    async readSubagentFinals() { return ready && !consumed.length ? [{ childId, status: 'completed' as const, finalMessage }] : [] },
    async commit(change: Parameters<typeof store.commit>[0]) {
      await store.commit(change)
      consumed.push(...change.subagentFinalIds ?? [])
    },
  } } }
  expect((await collect(createCanonicalRunner(binding).start(identity))).state).toMatchObject({ status: 'waiting', ...(any ? { agentInboxWaiting: true } : { subagentWaitChildId: childId }) })
  const restarted = createCanonicalRunner(binding)
  expect((await collect(restarted.resume(identity))).state.status).toBe('waiting')
  expect(waitCalls).toBe(0)
  ready = true
  expect((await collect(restarted.resume(identity))).state).toMatchObject({ status: 'completed', ...(any ? { agentInboxWaiting: false } : { subagentWaitChildId: null }) })
  expect(waitCalls).toBe(1)
  expect(consumed).toEqual([childId])

  const cancelledParent = { ...identity, runId: '合成取消父运行' }
  ready = false
  expect((await collect(createCanonicalRunner(binding).start(cancelledParent))).state.status).toBe('waiting')
  expect(await restarted.cancel(cancelledParent)).toBe(true)
  ready = true
  expect((await collect(restarted.resume(cancelledParent))).state).toMatchObject({ status: 'cancelled', ...(any ? { agentInboxWaiting: false } : { subagentWaitChildId: null }) })
  expect((await collect(restarted.resume(cancelledParent))).state.status).toBe('cancelled')
  expect(waitCalls).toBe(1)
  expect(consumed).toEqual([childId])
})
