import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { CanonicalContextPorts, CanonicalRunContext, AgentRunnerPorts, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { createCanonicalSourceLoader, stableJson } from '@gugu/core/agent'
import { ProviderError, ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createAgentRuntime } from '@gugu/core/agent'
import { agentContextAccessScope } from '../../src/modules/agent/llm/access.js'
import { bindProviderSelection } from '../../src/modules/agent/llm/bind.js'
import { createAgentCompactionPort } from '@gugu/core/agent'

const identity = { ownerId: 'owner-synthetic', sessionId: '1', runId: 'run-synthetic' }
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

test('Core Agent Runtime 使用 Host 注入端口请求 Provider 并持久化终态', async () => {
  let checkpoint: RunCheckpoint<CanonicalRunContext> | null = null
  const outbox: RunEvent[] = []
  const histories: string[] = []
  const policy = { groupChat: false, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
  const scope = agentContextAccessScope('synthetic-secret', identity, policy, { permissions: '1', model: '1', credentials: '1' }, digest, 'owner')
  const bound = await bindProviderSelection(identity, {
    selectPlatformModel: async () => ({ config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统', byokEnabled: false, localDeployment: false, accessScopeHash: scope.accessScopeHash }),
    readActiveCredential: async () => null, decryptCredential: () => { throw new Error('不应读取凭据') }, defaultBaseUrl: () => '',
  }, new AbortController().signal)
  const source = createCanonicalSourceLoader({ digest, nextId: randomUUID, now: () => 0,
    readSnapshot: async () => ({ ...identity, contextEpoch: 0, context: null, snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }),
    select: async () => ({ ...policy, modelIdentity: bound.modelIdentity, contextWindow: 10000, locale: 'zh-CN', workspaceBinding: null, contextScopeKey: scope.contextScopeKey }),
    currentRevision: async () => 0, historyReader: { read: async () => ({ baselineSeq: 0, rows: [] }) },
    currentTurn: async () => ({ currentUser: { persistedMessageId: '1', message: { role: 'user', content: '你好' } } }),
    data: { loadTimezone: async () => 'UTC', loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [], loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}), loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
    builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '合成快照', sessionInfo: {}, userTimezone: 'UTC' }), buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) },
  })
  const context: CanonicalContextPorts = {
    digest, nextId: randomUUID,
    load: async (id, signal) => ({ ...await source.load(id, signal), capabilities: { toolNames: [], tools: [] } }),
    preparation: { buildRag: async () => ({ tail: [] }) },
    prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
    references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
    compaction: { summarize: async () => { throw new Error('意外压缩') } },
    finalization: { complete: async () => {} }, currentRequest: () => null,
    stageContinuation: async () => { throw new Error('意外续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
  }
  const runtime: AgentRuntimeOptionsRuntime = {
    clock: { now: () => '2026-01-01T00:00:00Z' },
    store: {
      read: async () => checkpoint,
      create: async (value, _lease, events) => { checkpoint = structuredClone(value); outbox.push(...events) },
      commit: async change => { assert.equal(checkpoint?.version, change.expectedVersion); checkpoint = structuredClone(change.checkpoint); outbox.push(...change.events); if (change.history) histories.push(change.history.text) },
      pendingEvents: async () => outbox,
      acknowledgeEvents: async () => {},
    },
    leases: { acquire: async () => ({ token: 'lease', fence: 1 }), assert: async () => {}, release: async () => {} },
    cancellation: { isRequested: async () => false, request: async () => {}, notify: async () => {}, subscribe: async () => () => {} },
    tools: { dispatch: async () => { throw new Error('不应调用工具') }, reconcile: async () => ({ kind: 'unknown' }) },
    interactions: { activate: async (_id, request) => request },
    sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
    presentError: () => ({ code: 'failed', text: '模型不可用' }), presentToolResult: async value => value,
    publish: async () => {}, diagnose: () => {},
  }
  let requests = 0
  assert.throws(() => createAgentRuntime({ context, runtime,
    executor: { authorize: async () => { throw new Error('不应授权进程') }, executor: { execute: async () => { throw new Error('不应执行进程') } } },
    provider: { resolve: bound.resolve },
  }), error => error instanceof ProviderError && error.code === 'unsupported')
  const instance = createAgentRuntime({ context, runtime,
    executor: { authorize: async () => { throw new Error('不应授权进程') }, executor: { execute: async () => { throw new Error('不应执行进程') } } },
    provider: { resolve: bound.resolve, transport: { request: async request => {
      requests++
      const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? request.body as Record<string, unknown> : {}
      if (body.stream !== true) return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: (async function* () { yield new TextEncoder().encode(JSON.stringify({
          choices: [{ message: { content: '合成回复' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })) })(),
        cancel: async () => {},
      }
      return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"合成回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })(), cancel: async () => {} }
    } } },
  })
  const events: RunEvent[] = []
  assert.equal(typeof instance.provider.branchProvider, 'function')
  assert.equal(typeof instance.provider.reflectionProjection, 'function')
  assert.equal(typeof instance.provider.summaryProjection, 'function')
  const branch = await instance.provider.branchProvider(bound.modelIdentity).complete({
    ownerId: identity.ownerId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    stableSystem: '合成稳定提示',
    delta: '只返回合成摘要',
    tools: [],
    scenario: 'compaction',
    outputMode: 'text',
    maxOutputTokens: 64,
    cacheSingleflight: false,
    canonicalHistory: [{ role: 'user', content: '合成历史' }],
  })
  assert.equal(branch.output, '合成回复')
  const compaction = createAgentCompactionPort({
    provider: instance.provider, identity, modelIdentity: bound.modelIdentity, stableSystem: '合成稳定提示',
    async loadTools() { return [] },
    scope: 'web', scopeRevision: 'scope-v1', contextTokens: 10000, maxOutputTokens: 100,
    instruction: '将历史整理为摘要', digest, nextId: randomUUID, diagnostic: () => {},
  })
  assert.equal(await compaction.summarize({
    history: [{ role: 'user', content: '旧对话' }], compressible: [{ role: 'user', content: '旧对话' }],
    previousSummary: null, projection: null, preserveLatestUser: false,
  }), '合成回复')
  let invalidBudgetProjectionRequests = 0
  const providerWithProjectionSpy = new Proxy(instance.provider, {
    get(target, property, receiver) {
      if (property === 'summaryProjection') return async (...args: Parameters<typeof target.summaryProjection>) => {
        invalidBudgetProjectionRequests++
        return target.summaryProjection(...args)
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const invalidBudgetCompaction = createAgentCompactionPort({
    provider: providerWithProjectionSpy,
    identity, modelIdentity: bound.modelIdentity, stableSystem: '合成稳定提示', scope: 'web', scopeRevision: 'scope-v1',
    async loadTools() { assert.fail('无效预算不应读取工具权限') },
    contextTokens: 10000, maxOutputTokens: 0, instruction: '将历史整理为摘要', digest, nextId: randomUUID, diagnostic: () => {},
  })
  assert.equal(await invalidBudgetCompaction.summarize({
    history: [{ role: 'user', content: '旧对话' }], compressible: [{ role: 'user', content: '旧对话' }],
    previousSummary: null, projection: null, preserveLatestUser: false,
  }), '')
  assert.equal(invalidBudgetProjectionRequests, 0)
  assert.equal(requests, 2)
  for await (const item of instance.harness.start(identity)) events.push(item)
  assert.equal(requests, 3)
  assert.equal(events.at(-1)?.payload.status, 'completed')
  assert.equal(events.some(item => item.type === 'token' && item.payload.text === '合成回复'), true)
  assert.deepEqual(histories, ['合成回复'])
  await instance.close()
  bound.release()
})

type AgentRuntimeOptionsRuntime = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>
