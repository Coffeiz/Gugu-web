import { createAgentRagContextBuilder } from '#core-source/agent/rag/context-builder.js'
import { createImMemoryContextSource } from '#core-source/im/memory-source.js'
import { desktopImGroupRunEvent } from '#core-source/im/desktop-inbox.js'
import type { ImActor } from '#core-source/im/access.js'
import { imCanUseGroupOwnerMemory } from '#core-source/agent/scenes/im/index.js'
import { desktopGroupMemoryContext } from './im-memory-context.js'
import type { AgentRuntimeOptions } from '#core-source/agent/runtime.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import type { DesktopMemoryFiles } from '#core-source/agent/memory/desktop-files.js'
import type { RagQueryEmbeddingSettings } from '#core-source/agent/rag/query-embedding.js'
import type { NodeProviderTransportOptions } from '#core-source/agent/providers/transport/node.js'
import type { createLocalPreferenceTextFiles } from '#core-source/preferences/text-files.js'
import { formatBuiltinSkillIndex, type BuiltinSkillDefinition } from '#core-source/agent/skills/builtin.js'
import { assembleSubagentCatalog, builtinSubagentCatalog } from '#core-source/agent/context/modules/subagent-catalog.js'
import { mcpServiceReminder } from '#core-source/mcp/tool-directory.js'
import { projectToolCatalog } from '#core-source/agent/capabilities/brief.js'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { CoreError, dataContext } from '#core-source/contracts/index.js'
import type { Json, RunIdentity, PreparedToolDefinition, ContextSourceSelection, CanonicalMessage } from '#core-source/agent/models.js'
import type { AgentObservationPort } from '#core-source/agent/observation.js'
import type { ContextSourcePorts } from '#core-source/agent/ports.js'
import { createSqliteAgentMemoryRagVectors, readSqliteAgentMemory } from '#core-source/agent/memory/sqlite.js'
import type { createAgentKnowledgeOverview } from '#core-source/agent/knowledge/overview.js'
import { formatSqliteAgentOverview, readSqliteAgentOverviewData, readSqliteAgentStylePreferences, type SqliteAgentOverviewData } from '#core-source/agent/context/sqlite-overview.js'
import { appendWorkspaceAgentInstructions, formatAgentMemory } from '#core-source/agent/context/prompt-format.js'
import { createCanonicalSourceLoader, readSessionSnapshot } from '#core-source/agent/context/prepare.js'
import { buildFixedRequestPrefix } from '#core-source/agent/context/assemble.js'
import { agentContextSnapshotPrefix } from '#core-source/agent/context/builder.js'
import { formatGroupMemory, formatPlatformUserMemory } from '#core-source/im/memory-context.js'

interface DesktopContextState {
  boundIdentity: RunIdentity | undefined
  overviewData: SqliteAgentOverviewData | undefined
  ownerMemory: Awaited<ReturnType<typeof readSqliteAgentMemory>>['memory'] | undefined
  stylePreferences: Record<string, Json>
  filesOverview: Record<string, Json>
  imChannels: Record<string, boolean> | undefined
  memoryRevision: string | number
  contextRevision: number
  timezone: string
  systemPrompt: string
}

export function createDesktopContextState(boundIdentity: RunIdentity | undefined): DesktopContextState {
  return {
    boundIdentity,
    overviewData: undefined,
    ownerMemory: undefined,
    stylePreferences: {},
    filesOverview: {},
    imChannels: undefined,
    memoryRevision: 0,
    contextRevision: 0,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    systemPrompt: '',
  }
}

