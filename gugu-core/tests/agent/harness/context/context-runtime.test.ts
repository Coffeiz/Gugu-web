import { createHash } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { Executor } from "../../../../src/agent/executor/executor.js"
import type { CanonicalContextPorts,CanonicalHarnessContext,CanonicalMessage,CurrentUser,HarnessPorts,RunCheckpoint,RunEvent,RunStore } from "../../../../src/agent/harness/index.js"
import { createCanonicalContextPort,createCanonicalHarness,createCanonicalSourceLoader,createReflectionFinalizer,isEarlyExit,ReflectionSnapshots,restorePreparedContext,stableJson } from "../../../../src/agent/harness/index.js"

const identity = { ownerId: '小北', sessionId: 'session-1', runId: 'run-1' }
const signal = () => new AbortController().signal
function fixture() {
  let id = 0
  const services = {
    digest: (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex'),
    nextId: () => `entry-${++id}`
  }
  const accessScopeHash = services.digest({ ...identity, access: 'owner' })
  const prefix: CanonicalMessage[] = [{ role: 'system', content: '合成固定规则' }]
  const ports: CanonicalContextPorts = {
    ...services,
    finalization: { complete: vi.fn(async () => undefined) },
    references: { dehydrate: async (entry) => structuredClone(entry.message), hydrate: async (entry) => structuredClone(entry.message) },
    load: async () => ({
      modelIdentity: 'synthetic-model', contextWindow: 100, accessScopeHash,
      input: {
        ...identity, history: [
          { ...identity, id: 'history-1', conversationSeq: 1, role: 'user', content: '以前的问题' },
          { ...identity, id: 'history-2', conversationSeq: 2, role: 'assistant', content: '以前的回答' },
        ], fixedPrefix: prefix, currentUser: { persistedMessageId: 'current-3', message: { role: 'user', content: '本轮问题' } }
      }
    }),
    preparation: { ...services, buildRag: async () => ({ tail: [] }) },
    prepareRequest: vi.fn(async () => ({ prefix, dynamicTail: [] })),
    compaction: { summarize: vi.fn(async () => '合成摘要') },
    currentRequest: (_identity, input) => ({
      sourceCheckpointDigest: input.checkpointDigest, accessScopeHash: input.accessScopeHash,
      area: input.materialized.area.snapshot(), requestPrefix: input.materialized.area.requestPrefix,
      dynamicTail: input.materialized.area.dynamicTail, systemPrompt: '合成固定规则', tools: [],
      projection: { ...input.materialized.area.identity(input.modelIdentity), dynamicTailSize: 0, wire: { native: '合成不透明投影' } }
    }),
    stageContinuation: vi.fn(async () => 'reasoning-record-1'),
    releaseContinuations: vi.fn(async () => undefined),
    diagnoseCompactionFailure: vi.fn(),
  }
  const implementation = createCanonicalContextPort(ports)
  const context = {
    ...implementation,
    async prepare(owner: typeof identity, abort: AbortSignal): Promise<CanonicalHarnessContext> {
      const result = await implementation.prepare(owner, abort)
      if (isEarlyExit(result)) throw new Error('普通上下文夹具不应早退')
      return result
    },
  }
  return { services, ports, context, accessScopeHash }
}
const call = { id: 'tool-1', name: 'synthetic_tool', input: { text: '合成参数' } }

describe('Canonical上下文与Run运行时组合', () => {
  it('成功压力压缩后相同输入重复检查不重写摘要，也不再次调用摘要模型', async () => {
    const { context, ports } = fixture()
    let state = await context.prepare(identity, signal())
    for (let round = 1; round <= 2; round++) {
      const current = { ...call, id: `repeat-${round}` }
      state = await context.afterRound(state, { text: `工具轮${round}`, calls: [current] }, round)
      state = await context.afterTool(state, current, { kind: 'completed', value: '完成', successful: true, mutated: false }, round)
    }
    const usage = { input: 85, output: 1, cacheRead: 0, cacheWrite: 0, contextInput: 85 }
    const first = await context.afterUsage(state, usage, signal())
    expect(first.applied).toBe(true)
    const second = await context.afterUsage(first.context, usage, signal())
    expect(second.applied).toBe(false)
    expect(second.context.prepared).toEqual(first.context.prepared)
    expect(second.context.compactions).toHaveLength(1)
    expect(ports.compaction.summarize).toHaveBeenCalledTimes(1)
  })
  it('标准Core来源loader实际连接快照和历史再准备上下文，RAG只一次且snapshot仅交事务候选', async () => {
    const { context, ports, services } = fixture()
    const order: string[] = []
    const original = {
      ...identity, context: null, contextEpoch: 0, baselineMessageSeq: 0,
      snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null
    }
    const data = async () => []
    const loader = createCanonicalSourceLoader({
      ...services, now: () => 1000,
      readSnapshot: async () => { order.push('snapshot'); return original },
      select: async () => {
        order.push('model'); return {
          modelIdentity: 'synthetic-model', contextWindow: 100,
          locale: 'zh-CN', groupChat: false, workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true }
        }
      },
      currentRevision: async () => 2,
      data: {
        loadTimezone: async () => 'UTC', loadProjects: async () => { order.push('projects'); return [] },
        loadEvents: data, loadNotes: data, loadFilesOverview: data, loadStylePreferences: data,
        loadImChannels: data, loadMemory: data, loadImMemory: data, loadKnowledge: data
      },
      historyReader: { read: async () => { order.push('history'); return { baselineSeq: 0, rows: [] } } },
      currentTurn: async () => {
        order.push('current'); return {
          currentUser: {
            persistedMessageId: '3',
            message: { role: 'user', content: '本轮来源请求' }
          }
        }
      },
      builder: {
        buildSnapshot: () => ({
          systemPrompt: '固定规则', snapshotContext: '冻结业务快照', sessionInfo: {},
          userTimezone: 'UTC', locale: 'zh-CN'
        }),
        buildRequest: (snapshot) => ({
          systemPrompt: '本轮规则', systemInMessages: true,
          fixedPrefix: [{ role: 'user', content: snapshot.snapshotContext }]
        })
      },
    })
    ports.load = loader.load
    const rag = vi.spyOn(ports.preparation, 'buildRag')
    const prepared = await context.prepare(identity, signal())
    expect(order).toEqual(['snapshot', 'model', 'projects', 'history', 'current'])
    expect(rag).toHaveBeenCalledOnce()
    expect(prepared.sourceEffects?.sessionSnapshot).toMatchObject({ expectedEpoch: 0, phase: 'rebuild', state: { contextEpoch: 1 } })
    expect(original.context).toBeNull()
    expect(original.contextEpoch).toBe(0)
  })

  it('准备早退直接交回Harness，不构造Canonical或触发RAG与模型投影', async () => {
    const { ports } = fixture()
    const exit = { kind: 'early_exit' as const, reason: 'quota_exhausted' as const, response: { text: '合成额度提醒' } }
    ports.load = async () => exit
    const rag = vi.spyOn(ports.preparation, 'buildRag')
    const request = vi.spyOn(ports, 'currentRequest')
    expect(await createCanonicalContextPort(ports).prepare(identity, signal())).toEqual(exit)
    expect(rag).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('回复守卫固定最后真实current用户正文，忽略同批较早请求及尾部内部说明和工具结果', async () => {
    const { context, ports } = fixture()
    const load = ports.load
    ports.load = async (owner, abort) => {
      const loaded = await load(owner, abort)
      if (isEarlyExit(loaded)) throw new Error('普通夹具不应早退')
      const currentUsers: CurrentUser[] = [
        { message: { role: 'user', content: '请把旧文件删除' } },
        { message: { role: 'user', content: [{ type: 'text', text: '解释一下图片内容' }, { type: 'attachment_ref', attach_id: 'image-1' }] } },
        { message: { role: 'user', content: '[system-reminder]\n内部状态\n[/system-reminder]' }, rawText: '不能把辅助消息变真实用户' },
        { message: { role: 'system', content: '可信系统辅助说明' } },
      ]
      return {
        ...loaded, replyContext: { decisionGuardEnabled: true }, input: {
          ...loaded.input,
          currentUser: undefined, currentUsers, extraReminder: 'RAG与控制说明也不是本轮真实用户正文',
        }
      }
    }
    let state = await context.prepare(identity, signal())
    state = await context.afterRound(state, { text: '工具前说明', calls: [call] }, 1)
    state = await context.afterTool(state, call, { kind: 'completed', value: { ok: true }, successful: true, mutated: false }, 1)
    expect(state.replyContext).toEqual({ userRequest: '解释一下图片内容', locale: 'zh-CN', decisionGuardEnabled: true })
  })

  it('缓存锚点只交接同模型稳定元数据，不用native continuation替代或接受秘密字段', async () => {
    const { context } = fixture()
    const initial = await context.prepare(identity, signal())
    const cacheAnchor = {
      modelIdentity: 'synthetic-model', anchor: {
        provider: 'synthetic', api_format: 'anthropic', model: 'synthetic-model', strategy: 'multi', baseline_digest: 'a'.repeat(64),
      }
    }
    const state = await context.afterRound(initial, { text: '完成', calls: [], cacheAnchor }, 1)
    expect(state.providerCacheAnchor).toEqual({
      ownerId: identity.ownerId, sessionId: identity.sessionId,
      modelIdentity: 'synthetic-model', anchor: cacheAnchor.anchor
    })
    expect(state.continuationRef).toBeNull()
    await expect(context.afterRound(initial, { text: '完成', calls: [], cacheAnchor: { ...cacheAnchor, modelIdentity: 'other-model' } }, 1))
      .rejects.toThrow('模型身份')
    await expect(context.afterRound(initial, {
      text: '完成', calls: [], cacheAnchor: {
        ...cacheAnchor, anchor: { ...cacheAnchor.anchor, access_token: 'synthetic-secret' },
      }
    }, 1)).rejects.toThrow('稳定指纹')
  })

  it('工具等待、回答与完成只保留一条配对结果，冻结请求前缀不重复构建', async () => {
    const { context, ports } = fixture()
    let state = await context.prepare(identity, signal())
    state = await context.afterRound(state, { text: '先执行', calls: [call] }, 1)
    const pending = { id: 'interaction-1', kind: 'confirmation' as const, toolCall: call }
    state = await context.afterTool(state, call, { kind: 'waiting', interaction: pending }, 1)
    state = await context.resumeInteraction(state, pending, {
      interactionId: pending.id, receiptId: 'receipt-1', status: 'confirmed', value: true,
    })
    state = await context.afterTool(state, call, { kind: 'completed', value: { ok: true }, successful: true, mutated: true }, 1)
    const results = state.prepared.area.entries.filter((entry) => stableJson(entry.message).includes('tool_result'))
    expect(results).toHaveLength(1)
    expect(stableJson(results[0]?.message)).toContain('ok')
    expect(stableJson(results[0]?.message)).not.toContain('pending')
    expect(ports.prepareRequest).not.toHaveBeenCalled()
  })

  it('重新装配ContextPort时从稳定checkpoint恢复，内部owner与可信Run不一致时拒绝', async () => {
    const { context, ports } = fixture()
    const prepared = await context.prepare(identity, signal())
    const recovered = createCanonicalContextPort(ports)
    expect(() => recovered.assertIdentity({ ...identity, ownerId: '小南' }, prepared)).toThrow('不存在')
    let state = await recovered.afterRound(prepared, { text: '恢复后的回复', calls: [] }, 1)
    state = await recovered.appendReminder!(state, '合成后续提示')
    expect(ports.prepareRequest).toHaveBeenCalledTimes(1)
    expect(stableJson(state)).toContain('恢复后的回复')
    expect(state.prepared.area.entries.at(-1)?.persistencePolicy).toBe('request_only')
    await recovered.release!(identity)
    expect(ports.releaseContinuations).toHaveBeenCalledWith(identity)
    await recovered.afterRound(state, { text: '再次恢复', calls: [] }, 2)
    expect(ports.prepareRequest).toHaveBeenCalledTimes(2)
  })

  it('续接材料仅暂存，持久上下文只保留记录ID，不包含原生签名或wire', async () => {
    const { context, ports } = fixture()
    const initial = await context.prepare(identity, signal())
    const continuation = { signature: '合成私有签名', wire: ['合成协议块'] }
    const state = await context.afterRound(initial, { text: '回复', calls: [], continuation }, 1)
    expect(ports.stageContinuation).toHaveBeenCalledWith(expect.objectContaining({ identity, value: continuation }))
    expect(state.continuationRef).toBe('reasoning-record-1')
    expect(stableJson(state)).not.toContain('合成私有签名')
    expect(stableJson(state)).not.toContain('合成协议块')
  })

  it('反思捕获Provider实际发出的冻结媒体快照，不拼接回复后再次hydrate的新短期地址', async () => {
    const { context, ports, services } = fixture()
    let hydration = 0
    const load = ports.load
    ports.load = async (owner, abort) => {
      const result = await load(owner, abort)
      if (isEarlyExit(result)) throw new Error('普通上下文夹具不应早退')
      const message: CanonicalMessage = {
        role: 'user', content: [
          { type: 'text', text: '查看合成图片' }, { type: 'image', source: { type: 'url', url: 'https://synthetic.example/initial' } },
        ]
      }
      return {
        ...result, input: {
          ...result.input, currentUser: {
            persistedMessageId: 'current-3', message,
          }
        }
      }
    }
    ports.references.dehydrate = async (entry) => ({
      ...entry.message, content: Array.isArray(entry.message.content)
        ? entry.message.content.map((block) => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'image'
          ? { type: 'attachment_ref', attach_id: 'image-1' } : block) : entry.message.content
    })
    ports.references.hydrate = async (entry) => ({
      ...entry.message, content: Array.isArray(entry.message.content)
        ? entry.message.content.map((block) => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'attachment_ref'
          ? { type: 'image', source: { type: 'url', url: `https://synthetic.example/temporary-${++hydration}` } } : block) : entry.message.content
    })
    const initial = await context.prepare(identity, signal())
    const actual = await restorePreparedContext(initial.prepared, identity, {
      ...services, prepareRequest: () => ports.prepareRequest(identity),
    }, ports.references)
    const frozen = {
      sourceCheckpointDigest: initial.prepared.digest, accessScopeHash: initial.accessScopeHash, area: actual.area.snapshot(),
      requestPrefix: actual.area.requestPrefix, dynamicTail: actual.area.dynamicTail,
      systemPrompt: '原请求规则', tools: [{ name: '原请求工具' }], projection: {
        ...actual.area.identity(initial.modelIdentity), dynamicTailSize: 0, wire: { actualMedia: 'temporary-1' },
      }
    }
    ports.currentRequest = () => frozen
    const state = await context.afterRound(initial, { text: '完成图片分析', calls: [] }, 1)
    frozen.systemPrompt = '运行中已改变的配置'
    await context.afterFinal!(identity, state, {
      status: 'completed', text: '完成图片分析', roundTexts: ['完成图片分析'],
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, contextInput: 10 }, hadTools: false, displayTimeline: []
    })
    const captured = vi.mocked(ports.finalization.complete).mock.calls[0]![0]
    expect(captured.requestSystemPrompt).toBe('原请求规则')
    expect(stableJson(captured.request?.area.messages)).toContain('temporary-1')
    expect(stableJson(captured.request?.area.messages)).not.toContain('temporary-2')
    expect(captured.request?.area.matchesProjection(captured.projection!, initial.modelIdentity)).toBe(true)
  })

  it('只把已派发回执的工具写进同批Canonical，未启动取消不留孤儿且header副本脱敏', async () => {
    const { context, ports, services } = fixture()
    const first = { ...call, input: { headers: { Authorization: 'synthetic-header-secret' }, text: '合成正文' } }
    const second = { ...call, id: 'tool-2' }
    let state = await context.prepare(identity, signal())
    state = await context.afterRound(state, { text: '工具前说明', calls: [first, second] }, 1)
    expect(stableJson(state.prepared.area)).not.toContain('tool_call')
    expect(stableJson(state)).not.toContain('synthetic-header-secret')
    expect(first.input.headers.Authorization).toBe('synthetic-header-secret')
    state = await context.afterTool(state, first, {
      kind: 'waiting', interaction: {
        id: 'confirmation-1', kind: 'confirmation', toolCall: first,
      }
    }, 1)
    const unstarted = await context.afterTool(state, second, {
      kind: 'completed', value: { status: 'deferred' },
      executed: false, successful: false, mutated: false
    }, 1)
    expect(unstarted).toBe(state)
    const restored = await restorePreparedContext(state.prepared, identity, {
      ...services,
      prepareRequest: () => ports.prepareRequest(identity)
    }, ports.references)
    const delta = stableJson(restored.area.persistenceDelta('interruption'))
    expect(delta).toContain('tool-1')
    expect(delta).not.toContain('tool-2')
    expect(delta).not.toContain('synthetic-header-secret')
  })

  it('实际工具回执追加独立同批Schema事件并去重，原始参数字节和Responses身份贯穿主链', async () => {
    const { context, ports, services } = fixture()
    const rawArguments = '{ "z": 1, "a": 2 }'
    const schemaCall = { ...call, name: 'get_tool_schema', input: { z: 1, a: 2 }, rawArguments, responsesItemId: 'item-1' }
    const event = {
      type: 'tool-schema', tool_name: 'synthetic_tool', schema_digest: 'schema-1',
      implementation_digest: 'implementation-1', schema: { type: 'object', properties: { signature: { type: 'string' } } }
    }
    let state = await context.prepare(identity, signal())
    state = await context.afterRound(state, { text: '', calls: [schemaCall] }, 1)
    state = await context.afterTool(state, schemaCall, {
      kind: 'completed', value: { ok: true },
      successful: true, mutated: false, canonicalEvents: [event, event]
    }, 1)
    const restored = await restorePreparedContext(state.prepared, identity, {
      ...services,
      prepareRequest: () => ports.prepareRequest(identity)
    }, ports.references)
    const delta = restored.area.persistenceDelta('success')
    expect(delta.batches).toHaveLength(1)
    expect(delta.batches[0]?.entries).toHaveLength(3)
    const messages = delta.batches[0]!.entries.map((entry) => entry.message)
    expect(messages[0]?.content).toEqual([{
      type: 'tool_call', id: schemaCall.id, name: schemaCall.name,
      arguments: rawArguments, responses_item_id: 'item-1'
    }])
    expect(messages[1]?.role).toBe('user')
    expect(messages[2]).toEqual({ role: 'user', content: [event] })
  })

  it('纯草稿和控制说明不进入成功历史，两个实际工具往返按原序完整保留', async () => {
    const { context, ports, services } = fixture()
    let state = await context.prepare(identity, signal())
    state = await context.afterRound(state, { text: '纯草稿', calls: [] }, 1)
    state = await context.appendReminder!(state, '内部控制说明')
    state = await context.afterRound(state, { text: '真实工具说明一', calls: [call] }, 2)
    state = await context.afterTool(state, call, { kind: 'completed', value: { ok: true }, successful: true, mutated: true }, 2)
    state = await context.afterRound(state, { text: '守卫续轮草稿', calls: [] }, 3)
    const second = { ...call, id: 'tool-2' }
    state = await context.afterRound(state, { text: '真实工具说明二', calls: [second] }, 4)
    state = await context.afterTool(state, second, { kind: 'completed', value: { error: '合成业务失败' }, successful: false, mutated: false }, 4)
    state = await context.afterRound(state, { text: '最终回复由history.text提交一次', calls: [] }, 5)
    const restored = await restorePreparedContext(state.prepared, identity, {
      ...services,
      prepareRequest: () => ports.prepareRequest(identity)
    }, ports.references)
    const delta = restored.area.persistenceDelta('success')
    expect(delta.entries.map((entry) => entry.message.role)).toEqual(['assistant', 'user', 'assistant', 'user'])
    expect(delta.entries.every((entry) => entry.source === 'tool_round')).toBe(true)
    expect(delta.batches).toHaveLength(2)
    const text = stableJson(delta)
    expect(text).toContain('tool-1')
    expect(text).toContain('tool-2')
    expect(text).toContain('is_error')
    expect(text).not.toContain('纯草稿')
    expect(text).not.toContain('内部控制说明')
    expect(text).not.toContain('守卫续轮草稿')
    expect(text).not.toContain('最终回复由history.text')
  })

  it('未压缩的85%阈值只记录失败输入，增长不足8000不重复尝试，也不裁保护窗口', async () => {
    const { ports, context } = fixture()
    const load = ports.load
    ports.load = async (owner, abort) => {
      const result = await load(owner, abort)
      if (isEarlyExit(result)) throw new Error('普通上下文夹具不应早退')
      return { ...result, input: { ...result.input, history: [] } }
    }
    const initial = await context.prepare(identity, signal())
    const usage = { input: 85, output: 1, cacheRead: 0, cacheWrite: 0, contextInput: 85 }
    const failed = await context.afterUsage(initial, usage, signal())
    expect(failed.applied).toBe(false)
    expect(failed.context.failedCompactionInput).toBe(85)
    expect(failed.context.prepared).toBe(initial.prepared)
    const unchanged = await context.afterUsage(failed.context, { ...usage, contextInput: 8084 }, signal())
    expect(unchanged.context).toBe(failed.context)
    const retried = await context.afterUsage(failed.context, { ...usage, contextInput: 8085 }, signal())
    expect(retried.context.failedCompactionInput).toBe(8085)
    expect(retried.applied).toBe(false)
    expect(ports.compaction.summarize).not.toHaveBeenCalled()
  })

  it('摘要模型失败保留原上下文和失败阈值，原始异常仅交受限诊断且取消不吞掉', async () => {
    const { context, ports } = fixture()
    const original = new Error('合成私有摘要错误')
    ports.compaction.summarize = vi.fn(async () => { throw original })
    const initial = await context.prepare(identity, signal())
    const usage = { input: 85, output: 1, cacheRead: 0, cacheWrite: 0, contextInput: 85 }
    const failed = await context.afterUsage(initial, usage, signal())
    expect(failed.applied).toBe(false)
    expect(failed.context.prepared).toBe(initial.prepared)
    expect(failed.context.failedCompactionInput).toBe(85)
    expect(ports.diagnoseCompactionFailure).toHaveBeenCalledWith(expect.objectContaining({ identity }), original)
    expect(stableJson(failed.context)).not.toContain('合成私有摘要错误')
    const controller = new AbortController()
    ports.compaction.summarize = async () => { controller.abort(); throw original }
    await expect(context.afterUsage(initial, usage, controller.signal)).rejects.toBe(original)
  })

  it.each([2, 14])('当前请求85%且有%i轮时摘要较早轮，原样保留用户与最新完整工具轮和原生投影', async (rounds) => {
    const { context, ports, services } = fixture()
    let state = await context.prepare(identity, signal())
    for (let round = 1;round <= rounds;round++) {
      const tool = { ...call, id: `tool-${round}` }
      state = await context.afterRound(state, { text: `轮次${round}`, calls: [tool] }, round)
      state = await context.afterTool(state, tool, { kind: 'completed', value: { ok: true }, successful: true, mutated: false }, round)
    }
    const unknown = await context.afterUsage(state, { input: 9999, output: 1, cacheRead: 0, cacheWrite: 0, contextInput: null }, signal())
    expect(unknown.applied).toBe(false)
    expect(ports.compaction.summarize).not.toHaveBeenCalled()
    const result = await context.afterUsage(state, { input: 20, output: 1, cacheRead: 65, cacheWrite: 0, contextInput: 85 }, signal())
    expect(result.applied).toBe(true)
    expect(ports.compaction.summarize).toHaveBeenCalledWith(expect.objectContaining({
      projection: expect.objectContaining({ wire: { native: '合成不透明投影' } }),
    }), expect.any(AbortSignal))
    expect(result.context.compactions[0]?.result.coversUntilMessageIds).toEqual(['history-1', 'history-2'])
    const text = stableJson(result.context.prepared.area.entries)
    expect(text).toContain(`轮次${rounds}`)
    expect(text).not.toContain(`轮次${rounds - 1}"`)
    const restored = await restorePreparedContext(result.context.prepared, identity, {
      ...services, prepareRequest: () => ports.prepareRequest(identity),
    }, ports.references)
    expect(restored.area.protectedHistoryStart).toBe(result.context.prepared.protectedHistoryStart)
  })

  it.each([['普通工具', false, false, false, false], ['凭据交互', true, false, false, false], ['工具后模型失败', false, true, false, false],
  ['原生执行结果未知', false, false, true, false], ['未开放工具', false, false, false, true]] as const)('Runtime的%s经过真实Canonical转换，所有checkpoint与历史安全且先提交再final', async (_label, credential, fail, nativeUnknown, unavailable) => {
    const { context, ports: contextPorts, services, accessScopeHash } = fixture()
    const snapshots = new ReflectionSnapshots<unknown>(services, () => 1000)
    contextPorts.finalization.complete = vi.fn(createReflectionFinalizer({
      snapshots,
      policy: async () => ({ enabled: true, scope: 'owner' }),
      projection: { append: (projection, tail) => ({ ...projection, wire: { prefix: projection.wire, tail }, dynamicTailSize: 0 }) },
      notifyReady: async () => undefined,
    }).complete)
    type C = CanonicalHarnessContext
    let stored: RunCheckpoint<C> | null = null
    const history: string[] = []
    const published: string[] = []
    const errors: unknown[] = []
    const outbox: RunEvent[] = []
    const checkpoints: string[] = []
    const appliedCompactions: string[] = []
    let mutations = 0
    let providerCalls = 0
    let toolCalls = 0
    let discoveryStarted = false
    let recallStarted = false
    let preparedPrefix: CanonicalMessage[] = []
    contextPorts.prepareRequest = async () => ({ prefix: preparedPrefix, dynamicTail: [] })
    const load = contextPorts.load
    contextPorts.load = async (owner, abort) => {
      const loaded = await load(owner, abort)
      if (isEarlyExit(loaded)) return loaded
      return {
        ...loaded, input: {
          ...loaded.input, systemPrompt: '合成固定规则', systemInMessages: true,
          fixedPrefix: [{ role: 'user', content: '冻结业务快照' }], snapshotText: '冻结业务快照'
        }
      }
    }
    contextPorts.preparation.buildRag = vi.fn(async () => {
      recallStarted = true
      expect(discoveryStarted).toBe(true)
      return { tail: [] }
    })
    contextPorts.currentRequest = (_owner, input) => ({
      sourceCheckpointDigest: input.checkpointDigest, accessScopeHash: input.accessScopeHash,
      area: input.materialized.area.snapshot(), requestPrefix: input.materialized.area.requestPrefix,
      dynamicTail: input.materialized.area.dynamicTail,
      systemPrompt: String(input.materialized.area.requestPrefix[0]?.content), tools: [],
      projection: { ...input.materialized.area.identity(input.modelIdentity), dynamicTailSize: 0, wire: { native: '合成不透明投影' } }
    })
    const store: RunStore<C> = {
      read: async () => structuredClone(stored),
      create: async (value, _lease, events) => { stored = structuredClone(value); outbox.push(...events) },
      commit: async (change) => {
        checkpoints.push(stableJson(change))
        expect(change.expectedVersion).toBe(stored?.version)
        context.assertIdentity(change.identity, change.checkpoint.context!)
        stored = structuredClone(change.checkpoint)
        outbox.push(...change.events)
        if (change.history) {
          history.push(stableJson(change.history))
          if (change.history.outcome === 'success') appliedCompactions.push(...change.history.context.compactions.map((item) => item.id))
        }
      },
      pendingEvents: async () => outbox,
      acknowledgeEvents: async (_identity, ids) => { for (let index = outbox.length - 1;index >= 0;index--) if (ids.includes(outbox[index]!.id)) outbox.splice(index, 1) },
    }
    const ports: HarnessPorts<C> = {
      interactions: { activate: async (_owner, pending) => pending },
      clock: { now: () => '2026-11-13T00:00:00.000Z' },
      store, context, leases: { acquire: async () => ({ token: 'synthetic-lease', fence: 1 }), assert: async () => undefined, release: async () => undefined },
      cancellation: { isRequested: async () => false, request: async () => undefined, notify: async () => undefined, subscribe: async () => () => undefined },
      provider: {
        async *stream(request) {
          providerCalls++
          expect(request.context.capabilities?.toolNames).toEqual(['synthetic_tool', 'shell'])
          expect(request.context.capabilities?.tools.map(tool => tool.name)).toEqual(['synthetic_tool', 'shell'])
          const restoredRequest = await restorePreparedContext(request.context.prepared, identity, {
            ...services, prepareRequest: () => contextPorts.prepareRequest(identity),
          }, contextPorts.references)
          const prefix = stableJson(restoredRequest.area.requestPrefix)
          expect(prefix).toContain('合成实时Shell状态')
          expect(prefix).toContain('合成技能目录')
          expect(prefix).not.toContain('present_file')
          if (request.round === 2 && fail) { yield { type: 'error', error: new Error('合成后续模型故障') }; return }
          if (request.round === 1) yield { type: 'usage', usage: { input: 20, output: 1, cacheRead: 65, cacheWrite: 0, contextInput: 85 } }
          yield { type: 'token', text: request.round === 1 ? '执行中' : '已完成' }
          yield {
            type: 'complete', text: request.round === 1 ? '执行中' : '已完成', calls: request.round === 1
              ? unavailable ? [{ ...call, name: 'present_file' }] : nativeUnknown ? [call, { ...call, id: 'tool-2' }] : [call] : []
          }
        }
      },
      tools: {
        dispatch: async (_call, scope) => {
          toolCalls++
          if (nativeUnknown) {
            try {
              await scope.execute({
                id: '00000000-0000-4000-8000-000000000099', command: 'synthetic-command',
                cwd: '/synthetic/workspace', timeoutMs: 1000, destructive: false
              })
            } catch { /* 明确模拟Tools错误吞掉未知原生结果。 */ }
            return { kind: 'completed', value: { error: '工具错误映射' }, successful: false, mutated: false }
          }
          if (credential) return { kind: 'waiting', interaction: { id: 'credential-1', kind: 'credential', toolCall: call } }
          mutations++
          return { kind: 'completed', value: { ok: true }, successful: true, mutated: true }
        },
        reconcile: async () => ({ kind: 'unknown' })
      },
      execution: { execute: async () => { throw new Error('测试工具没有外部执行意图') } },
      reply: { evaluate: async () => 'accept' }, sanitizeText: (text) => text,
      presentToolResult: async (value) => value,
      createStreamSanitizer: () => ({ feed: (text) => text, flush: () => '' }),
      presentError: (error) => { errors.push(error); return { code: 'synthetic_failure', text: '合成失败' } }, diagnose: () => undefined,
      publish: async (event) => { if (event.type === 'final') expect(history).toHaveLength(fail || nativeUnknown || unavailable ? 0 : 1); published.push(event.type) },
    }
    const events: RunEvent[] = []
    const harness = createCanonicalHarness({
      context: contextPorts, runtime: ports,
      runPreparation: {
        configuration: async (owner) => ({
          identity: {
            ownerId: owner.ownerId,
            subject: { kind: 'session', id: owner.sessionId }, workspaceId: 'workspace-1'
          },
          source: 'telegram', toolNames: ['synthetic_tool', 'shell', 'present_file']
        }),
        discover: async ({ identity: owner }) => {
          discoveryStarted = true
          await Promise.resolve()
          expect(recallStarted).toBe(true)
          expect(owner.subject).toEqual({ kind: 'session', id: identity.sessionId })
          return ['synthetic_tool', 'shell', 'present_file'].map(name => ({ name, schema: { type: 'object' } }))
        },
        capabilities: {
          workspaceSupported: true, filterConfigured: async names => names,
          shellPolicy: async () => ({ allowed: true, needsConfirmation: false }),
          shellState: async () => '合成实时Shell状态', appendShellProtocol: system => `${system}\n稳定Shell协议`,
          catalog: async (names, owner, tools) => {
            expect(names).toEqual(['synthetic_tool', 'shell'])
            expect(owner.subject.id).toBe(identity.sessionId)
            expect(tools?.map(tool => tool.name)).toEqual(['synthetic_tool', 'shell'])
            return { metadataOnly: false, toolCatalog: '合成工具目录', skillCatalog: '合成技能目录', userSkills: [] }
          },
        },
        formatPrefix: ({ system, snapshot }) => {
          expect(system).toContain('合成实时Shell状态')
          expect(system).toContain('合成工具目录')
          expect(system).not.toContain('合成技能目录')
          expect(snapshot).toBe('冻结业务快照\n\n---\n\n合成技能目录')
          preparedPrefix = [{ role: 'system', content: system }, { role: 'user', content: snapshot }]
          return preparedPrefix.slice(1)
        },
      },
      executor: {
        authorize: async (_scope, request) => ({
          requestId: request.id, command: request.command,
          cwd: request.cwd, backend: 'synthetic-backend', timeoutMs: 1000, maxOutputBytes: 1024,
          confirmed: false, readonlyPaths: [request.cwd], readwritePaths: [], environment: {}
        }),
        executor: new Executor([{
          id: 'synthetic-backend', capabilities: {
            filesystem: true, networkDeny: true, uiDeny: true, timeout: true, cancellation: true,
          }, execute: async () => { mutations++; throw new Error('合成私有后端故障') }
        }])
      },
    })
    for await (const event of harness.start(identity)) events.push(event)
    if (credential) {
      expect(history).toHaveLength(0)
      for await (const event of harness.resume(identity, {
        interactionId: 'credential-1', receiptId: 'receipt-1',
        status: 'answered', value: { api_key: 'synthetic-private-key' }
      })) events.push(event)
    }
    expect(errors).toHaveLength(fail || unavailable ? 1 : 0)
    expect(events.at(-1)?.payload.status).toBe(nativeUnknown ? 'unknown' : fail || unavailable ? 'failed' : 'completed')
    if (fail || nativeUnknown || unavailable) {
      expect(history).toHaveLength(0)
      expect(mutations).toBe(unavailable ? 0 : 1)
      expect(appliedCompactions).toHaveLength(0)
      expect(contextPorts.finalization.complete).not.toHaveBeenCalled()
      expect(snapshots.peek(identity, 'synthetic-model', accessScopeHash)).toBeNull()
      if (nativeUnknown) { expect(providerCalls).toBe(1); expect(toolCalls).toBe(1) }
      if (unavailable) { expect(providerCalls).toBe(1); expect(toolCalls).toBe(0) }
    } else {
      expect(history[0]).toContain('tool_result')
      expect(history[0]).toContain('已完成')
      expect(appliedCompactions).toHaveLength(1)
      expect(contextPorts.finalization.complete).toHaveBeenCalledOnce()
      expect(snapshots.peek(identity, 'synthetic-model', accessScopeHash)?.systemPrompt).toContain('合成实时Shell状态')
      expect(snapshots.peek(identity, 'synthetic-model', accessScopeHash)?.providerContextInput).toBeNull()
    }
    expect(published.at(-1)).toBe('final')
    expect(contextPorts.preparation.buildRag).toHaveBeenCalledOnce()
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1))
    expect(stableJson({ checkpoints, history, outbox, stored })).not.toContain('synthetic-private-key')
  })
})
