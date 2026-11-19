import type { Pool } from 'pg'
import { createWebAgentContextBuilder, type AgentContextBuilderPorts } from '@gugu/core/agent'
import { createAgentOverviewSources } from '../agent-sessions/context/agent-overview-postgres.js'
import { createAgentPreferenceContextSources } from '../agent-sessions/context/agent-context-preferences.js'
import { createAgentImChannelLoader, type AgentImPlatform } from '../agent-sessions/context/agent-im-channels.js'
import { createLocalPreferenceTextFiles } from '../../modules/preferences/persistence/personality-files.js'
import { createLocalAgentKnowledgeReadStore } from '../agent-sessions/tools/agent-rag-knowledge-store.js'
import { createAgentKnowledgeOverviewLoader } from '../agent-sessions/tools/agent-knowledge.js'
import { createAgentMemoryContextLoader } from '../agent-sessions/memory-context.js'

export function createWebScheduledTaskContextSources(options: {
  pool: Pick<Pool, 'query'>
  storageRoot: string
  redis: { get(key: string): Promise<string | null> }
  serverTimezone: string
  now(): number
  imPlatformEnabled(platform: AgentImPlatform): boolean | Promise<boolean>
  staticPrompt: AgentContextBuilderPorts['staticPrompt']
}) {
  const { pool, storageRoot, redis, serverTimezone, now } = options
  const kind = 'scheduled_task'
  const preferences = createAgentPreferenceContextSources(pool, createLocalPreferenceTextFiles(storageRoot), redis, serverTimezone, kind)
  const { loadProjects, loadEvents, loadFilesOverview } = createAgentOverviewSources(pool, () => new Date(now()), kind)
  return {
    now,
    data: {
      loadProjects, loadEvents, loadFilesOverview,
      loadTimezone: preferences.loadTimezone,
      loadStylePreferences: preferences.loadStylePreferences,
      loadMemory: createAgentMemoryContextLoader(storageRoot, now),
      loadKnowledge: createAgentKnowledgeOverviewLoader(createLocalAgentKnowledgeReadStore(storageRoot)),
      loadImChannels: createAgentImChannelLoader({ pool, redis, subject: kind, enabled: options.imPlatformEnabled }),
    },
    builder: createWebAgentContextBuilder({
      now,
      staticPrompt: options.staticPrompt,
      sessionInfo: () => ({}),
      systemInMessages: () => false,
    }, null),
  }
}