export function createDesktopContextSource(options: {
  ownerId: string
  groupChat: boolean
  contextState: DesktopContextState
  selection: Awaited<ReturnType<ContextSourcePorts['select']>>
  sessionSource: Pick<ContextSourcePorts, 'historyReader' | 'readSnapshot' | 'currentTurn'>
  authorizeContext: (identity: { ownerId: string; sessionId: string }) => Promise<boolean>
  readDesktopImMemory: (identity: RunIdentity, signal?: AbortSignal) => Promise<{ data: Json }>
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  readKnowledgeOverview: ReturnType<typeof createAgentKnowledgeOverview>
  digest: (value: unknown) => string
  buildSystemPrompt: (preferences: Record<string, Json>) => string
  observation: AgentObservationPort | undefined
}) {
  const { ownerId, groupChat, contextState, selection, sessionSource, authorizeContext, readDesktopImMemory,
    hostRequest, readKnowledgeOverview, digest, buildSystemPrompt, observation } = options
  const contextBuilder: ContextSourcePorts['builder'] = {
    buildSnapshot: data => {
      const preferences = data.stylePreferences && typeof data.stylePreferences === 'object' && !Array.isArray(data.stylePreferences)
        ? data.stylePreferences as Record<string, Json> : {}
      if (groupChat) {
        const snapshotContext = formatGroupMemory(data.imMemory)
        contextState.systemPrompt = buildSystemPrompt(contextState.stylePreferences)
        return { systemPrompt: contextState.systemPrompt, snapshotContext, sessionInfo: { stylePreferences: contextState.stylePreferences }, userTimezone: data.userTimezone, locale: selection.locale }
      }
      if (!contextState.overviewData || !contextState.ownerMemory) throw new CoreError('conflict', '桌面 Agent 上下文尚未准备')
      const knowledgeRows = Array.isArray(data.knowledge)
        ? data.knowledge.filter((item): item is Record<string, Json> => !!item && typeof item === 'object' && !Array.isArray(item))
        : []
      const snapshotContext = formatSqliteAgentOverview(contextState.overviewData, formatAgentMemory(contextState.ownerMemory, Date.now()), contextState.filesOverview, knowledgeRows, contextState.imChannels)
      contextState.systemPrompt = buildSystemPrompt(preferences)
      return { systemPrompt: contextState.systemPrompt, snapshotContext, sessionInfo: { stylePreferences: preferences }, userTimezone: data.userTimezone, locale: selection.locale }
    },
    buildRequest: snapshot => {
      const info = snapshot.sessionInfo && typeof snapshot.sessionInfo === 'object' && !Array.isArray(snapshot.sessionInfo)
        ? snapshot.sessionInfo as Record<string, Json> : {}
      const preferences = info.stylePreferences && typeof info.stylePreferences === 'object' && !Array.isArray(info.stylePreferences)
        ? info.stylePreferences as Record<string, Json> : {}
      return {
        systemPrompt: buildSystemPrompt(preferences), systemInMessages: false,
        fixedPrefix: snapshot.snapshotContext ? agentContextSnapshotPrefix(snapshot.snapshotContext) : [],
      }
    },
  }
  const source = createCanonicalSourceLoader({
    ...sessionSource, digest, nextId: randomUUID, now: Date.now,
    select: async () => selection,
    currentRevision: async identity => {
      if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取上下文版本')
      return contextState.contextRevision
    },
    data: {
      loadTimezone: async () => contextState.timezone, loadImMemory: async (identity, signal) => {
        if (!await authorizeContext(identity) || !contextState.boundIdentity)
          throw new CoreError('conflict', '当前运行无权读取群组记忆')
        return (await readDesktopImMemory(contextState.boundIdentity, signal)).data
      },
      loadProjects: async identity => { if (!await authorizeContext(identity) || !contextState.overviewData) throw new CoreError('conflict', '项目上下文未准备'); return contextState.overviewData.projects },
      loadEvents: async identity => { if (!await authorizeContext(identity) || !contextState.overviewData) throw new CoreError('conflict', '日历上下文未准备'); return contextState.overviewData.events },
      loadNotes: async identity => { if (!await authorizeContext(identity) || !contextState.overviewData) throw new CoreError('conflict', '笔记上下文未准备'); return contextState.overviewData.notes },
      loadFilesOverview: async (identity, signal) => {
        if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取文件概览')
        const overview: unknown = await hostRequest('agent.files.overview', {}, signal)
        if (!overview || typeof overview !== 'object' || Array.isArray(overview))
          throw new CoreError('storage_error', '桌面文件概览无效')
        const value = overview as Record<string, unknown>
        if (!Number.isSafeInteger(value.total) || (value.total as number) < 0
          || !Array.isArray(value.folders) || !Array.isArray(value.files)
          || typeof value.partial !== 'boolean')
          throw new CoreError('storage_error', '桌面文件概览无效')
        const { trash: _desktopTrash, ...desktopOverview } = value
        contextState.filesOverview = desktopOverview as Record<string, Json>
        contextState.contextRevision = Number.parseInt(digest([contextState.memoryRevision, contextState.overviewData, contextState.filesOverview, contextState.stylePreferences, contextState.imChannels, contextState.timezone]).slice(0, 12), 16)
        return contextState.filesOverview
      }, loadStylePreferences: async identity => {
        if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取回复风格')
        contextState.contextRevision = Number.parseInt(digest([contextState.memoryRevision, contextState.overviewData, contextState.filesOverview, contextState.stylePreferences, contextState.imChannels, contextState.timezone]).slice(0, 12), 16)
        return contextState.stylePreferences
      },
      loadImChannels: async identity => {
        if (!await authorizeContext(identity) || !contextState.imChannels) throw new CoreError('conflict', '当前运行无权读取 IM 渠道')
        return contextState.imChannels
      },
      loadMemory: async identity => {
        if (!await authorizeContext(identity) || !contextState.ownerMemory) throw new CoreError('conflict', '当前运行无权读取个人记忆')
        return contextState.ownerMemory
      },
      loadKnowledge: async (identity, signal) => {
        if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取知识概览')
        try {
          const entries = await readKnowledgeOverview(ownerId, signal)
          contextState.contextRevision = Number.parseInt(digest([contextState.memoryRevision, contextState.overviewData, contextState.filesOverview, contextState.stylePreferences, entries, contextState.imChannels, contextState.timezone]).slice(0, 12), 16)
          return entries.map(item => ({ title: item.title, topic: item.topic, description: item.description }) as Json)
        } catch {
          signal?.throwIfAborted()
          return []
        }
      },
    },
    builder: contextBuilder,
  }, observation)
  return { source, contextBuilder }
}

