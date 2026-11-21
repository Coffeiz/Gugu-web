import { expect, it, vi } from 'vitest'
import { AgentRunReconstructionVersionError, createAgentRunReconstructor, restoreAgentRequestPrefix, stableJson } from '../../../src/agent/index.js'
import type { AgentRunBinding, ContextSourcePorts, RunIdentity } from '../../../src/agent/index.js'

const identity = { ownerId: '小北', sessionId: '会话', runId: '运行' }
const lease = {
  identity,
  mode: 'start' as const,
  input: { source: 'desktop', userMessageId: 1, accessVersion: '队列作用域', locale: 'zh-CN' },
}

function fixture() {
  const provider = { branchProvider: vi.fn(), reflectionProjection: vi.fn(), summaryProjection: vi.fn(), completeText: vi.fn() }
  const runtime = {
    provider,
    harness: {
      async *start() { throw new Error('不应启动运行') },
      async *resume() { throw new Error('不应继续运行') },
    },
    cancellation: { request: vi.fn(), notify: vi.fn() },
    close: vi.fn(async () => {}),
  }
  const binding = {
    selection: { modelIdentity: '合成模型', contextWindow: 1000, locale: 'zh-CN', groupChat: false, workspaceBinding: null,
      contextScopeKey: lease.input.accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } },
    resolve: vi.fn<AgentRunBinding['resolve']>(async () => ({
      modelIdentity: '合成模型', accessScopeHash: '运行作用域', config: { provider: 'openai', model: '合成模型' }, systemPrompt: '合成系统',
    })),
    release: vi.fn(),
  } satisfies AgentRunBinding
  const resources = { context: { digest: () => '运行作用域' }, bindProvider: vi.fn() }
  const ports = {
    acceptsInput: (input: typeof lease.input) => input.source === 'desktop',
    hasAnchor: vi.fn(async (_identity: RunIdentity, _messageId: number) => true),
    readCheckpoint: vi.fn(async () => null),
    bind: vi.fn(async (_lease: typeof lease) => binding),
    resources: vi.fn<() => Promise<typeof resources | null>>(async () => resources),
    createRuntime: vi.fn(() => runtime),
  }
  return { ports, binding, runtime, resources }
}

it('来源或消息锚点无效时不读取检查点或装配 Provider', async () => {
  const { ports } = fixture()
  const reconstruct = createAgentRunReconstructor(ports)
  await expect(reconstruct({ ...lease, input: { ...lease.input, source: 'web' } })).rejects.toBeInstanceOf(AgentRunReconstructionVersionError)
  expect(ports.hasAnchor).not.toHaveBeenCalled()
  ports.hasAnchor.mockResolvedValue(false)
  await expect(reconstruct(lease)).rejects.toThrow('运行消息锚点不存在')
  expect(ports.hasAnchor).toHaveBeenCalledWith(identity, 1)
  expect(ports.readCheckpoint).not.toHaveBeenCalled()
  expect(ports.bind).not.toHaveBeenCalled()
})

it('区分队列授权版本与 Provider 访问范围，任一失配均释放绑定', async () => {
  const { ports, binding } = fixture()
  const reconstruct = createAgentRunReconstructor(ports)
  await expect(reconstruct({ ...lease, input: { ...lease.input, accessVersion: '旧版本' } })).rejects.toBeInstanceOf(AgentRunReconstructionVersionError)
  expect(ports.resources).not.toHaveBeenCalled()
  const selected = await binding.resolve(identity, '合成模型', new AbortController().signal)
  binding.resolve.mockResolvedValue({ ...selected, accessScopeHash: lease.input.accessVersion })
  await expect(reconstruct(lease)).rejects.toBeInstanceOf(AgentRunReconstructionVersionError)
  expect(ports.createRuntime).not.toHaveBeenCalled()
  expect(binding.release).toHaveBeenCalledTimes(2)
})

it('缺少运行资源时保留待恢复状态并释放绑定', async () => {
  const { ports, binding } = fixture()
  ports.resources.mockResolvedValue(null)
  await expect(createAgentRunReconstructor(ports)(lease)).resolves.toBeNull()
  expect(binding.resolve).not.toHaveBeenCalled()
  expect(ports.createRuntime).not.toHaveBeenCalled()
  expect(binding.release).toHaveBeenCalledTimes(1)
})

it('成功重建时绑定同一 Provider，并等待同一次资源清理', async () => {
  const { ports, binding, resources, runtime } = fixture()
  let finish!: () => void
  runtime.close.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const instance = await createAgentRunReconstructor(ports)(lease)
  expect(instance).not.toBeNull()
  expect(resources.bindProvider).toHaveBeenCalledWith(runtime.provider, expect.objectContaining({ accessScopeHash: '运行作用域' }))
  const closing = instance!.close()
  expect(instance!.close()).toBe(closing)
  await Promise.resolve()
  expect(binding.release).not.toHaveBeenCalled()
  finish()
  await closing
  expect(runtime.close).toHaveBeenCalledTimes(1)
  expect(binding.release).toHaveBeenCalledTimes(1)
})

