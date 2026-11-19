import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBuiltinSkillDefinitions, createSkillRegistry } from '@gugu/core/skills'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createCanonicalSourceLoader, stableJson } from '@gugu/core/agent'
import type { CanonicalContextPorts, CanonicalRunContext, AgentRunnerPorts, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createAgentRuntime } from '@gugu/core/agent'
import { createAgentToolRegistry } from '../../src/modules/agent-sessions/tools/agent-tool-registry.js'
import { agentContextAccessScope } from '../../src/modules/agent/model-config/access-scope.js'
import { bindProviderSelection } from '../../src/modules/agent/model-config/provider-resolver.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type RuntimePorts = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>

/** Provider、RunStore、租约、授权和上下文源为替身；Host runtime、注册器及技能读取为真实实现。 */
async function runReadRound(core: SqlDataRuntime, ownerId: string, timezone: string, skills: ReturnType<typeof createSkillRegistry>, reject = false) {
  const identity = { ownerId, sessionId: '1', runId: randomUUID() }
  const allowed = new Set(['use_skill'])
  const registry = createAgentToolRegistry({ core,
    authorize: async (scope, name) => scope.ownerId === ownerId && allowed.has(name),
    skills: { skills, origin: async () => ({ source: 'builtin' }) },
  })
  const policy = { groupChat: false, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
  const access = agentContextAccessScope('synthetic-read-tools-secret', identity, policy, { permissions: '1', model: '1', credentials: '1' }, digest, 'owner')
  const bound = await bindProviderSelection(identity, {
    selectPlatformModel: async () => ({ config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统', byokEnabled: false, localDeployment: false, accessScopeHash: access.accessScopeHash }),
    readActiveCredential: async () => null, decryptCredential: () => { throw new Error('只读替身不读取凭据') }, defaultBaseUrl: () => '',
  }, new AbortController().signal)
  const source = createCanonicalSourceLoader({ digest, nextId: randomUUID, now: () => 0,
    readSnapshot: async () => ({ ...identity, contextEpoch: 0, context: null, snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }),
    select: async () => ({ ...policy, modelIdentity: bound.modelIdentity, contextWindow: 10000, locale: 'zh-CN', workspaceBinding: null, contextScopeKey: access.contextScopeKey }),
    currentRevision: async () => 0, historyReader: { read: async () => ({ baselineSeq: 0, rows: [] }) },
    currentTurn: async () => ({ currentUser: { persistedMessageId: '1', message: { role: 'user', content: '请读取技能。' } } }),
    data: { loadTimezone: async () => timezone, loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [], loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}), loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
    builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '合成快照', sessionInfo: {}, userTimezone: timezone }), buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) },
  })
  const context: CanonicalContextPorts = {
    digest, nextId: randomUUID,
    load: async (id, signal) => { const tools = await registry.capabilities(id); return { ...await source.load(id, signal), capabilities: { toolNames: tools.map(tool => tool.name), tools } } },
    preparation: { buildRag: async () => ({ tail: [] }) },
    // 此端口只提供非持久前缀/动态尾部；工具结果必须由真实Canonical prepared.area恢复进入wire。
    prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
    references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
    compaction: { summarize: async () => { throw new Error('只读轮不应压缩') } }, finalization: { complete: async () => {} }, currentRequest: () => null,
    stageContinuation: async () => { throw new Error('不应启动续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
  }
  let checkpoint: RunCheckpoint<CanonicalRunContext> | null = null
  const outbox: RunEvent[] = [], committedToolResults: unknown[] = []
  const runtime: RuntimePorts = {
    clock: { now: () => '2026-01-01T20:00:00Z' },
    store: {
      read: async () => checkpoint,
      create: async (value, _lease, events) => { checkpoint = structuredClone(value); outbox.push(...events) },
      commit: async change => { assert.equal(checkpoint?.version, change.expectedVersion); checkpoint = structuredClone(change.checkpoint); outbox.push(...change.events); committedToolResults.push(...change.checkpoint.toolResults) },
      pendingEvents: async () => outbox, acknowledgeEvents: async () => {},
    },
    leases: { acquire: async () => ({ token: 'synthetic-lease', fence: 1 }), assert: async () => {}, release: async () => {} },
    cancellation: { isRequested: async () => false, request: async () => {}, notify: async () => {}, subscribe: async () => () => {} },
    tools: registry.tools, interactions: { activate: async (_id, request) => request },
    sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
    presentError: () => ({ code: 'failed', text: '合成运行失败' }), presentToolResult: async value => value,
    publish: async () => {}, diagnose: () => {},
  }
  const wireResults = new Map<string, unknown>()
  let requests = 0
  const instance = createAgentRuntime({ context, runtime,
    executor: { authorize: async () => { throw new Error('只读工具不得授权执行器') }, executor: { execute: async () => { throw new Error('只读工具不得执行进程') } } },
    provider: { resolve: bound.resolve, transport: { request: async request => {
      requests++
      const body = request.body as Record<string, unknown>
      if (requests === 1) {
        const definitions = body.tools as Array<{ function: { name: string } }>
        assert.deepEqual(definitions.map(tool => tool.function.name).sort(), ['use_skill'])
        // 目录已发现后撤权，dispatch 必须重新授权。
        if (reject) allowed.delete('use_skill')
        const calls = [{ index: 0, id: 'skill', type: 'function', function: { name: 'use_skill', arguments: JSON.stringify({ id: 'S1' }) } }]
        return response({ tool_calls: calls }, 'tool_calls')
      }
      assert.ok(requests === 2 || (!reject && requests === 3))
      const messages = body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>
      const actual = messages.filter(message => message.role === 'tool')
      assert.deepEqual(actual.map(message => message.tool_call_id), requests === 2 ? ['skill'] : ['skill', 'skill-again'])
      for (const message of actual) {
        // 真实Provider缓存投影可把JSON文本包为单个ephemeral text块；仍读取实际wire正文。
        let content = message.content
        if (typeof content !== 'string') {
          assert.ok(Array.isArray(content))
          assert.equal(content.length, 1)
          assert.deepEqual(Object.keys(content[0]).sort(), ['cache_control', 'text', 'type'])
          assert.equal(content[0].type, 'text')
          assert.deepEqual(content[0].cache_control, { type: 'ephemeral' })
          content = content[0].text
        }
        assert.equal(typeof content, 'string')
        wireResults.set(message.tool_call_id!, JSON.parse(content as string))
      }
      if (!reject && requests === 2) return response({ tool_calls: [{ index: 0, id: 'skill-again', type: 'function', function: { name: 'use_skill', arguments: JSON.stringify({ id: 'S1' }) } }] }, 'tool_calls')
      return response({ content: reject ? '部分查询未完成。' : '查询结果已读取。' }, 'stop')
    } } },
  })
  const events: RunEvent[] = []
  try {
    for await (const event of instance.harness.start(identity)) events.push(event)
    assert.equal(requests, reject ? 2 : 3)
    assert.equal(events.at(-1)?.payload.status, 'completed')
    assert.ok(committedToolResults.length >= 1)
    return { wireResults, events }
  } finally { await instance.close(); bound.release() }
}
function response(delta: Record<string, unknown>, finish: string) {
  return { status: 200, headers: {}, body: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  })(), cancel: async () => {} }
}