export function createDesktopRunContextLoader(options: {
  db: SqlDataRuntime['db']
  ownerId: string
  contextState: DesktopContextState
  selection: ContextSourceSelection & { contextScopeKey: string }
  source: ReturnType<typeof createCanonicalSourceLoader>
  contextBuilder: ContextSourcePorts['builder']
  sessionSource: Pick<ContextSourcePorts, 'currentTurn'>
  privateImChat: boolean
  groupChat: boolean
  canDelegate: boolean
  desktopPrivateImOwner: (identity: RunIdentity, signal?: AbortSignal) => Promise<unknown>
  authorizeContext: (identity: RunIdentity) => Promise<boolean>
  readImChannels: (signal?: AbortSignal) => Promise<Record<string, boolean>>
  readMemberReminder: (identity: RunIdentity, signal?: AbortSignal) => Promise<CanonicalMessage[]>
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  preferenceFiles: ReturnType<typeof createLocalPreferenceTextFiles>
  preferences: unknown
  embedding: RagQueryEmbeddingSettings | undefined
  memoryFiles: DesktopMemoryFiles | undefined
  resolveProxy: NodeProviderTransportOptions['resolveProxy']
  recordMemoryRevision: (revision: string | number) => void
  buildSystemPrompt: (preferences: Record<string, Json>, skillIndex?: string) => string
  sceneBuiltins: BuiltinSkillDefinition[]
  configuredTools: (identity: RunIdentity) => Promise<PreparedToolDefinition[]>
  groupSkillRegistry: { catalog(identity: RunIdentity): Promise<readonly { id: string }[]> }
  loadMailPrompt: (identity: RunIdentity, signal?: AbortSignal) => Promise<string>
  readMcpServices: (ownerId: string) => Promise<Parameters<typeof mcpServiceReminder>[0]>
  digest: (value: unknown) => string
}) {
  const { db, ownerId, contextState, selection, source, contextBuilder, sessionSource, privateImChat, groupChat, canDelegate,
    desktopPrivateImOwner, authorizeContext, readImChannels, readMemberReminder, hostRequest, preferenceFiles,
    preferences, embedding, memoryFiles, resolveProxy, recordMemoryRevision, buildSystemPrompt, sceneBuiltins,
    configuredTools, groupSkillRegistry, loadMailPrompt, readMcpServices, digest } = options
  const load: AgentRuntimeOptions['context']['load'] = async (identity, signal) => {
    contextState.boundIdentity = identity
    if (privateImChat && !await desktopPrivateImOwner(identity, signal))
      throw new CoreError('conflict', 'IM 私聊绑定已变更')
    if (groupChat) {
      contextState.stylePreferences = await readSqliteAgentStylePreferences(db, identity, signal, preferenceFiles, true)
      if (contextState.stylePreferences.group_personality_preference_enabled) {
        const fingerprint = digest(contextState.stylePreferences)
        contextState.contextRevision = Number.parseInt(fingerprint.slice(0, 12), 16)
        selection.contextScopeKey = `desktop-im-group:${fingerprint}`
      }
      const loaded = await source.load(identity, signal)
      const tools = await configuredTools(identity)
      const visibleSkills = new Set((await groupSkillRegistry.catalog(identity)).map(skill => skill.id))
      contextState.systemPrompt = buildSystemPrompt(contextState.stylePreferences, formatBuiltinSkillIndex(sceneBuiltins.filter(skill => visibleSkills.has(skill.id)), false))
      const memberReminder = await readMemberReminder(identity, signal)
      return { ...loaded, capabilities: { toolNames: tools.map(tool => tool.name), tools },
        input: { ...loaded.input, systemPrompt: contextState.systemPrompt, fixedPrefix: [...loaded.input.fixedPrefix, ...memberReminder] } }
    }
    const turn = await sessionSource.currentTurn(identity, signal)
    const { memory, revision } = await readSqliteAgentMemory(db, ownerId, turn.currentUser?.rawText ?? '', signal, embedding, memoryFiles, resolveProxy)
    recordMemoryRevision(revision)
    contextState.ownerMemory = memory
    contextState.memoryRevision = revision
    contextState.overviewData = await readSqliteAgentOverviewData(db, identity, contextState.timezone, signal)
    contextState.stylePreferences = await readSqliteAgentStylePreferences(db, identity, signal, preferenceFiles)
    if (selection.contextPolicy.loadOwnerContext) {
      if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取 IM 渠道')
      contextState.imChannels = await readImChannels(signal)
    }
    const mailPrompt = await loadMailPrompt(identity, signal)
    contextState.contextRevision = Number.parseInt(digest([revision, mailPrompt, contextState.overviewData, contextState.filesOverview, contextState.stylePreferences, contextState.imChannels, contextState.timezone]).slice(0, 12), 16)
    const loaded = await source.load(identity, signal)
    const directoryId = selection.workspaceBinding?.directory_id
    if (typeof directoryId === 'string') {
      const instructions = await hostRequest('agent.files.workspaceInstructions', { directoryId }, signal)
      signal?.throwIfAborted()
      if (typeof instructions === 'string')
        loaded.input.systemPrompt = appendWorkspaceAgentInstructions(loaded.input.systemPrompt ?? '', instructions)
    }
    const tools = await configuredTools(identity)
    const toolNames = tools.map(tool => tool.name)
    if (canDelegate && toolNames.includes('agent_message')) {
      loaded.input.systemPrompt = assembleSubagentCatalog(loaded.input.systemPrompt, builtinSubagentCatalog)
    }
    const mcpReminder = ['search_tools', 'call_tool'].every(name => toolNames.includes(name))
      ? mcpServiceReminder(await readMcpServices(identity.ownerId)) : ''
    const { capabilities, visible } = projectToolCatalog(preferences, tools, mcpReminder)
    return { ...loaded, capabilities, input: {
      ...loaded.input, ...(capabilities.toolReminder ? { toolReminder: capabilities.toolReminder } : {}),
      latestToolSchemas: visible.map(tool => ({
        type: 'tool-schema' as const, tool_name: tool.name, schema_digest: digest(tool.schema), schema: tool.schema,
      })),
    } }
  }
  const prepareRequest: NonNullable<AgentRuntimeOptions['context']['prepareRequest']> = async (identity, signal, context) => {
    const snapshot = context?.sourceEffects?.sessionSnapshot.state
    if (!snapshot) throw new Error('运行缺少会话快照')
    const prepared = contextBuilder.buildRequest(readSessionSnapshot(snapshot), selection, identity)
    const prefix = buildFixedRequestPrefix(prepared)
    const memberReminder = groupChat ? await readMemberReminder(identity, signal) : []
    const legacy = { prefix, dynamicTail: memberReminder }
    if (memberReminder.length && context.prepared.requestPrefixSize === prefix.length
      && context.prepared.requestDigest === digest(legacy)) return legacy
    return { prefix: [...prefix, ...memberReminder], dynamicTail: [] }
  }
  return { load, prepareRequest }
}