it('Provider 资源绑定失败时关闭已建运行，并保留原始失败', async () => {
  const { ports, binding, resources, runtime } = fixture()
  const failure = new Error('合成绑定失败')
  resources.bindProvider.mockRejectedValue(failure)
  runtime.close.mockRejectedValue(new Error('合成清理失败'))
  await expect(createAgentRunReconstructor(ports)(lease)).rejects.toBe(failure)
  expect(runtime.close).toHaveBeenCalledTimes(1)
  expect(binding.release).toHaveBeenCalledTimes(1)
})


function savedRequest() {
  const { selection } = fixture().binding
  const prefix = [{ role: 'system', content: '系统提示' }, { role: 'system', content: '冻结的会话前缀' }]
  const expected = { prefix, dynamicTail: [] }
  const checkpoint: Parameters<typeof restoreAgentRequestPrefix>[1] = {
    identity,
    accessScopeHash: '运行作用域',
    sourceEffects: { sessionSnapshot: {
      expectedEpoch: 4,
      phase: 'hit',
      state: {
        ownerId: identity.ownerId, sessionId: identity.sessionId, contextEpoch: 4,
        context: { access_scope_hash: '运行作用域', snapshot_context: '冻结的会话前缀' },
        snapshotHash: '冻结快照', sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0,
      },
    } },
    prepared: { requestPrefixSize: prefix.length, requestDigest: stableJson(expected) },
  }
  const buildRequest = vi.fn<ContextSourcePorts['builder']['buildRequest']>(snapshot => ({
    systemPrompt: '系统提示', systemInMessages: true, fixedPrefix: [{ role: 'system', content: snapshot.snapshotContext }],
  }))
  return { checkpoint, expected, selection, ports: { digest: stableJson, builder: { buildRequest } } }
}

it('恢复冻结前缀的系统消息顺序，每次返回独立副本并校验调用身份和取消', async () => {
  const { checkpoint, expected, selection, ports } = savedRequest()
  const restore = restoreAgentRequestPrefix(identity, checkpoint, selection, ports)
  const first = await restore(identity)
  expect(first).toEqual(expected)
  first.prefix[0]!.content = '外部改写'
  expect(await restore(identity)).toEqual(expected)
  await expect(restore({ ...identity, runId: '其他运行' })).rejects.toBeInstanceOf(AgentRunReconstructionVersionError)
  const aborted = new Error('取消恢复')
  await expect(restore(identity, AbortSignal.abort(aborted))).rejects.toBe(aborted)
})

it('快照归属或作用域无效时拒绝读取提示，前缀内容变化时拒绝恢复', () => {
  const { checkpoint, selection, ports } = savedRequest()
  const state = checkpoint.sourceEffects!.sessionSnapshot.state
  state.ownerId = '其他所有者'
  expect(() => restoreAgentRequestPrefix(identity, checkpoint, selection, ports)).toThrow(AgentRunReconstructionVersionError)
  state.ownerId = identity.ownerId
  state.context!.access_scope_hash = '其他作用域'
  expect(() => restoreAgentRequestPrefix(identity, checkpoint, selection, ports)).toThrow(AgentRunReconstructionVersionError)
  expect(ports.builder.buildRequest).not.toHaveBeenCalled()
  state.context!.access_scope_hash = checkpoint.accessScopeHash
  state.context!.snapshot_context = '长度相同但内容变化的请求'
  expect(() => restoreAgentRequestPrefix(identity, checkpoint, selection, ports)).toThrow('运行请求前缀已变化')
})

it.each(['固定前缀', '旧动态尾部'] as const)('重启时按原检查点恢复工具简介到%s', async (layout) => {
  const { checkpoint, expected, selection, ports } = savedRequest()
  const toolReminder = '合成工具简介：查询项目'
  const reminder = { role: 'user' as const, content: `[system-reminder]\n${toolReminder}\n[/system-reminder]` }
  const request = layout === '固定前缀'
    ? { prefix: [...expected.prefix, reminder], dynamicTail: [] }
    : { prefix: expected.prefix, dynamicTail: [reminder] }
  const restored = restoreAgentRequestPrefix(identity, {
    ...checkpoint, capabilities: { toolNames: [], tools: [], toolReminder },
    prepared: { ...checkpoint.prepared, requestPrefixSize: request.prefix.length, requestDigest: stableJson(request) },
  }, selection, ports)
  expect(await restored(identity)).toEqual(request)
})
