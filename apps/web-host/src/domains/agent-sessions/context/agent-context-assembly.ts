import type { Pool } from 'pg'
import type { ContextDataPorts, ContextSourcePorts } from '@gugu/core/agent'
import type { PreferenceTextFiles } from '../../preferences/persistence/personality-files.js'
import { createAgentPreferenceContextSources } from './agent-context-preferences.js'
import { createAgentOverviewSources } from './agent-overview-postgres.js'
import { createAgentContextBuilder, type AgentContextBuilderPorts } from './agent-context-builder.js'
import { createWebAgentSourceLoader } from './agent-context-source.js'

type ExternalData = Pick<ContextDataPorts, 'loadMemory' | 'loadImChannels' | 'loadImMemory' | 'loadKnowledge'>
export interface AgentContextAssemblyOptions {
  pool: Pick<Pool, 'query' | 'connect'>
  files: Pick<PreferenceTextFiles, 'read'>
  redis: { get(key: string): Promise<string | null> }
  serverTimezone: string
  now(): number
  digest: ContextSourcePorts['digest']
  nextId: ContextSourcePorts['nextId']
  select: ContextSourcePorts['select']
  currentTurn: ContextSourcePorts['currentTurn']
  external: ExternalData
  builder: AgentContextBuilderPorts
}

/** 所有未迁入的业务源必须由 Host 明确提供，不构造空值替代。 */
export function createAgentContextAssembly(options: AgentContextAssemblyOptions) {
  for (const fn of [options.external?.loadMemory, options.external?.loadImChannels, options.external?.loadImMemory, options.external?.loadKnowledge, options.select, options.currentTurn, options.builder?.dynamic, options.builder?.staticPrompt, options.builder?.sessionInfo, options.builder?.systemInMessages])
    if (typeof fn !== 'function') throw new TypeError('Agent 上下文服务未完整配置')
  const preference = createAgentPreferenceContextSources(options.pool, options.files, options.redis, options.serverTimezone)
  const overview = createAgentOverviewSources(options.pool, () => new Date(options.now()))
  return createWebAgentSourceLoader(options.pool, {
    now: options.now, digest: options.digest, nextId: options.nextId,
    select: options.select, currentTurn: options.currentTurn, currentRevision: preference.currentRevision,
    data: { ...overview, loadTimezone: preference.loadTimezone, loadStylePreferences: preference.loadStylePreferences, ...options.external },
    builder: createAgentContextBuilder(options.builder),
  })
}