export function createDesktopImContext(options: {
  db: SqlDataRuntime['db']
  ownerId: string
  groupChat: boolean
  memoryFiles: DesktopMemoryFiles | undefined
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
}) {
  const { db, ownerId, groupChat, memoryFiles, hostRequest } = options
  async function readDesktopImMemory(identity: RunIdentity, signal?: AbortSignal): Promise<{ actor: ImActor | null; data: Json; groupOwnerMemoryEnabled: boolean }> {
    if (!groupChat || !memoryFiles) return { actor: null, data: {}, groupOwnerMemoryEnabled: false }
    signal?.throwIfAborted()
    const receipt = await desktopImGroupRunEvent(db, identity)
    if (!receipt) return { actor: null, data: {}, groupOwnerMemoryEnabled: false }
    const resolve = async () => desktopGroupMemoryContext(await hostRequest('agent.im.readGroupMemoryContext', { ...receipt, ownerId }, signal), ownerId)
    const initial = await resolve()
    if (!initial) return { actor: null, data: {}, groupOwnerMemoryEnabled: false }
    const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
    const source = createImMemoryContextSource({
      identity, actor: initial.actor,
      async authorize() {
        const current = await resolve()
        if (!current || current.botId !== initial.botId || current.chatId !== initial.chatId
          || current.platformUserId !== initial.platformUserId || current.actor.role !== initial.actor.role
          || current.actor.verifiedOwner !== initial.actor.verifiedOwner) return null
        return current
      },
      readText: (scope, filename) => memoryFiles.readImScope(scope, filename),
      async isTombstoned(scope) {
        const { rows } = await sql`SELECT 1 AS id FROM desktop_im_memory_tombstones
          WHERE owner_id=${owner} AND platform=${scope.platform} AND bot_id=${scope.bot_id}
            AND scope_type=${scope.scope_type} AND scope_id=${scope.scope_id} LIMIT 1`.execute(db)
        return rows.length > 0
      },
    })
    const data = await source.loadImMemory(identity, signal)
    return { actor: initial.actor, data, groupOwnerMemoryEnabled: initial.groupOwnerMemoryEnabled }
  }
  async function readMemberReminder(identity: RunIdentity, signal?: AbortSignal) {
    const memory = await readDesktopImMemory(identity, signal)
    const personal = memory.actor?.role === 'member' ? formatPlatformUserMemory(memory.data) : ''
    return personal ? [{ role: 'user' as const, content: `[system-reminder]\n${personal}\n[/system-reminder]` }] : []
  }
  return { readDesktopImMemory, readMemberReminder }
}

