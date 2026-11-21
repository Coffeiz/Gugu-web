import { describe,expect,it,vi } from 'vitest'
import type { AgentObservation,CapabilityPreparationPorts,PreparationIdentity,RunIdentity } from "../../../src/agent/index.js"
import { createCanonicalRunLoader,discoverToolsAndRecall,prepareContext,prepareRunCapabilities,stableJson } from "../../../src/agent/index.js"

const identity: PreparationIdentity = {
  ownerId: '小北',
  subject: { kind: 'session', id: 'session-1' }, workspaceId: 'workspace-1'
}

function ports(): CapabilityPreparationPorts {
  return {
    workspaceSupported: true,
    filterConfigured: async (names) => names,
    shellPolicy: async () => ({ allowed: true, needsConfirmation: false }),
    shellState: async () => '合成本轮 Shell 状态',
    appendShellProtocol: (system) => `${system}\n合成稳定 Shell 协议`,
    catalog: async () => null,
  }
}

describe('Harness 准备编排保持短事务、身份与提示词边界', () => {
  it('简介模式下已授权 Shell 直接提供 Schema，业务工具留在动态目录', async () => {
    const run = { ownerId: identity.ownerId, sessionId: identity.subject.id, runId: 'run-brief' }
    const services = { digest: stableJson, nextId: () => 'entry-brief', buildRag: async () => ({ tail: [] }) }
    let businessTools = ['list_projects', 'shell']
    const load = createCanonicalRunLoader(async () => ({
      modelIdentity: 'brief-model', contextWindow: 1000, accessScopeHash: 'brief-scope',
      input: { ...run, history: [], fixedPrefix: [], systemPrompt: '静态系统', systemInMessages: true, extraReminder: '原有提醒' },
    }), {
      configuration: async () => ({ identity, source: 'qq', toolNames: [...businessTools, 'ask_user', 'call_tool'] }),
      discover: async ({ toolNames }) => toolNames.map(name => ({ name, schema: { type: 'object' } })),
      capabilities: { ...ports(), async catalog(names) {
        return { fixedAdapter: true, metadataOnly: false, toolCatalog: names.join('、'), skillCatalog: '', userSkills: [] }
      } },
      formatPrefix: ({ original }) => original.fixedPrefix,
    }, services)
    const signal = new AbortController().signal
    const first = await load(run, signal)
    businessTools = ['list_events']
    const second = await load(run, signal)
    if ('kind' in first || 'kind' in second) throw new Error('测试不应早退')
    const a = await prepareContext(first.input, services)
    const b = await prepareContext(second.input, services)
    expect(a.area.requestPrefix).toEqual(b.area.requestPrefix)
    expect(first.capabilities?.providerToolNames).toEqual(['call_tool', 'ask_user', 'shell'])
    expect(second.capabilities?.providerToolNames).toEqual(['call_tool', 'ask_user'])
    expect(first.input.latestToolSchemas?.map(tool => tool.tool_name)).toContain('shell')
    expect(second.input.latestToolSchemas?.map(tool => tool.tool_name)).not.toContain('shell')
    expect(stableJson(a.area.dynamicTail)).toContain('list_projects')
    expect(stableJson(a.area.dynamicTail)).toContain('合成本轮 Shell 状态')
    expect(stableJson(b.area.dynamicTail)).toContain('list_events')
    expect(stableJson(b.area.dynamicTail)).not.toContain('list_projects')
    expect(stableJson(b.area.dynamicTail)).toContain('原有提醒')
  })

  it.each([true, false])('定时任务标准准备不执行交互RAG或提交当前输入，Shell仅留system：%s', async systemInMessages => {
    const owner = { ownerId: '小北', sessionId: 'task-run-scope', runId: 'run-task' }
    const services = { digest: stableJson, nextId: () => 'entry-task' }
    const buildRag = vi.fn(async () => { throw new Error('定时任务不应调用交互RAG') })
    const loader = createCanonicalRunLoader(async () => ({
      modelIdentity: 'task-model', contextWindow: 1000, accessScopeHash: 'task-scope',
      input: { ...owner, history: [], fixedPrefix: [], systemPrompt: '任务静态规则', snapshotText: '任务快照', systemInMessages,
        currentUser: { message: { role: 'user', content: '本轮定时任务输入' } }, preparedRag: { tail: [{ role: 'user', content: '不能带入的交互RAG' }] } },
    }), {
      configuration: async () => ({ identity: { ownerId: owner.ownerId, subject: { kind: 'scheduled_task', id: 'task-1' }, workspaceId: 'workspace-1' }, source: 'scheduled', toolNames: ['shell'] }),
      discover: async () => [{ name: 'shell', schema: { type: 'object' } }], capabilities: ports(),
      formatPrefix: ({ snapshot }) => [{ role: 'system', content: `[system-reminder]\n${snapshot}\n[/system-reminder]` }],
    }, { ...services, buildRag })
    const loaded = await loader(owner, new AbortController().signal)
    if ('kind' in loaded) throw new Error('测试不应早退')
    const prepared = await prepareContext(loaded.input, { ...services, buildRag })
    expect(buildRag).not.toHaveBeenCalled()
    expect(loaded.capabilities?.subject?.subject).toEqual({ kind: 'scheduled_task', id: 'task-1' })
    expect(prepared.area.entries.find(entry => entry.source === 'user')?.persistencePolicy).toBe('request_only')
    expect(prepared.area.persistenceDelta('success').entries).toHaveLength(0)
    expect(stableJson(prepared.area.requestPrefix.filter(message => message.role !== 'system'))).not.toContain('Shell 状态')
    expect(stableJson(prepared.area.messages)).not.toContain('不能带入的交互RAG')
    expect(loaded.input.systemPrompt).toContain('合成本轮 Shell 状态')
    await expect(prepareContext({ ...loaded.input, history: [{ ...owner, id: 'old', conversationSeq: 1, role: 'user', content: '旧会话' }] }, { ...services, buildRag })).rejects.toThrow('不能继承')
  })
  it('独立发现和RAG召回同时开始，完成后返回各自结果', async () => {
    let started = false
    let release!: () => void
    const discovery = new Promise<void>((resolve) => { release = resolve })
    const result = await discoverToolsAndRecall({
      discover: async () => { started = true; await discovery; return ['synthetic-tool'] },
      recall: async () => { expect(started).toBe(true); release(); return { tail: [] } },
    })
    expect(result).toEqual({ tools: ['synthetic-tool'], rag: { tail: [] } })
  })

  it('自动RAG的LoopScope span保留实际注入消息，便于核对召回内容', async () => {
    const run: RunIdentity = { ownerId: 'owner-synthetic', sessionId: 'session-synthetic', runId: 'run-synthetic' }
    const observed: AgentObservation[] = []
    const rag = {
      tail: [{ role: 'user', content: [{ type: 'knowledge-context', text: '[owner-rag]\n[1] memory / 合成记忆\n合成召回正文' }] }],
      injected: true,
      scope_hits: [{ scope: 'owner-rag', candidate_count: 3, hit_count: 1 }],
    }
    await discoverToolsAndRecall({
      identity: run,
      observation: { record: event => observed.push(event) },
      discover: async () => [],
      recall: async () => rag,
    })
    const span = observed.find(event => event.name === 'Automatic RAG retrieval')
    expect(span?.output).toMatchObject({
      message_count: 1,
      rag_messages: rag.tail,
      injected: true,
      scope_hits: [{ scope: 'owner-rag', candidate_count: 3, hit_count: 1 }],
    })
  })

  it('一侧失败时取消并等待另一侧清理，保留真实失败供错误分类', async () => {
    const original = new Error('合成发现故障')
    let cleaned = false
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => { ready = resolve })
    await expect(discoverToolsAndRecall({
      discover: async () => { await waiting; throw original },
      recall: async (signal) => {
        ready()
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { cleaned = true; reject(new Error('合成取消')) }, { once: true })
        })
      },
    })).rejects.toBe(original)
    expect(cleaned).toBe(true)
  })

  it.each(['session', 'scheduled_task'] as const)('Shell状态仅在system，保留%s授权主体', async (kind) => {
    const service = ports()
    const seen: PreparationIdentity[] = []
    service.shellPolicy = async (subject) => { seen.push(subject); return { allowed: true, needsConfirmation: false } }
    service.shellState = async (subject) => { seen.push(subject); return '合成本轮 Shell 状态' }
    const subject = { ...identity, subject: { kind, id: kind === 'session' ? 'session-1' : 'task-1' } }
    const result = await prepareRunCapabilities({
      identity: subject, source: 'web', toolNames: ['shell'],
      system: '静态系统', snapshot: '冻结快照'
    }, service)
    expect(result.system).toContain('合成本轮 Shell 状态')
    expect(result.snapshot).toBe('冻结快照')
    expect(seen).toEqual([subject, subject])
  })

  it('无实时Shell状态时在目录生成前移除Shell，不用提示词替代授权', async () => {
    const service = ports()
    service.shellState = async () => null
    service.catalog = vi.fn(async () => null)
    const result = await prepareRunCapabilities({
      identity, source: 'web', toolNames: ['shell', 'read_file'],
      system: '静态系统', snapshot: '冻结快照'
    }, service)
    expect(result.toolNames).toEqual(['read_file'])
    expect(service.catalog).toHaveBeenCalledWith(['read_file'], identity, undefined, undefined, { query: '' })
    expect(result.system).toBe('静态系统')
  })

  it.each([['telegram', false], ['web', true]] as const)('按当前%s入口过滤present_file，不根据历史会话来源', async (source, allowed) => {
    const result = await prepareRunCapabilities({
      identity, source, toolNames: ['present_file', 'read_file'],
      system: '静态系统', snapshot: '冻结快照'
    }, ports())
    expect(result.toolNames.includes('present_file')).toBe(allowed)
  })

  it('完整Schema模式只把Skill目录追加snapshot；配置过滤不能扩大工具范围', async () => {
    const service = ports()
    service.catalog = async () => ({ metadataOnly: true, toolCatalog: '合成工具目录', skillCatalog: '合成技能目录', userSkills: [] })
    const input = { identity, source: 'web', toolNames: ['read_file'], system: '静态系统', snapshot: '冻结快照' }
    const result = await prepareRunCapabilities(input, service)
    expect(result.system).toBe('静态系统')
    expect(result.snapshot).toContain('合成技能目录')
    expect(result.snapshot).not.toContain('合成工具目录')
    service.filterConfigured = async () => ['shell']
    await expect(prepareRunCapabilities(input, service)).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('description模式工具目录只追加system，Skill目录只追加冻结snapshot', async () => {
    const service = ports()
    service.catalog = async () => ({ metadataOnly: false, toolCatalog: '合成工具目录', skillCatalog: '合成技能目录', userSkills: [] })
    const result = await prepareRunCapabilities({
      identity, source: 'web', toolNames: ['read_file'],
      system: '静态系统', snapshot: '冻结快照'
    }, service)
    expect(result.system).toBe('静态系统\n\n---\n\n合成工具目录')
    expect(result.snapshot).toBe('冻结快照\n\n---\n\n合成技能目录')
    expect(result.system).not.toContain('合成技能目录')
    expect(result.snapshot).not.toContain('合成工具目录')
  })

  it('能力目录阶段取消时端口接收同一signal并清理后才退出，不继续生成前缀', async () => {
    const service = ports()
    const controller = new AbortController()
    let cleaned = false
    service.catalog = async (_names, _owner, _tools, abort) => {
      expect(abort).toBe(controller.signal)
      return new Promise((_resolve, reject) => {
        abort!.addEventListener('abort', () => { cleaned = true; reject(abort!.reason) }, { once: true })
        controller.abort(new Error('合成取消'))
      })
    }
    await expect(prepareRunCapabilities({
      identity, source: 'web', toolNames: ['read_file'],
      system: '静态系统', snapshot: '冻结快照'
    }, service, controller.signal)).rejects.toThrow('合成取消')
    expect(cleaned).toBe(true)
  })
})
