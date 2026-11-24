import type { Pool } from 'pg'
import { createWebAgentContextBuilder, type AgentContextBuilderPorts } from '@gugu/core/agent'
import { createAgentOverviewSources } from '../../agent/context/overview.js'
import { createAgentPreferenceContextSources } from '../../agent/context/preferences.js'
import { createAgentImChannelLoader, type AgentImPlatform } from '../../agent/context/channels.js'
import { createLocalPreferenceTextFiles } from '../../preferences/persistence/personality-files.js'
import { createLocalAgentKnowledgeReadStore } from '../../agent/rag/knowledge.js'
import { createAgentKnowledgeOverviewLoader } from '../../agent/tools/knowledge/list.js'
import { createAgentMemoryContextLoader, type AgentMemoryVectorSearchFactory } from '../../agent/memory/context.js'

export function createWebScheduledTaskContextSources(options: {
  pool: Pick<Pool, 'query'>
  storageRoot: string
  redis: { get(key: string): Promise<string | null> }
  serverTimezone: string
  now(): number
  imPlatformEnabled(platform: AgentImPlatform): boolean | Promise<boolean>
  memoryVectorSearch?: AgentMemoryVectorSearchFactory
  staticPrompt: AgentContextBuilderPorts['staticPrompt']
}) {
  const { pool, storageRoot, redis, serverTimezone, now } = options
  const kind = 'scheduled_task'
  const preferences = createAgentPreferenceContextSources(pool, createLocalPreferenceTextFiles(storageRoot), redis, serverTimezone, kind)
  const { loadProjects, loadEvents, loadFilesOverview } = createAgentOverviewSources(pool, storageRoot, () => new Date(now()), kind)
  return {
    now,
    loadGroupStyle: preferences.loadGroupStyle,
    data: {
      loadProjects, loadEvents, loadFilesOverview,
      loadTimezone: preferences.loadTimezone,
      loadStylePreferences: preferences.loadStylePreferences,
      loadMemory: createAgentMemoryContextLoader(storageRoot, now, options.memoryVectorSearch),
      loadKnowledge: createAgentKnowledgeOverviewLoader(createLocalAgentKnowledgeReadStore(storageRoot)),
      loadImChannels: createAgentImChannelLoader({ pool, redis, subject: kind, enabled: options.imPlatformEnabled }),
    },
    builder: createWebAgentContextBuilder({
      now,
      staticPrompt: options.staticPrompt,
      sessionInfo: () => ({}),
      systemInMessages: () => false,
    }, null, { includeScopedContext: true }),
  }
}