export function createDesktopContextRag(options: {
  core: SqlDataRuntime
  contextState: DesktopContextState
  contextPolicy: ContextSourceSelection['contextPolicy']
  groupChat: boolean
  embedding: RagQueryEmbeddingSettings | undefined
  memoryFiles: DesktopMemoryFiles | undefined
  resolveProxy: NodeProviderTransportOptions['resolveProxy']
  readDesktopImMemory: ReturnType<typeof createDesktopImContext>['readDesktopImMemory']
  authorize: (identity: RunIdentity) => Promise<boolean>
  onRecallFinished: () => void
}) {
  const { core, contextState, contextPolicy, groupChat, embedding, memoryFiles, resolveProxy,
    readDesktopImMemory, authorize, onRecallFinished } = options
  const { db } = core
  let ragBinding: { runId: string; build: ReturnType<typeof createAgentRagContextBuilder> } | undefined
  return async function buildRag(input: Parameters<ReturnType<typeof createAgentRagContextBuilder>>[0], signal?: AbortSignal) {
    const identity = contextState.boundIdentity
    if (!identity || identity.ownerId !== input.ownerId || identity.sessionId !== input.sessionId)
      return { tail: [], injected: false, reason: 'identity_unavailable' }
    if (ragBinding?.runId !== identity.runId) {
      ragBinding = {
        runId: identity.runId,
        build: createAgentRagContextBuilder({
          core, identity,
          enabled: async (candidate, ragSignal) => {
            if (candidate.runId !== identity.runId || !await authorize(candidate)) return false
            if (contextPolicy.loadOwnerContext) return true
            if (!groupChat) return false
            const current = await readDesktopImMemory(candidate, ragSignal)
            return current.actor !== null && imCanUseGroupOwnerMemory(current.actor, current.groupOwnerMemoryEnabled)
          },
          ...(embedding ? { vectors: owner => createSqliteAgentMemoryRagVectors(db, owner, embedding, memoryFiles, resolveProxy) } : {}),
          authorize: async (candidate, scope, authSignal) => {
            authSignal?.throwIfAborted()
            if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId
              || candidate.runId !== identity.runId || scope.scope_type !== 'owner' || (scope.scope_id ?? '') !== '') return false
            const allowed = await authorize(candidate)
            authSignal?.throwIfAborted()
            if (!allowed) return false
            if (contextPolicy.loadOwnerContext) return true
            if (!groupChat) return false
            const current = await readDesktopImMemory(candidate, authSignal)
            return current.actor !== null && imCanUseGroupOwnerMemory(current.actor, current.groupOwnerMemoryEnabled)
          },
        }),
      }
    }
    try {
      return await ragBinding.build(input, signal)
    } finally {
      onRecallFinished()
    }
  }
}