test('Core Agent Runtime 经 Markdown 注册器加载技能并送入 Provider 续轮，撤权后拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-skill-runtime-'))
  try {
    const path = join(dir, 'skill.md')
    await writeFile(path, '---\nid: S1\nname: 合成技能\ndescription_short: 示例\n---\n合成正文')
    const defs = await createBuiltinSkillDefinitions([{ name: 'skill.md', read: () => readFile(path, 'utf8') }], new AbortController().signal)
    const skills = createSkillRegistry({ skills: defs, authorize: async () => true })
    // 此测试不调用数据库；Provider、RunStore、租约、授权及上下文源均为测试替身。
    const core = {} as SqlDataRuntime
    const result = await runReadRound(core, 'owner-a', 'UTC', skills)
    assert.equal((result.wireResults.get('skill') as { content: string }).content, '合成正文')
    assert.equal((result.wireResults.get('skill-again') as { already_loaded: boolean }).already_loaded, true)
    assert.equal(JSON.stringify(result.wireResults.get('skill-again')).includes('合成正文'), false)
    const denied = await runReadRound(core, 'owner-a', 'UTC', skills, true)
    assert.equal(JSON.stringify(denied.wireResults.get('skill')).includes('合成正文'), false)
    assert.ok((denied.wireResults.get('skill') as { error: unknown }).error)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
