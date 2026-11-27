import type { Pool } from 'pg'
import { createWebAgentContextBuilder, type AgentContextBuilderPorts, type ContextDataPorts, type ContextSourcePorts } from '@gugu/core/agent'
import type { PreferenceTextFiles } from '@gugu/core'
import { createAgentPreferenceContextSources } from './preferences.js'
import { createAgentOverviewSources } from './overview.js'
import { createWebAgentSourceLoader } from './source.js'
import { createAgentMemoryContextLoader, type AgentMemoryVectorSearchFactory } from '../memory/context.js'

type ExternalData = Pick<ContextDataPorts, 'loadImChannels' | 'loadImMemory' | 'loadKnowledge'>
export interface AgentContextAssemblyOptions {
  pool: Pick<Pool, 'query' | 'connect'>
  files: Pick<PreferenceTextFiles, 'read'>
  memoryStorageRoot: string
  memoryVectorSearch?: AgentMemoryVectorSearchFactory
  redis: { get(key: string): Promise<string | null> }
  serverTimezone: string
  now(): number
  digest: ContextSourcePorts['digest']
  nextId: ContextSourcePorts['nextId']
  select: ContextSourcePorts['select']
  currentTurn: ContextSourcePorts['currentTurn']
  external: ExternalData
  builder: Omit<AgentContextBuilderPorts, 'dynamic'> & { now(): number }
}

/** 所有未迁入的业务源必须由 Host 明确提供，不构造空值替代。 */
export function createAgentContextSources(options: Omit<AgentContextAssemblyOptions, 'digest' | 'nextId' | 'select' | 'currentTurn'>) {
  for (const fn of [options.external?.loadImChannels, options.external?.loadImMemory, options.external?.loadKnowledge, options.builder?.now, options.builder?.staticPrompt, options.builder?.sessionInfo, options.builder?.systemInMessages])
    if (typeof fn !== 'function') throw new TypeError('Agent 上下文服务未完整配置')
  if (!options.memoryStorageRoot.trim()) throw new TypeError('Agent 记忆存储根目录未配置')
  const preference = createAgentPreferenceContextSources(options.pool, options.files, options.redis, options.serverTimezone)
  const overview = createAgentOverviewSources(options.pool, options.memoryStorageRoot, () => new Date(options.now()))
  return {
    skillDataRoot: options.memoryStorageRoot,
    now: options.now, currentRevision: preference.currentRevision,
    data: { ...overview, loadTimezone: preference.loadTimezone, loadStylePreferences: preference.loadStylePreferences,
      ...options.external, loadMemory: createAgentMemoryContextLoader(options.memoryStorageRoot, options.now, options.memoryVectorSearch) },
    builder: createWebAgentContextBuilder(options.builder),
  }
}

/** 重建器使用相同的数据来源，但自行绑定每个租约的身份和消息锚点。 */
export function createAgentContextAssembly(options: AgentContextAssemblyOptions) {
  if (typeof options.select !== 'function' || typeof options.currentTurn !== 'function') throw new TypeError('Agent 上下文服务未完整配置')
  return createWebAgentSourceLoader(options.pool, {
    ...createAgentContextSources(options), digest: options.digest, nextId: options.nextId,
    select: options.select, currentTurn: options.currentTurn,
  }, undefined, options.memoryStorageRoot)
}
