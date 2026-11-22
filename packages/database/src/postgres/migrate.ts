import { subagentExecutions } from './migrations/0035_subagent_executions.js'
import { subagentContinuations } from './migrations/0034_subagent_continuations.js'
import type { Pool } from 'pg'
import type { MigrationAction } from '../shared/command.js'
import { initialize } from './migrations/0001_initialize.js'
import { webDomain } from './migrations/0002_web_domain.js'
import { agentRun } from './migrations/0003_agent_run.js'
import { agentSnapshots } from './migrations/0004_agent_snapshots.js'
import { filesystemAuthorization } from './migrations/0005_filesystem_authorization.js'
import { securityEvents } from './migrations/0006_security_events.js'
import { terminalSessions } from './migrations/0007_terminal_sessions.js'
import { interactionActions } from './migrations/0008_interaction_actions.js'
import { trashPurge } from './migrations/0009_trash_purge.js'
import { searchUsage } from './migrations/0010_search_usage.js'
import { ragIndex } from './migrations/0011_rag_index.js'
import { agentReasoning } from './migrations/0012_agent_reasoning.js'
import { imGateway } from './migrations/0013_im_gateway.js'
import { imReflection } from './migrations/0014_im_reflection.js'
import { dataPortability } from './migrations/0015_data_portability.js'
import { providerCredentials } from './migrations/0016_provider_credentials.js'
import { mcp } from './migrations/0017_mcp.js'
import { fileSync } from './migrations/0018_file_sync.js'
import { accountRecords } from './migrations/0019_account_records.js'
import { memory } from './migrations/0020_memory.js'
import { byokBindings } from './migrations/0021_byok_bindings.js'
import { scheduledTaskMode } from './migrations/0022_scheduled_task_mode.js'
import { calendarReminderMode } from './migrations/0023_calendar_reminder_mode.js'
import { webPush } from './migrations/0024_web_push.js'
import { webReflection } from './migrations/0025_web_reflection.js'
import { reflectionCompaction } from './migrations/0026_reflection_compaction.js'
import { imPrivateStreaming } from './migrations/0027_im_private_streaming.js'
import { subagentDeliveries } from './migrations/0028_subagent_deliveries.js'
import { subagentSessions } from './migrations/0029_subagent_sessions.js'
import { subagentLaunches } from './migrations/0030_subagent_launches.js'
import { subagentWaits } from './migrations/0031_subagent_waits.js'
import { subagentConversations } from './migrations/0033_subagent_conversations.js'
import { agentInbox } from './migrations/0032_agent_inbox.js'
import { runPostgresMigrations } from './runner.js'

const catalog = [
  initialize, webDomain, agentRun, agentSnapshots, filesystemAuthorization, securityEvents,
  terminalSessions, interactionActions, trashPurge, searchUsage, ragIndex,
  agentReasoning, imGateway, imReflection, dataPortability, providerCredentials, mcp, fileSync, accountRecords, memory, byokBindings, scheduledTaskMode, calendarReminderMode, webPush, webReflection, reflectionCompaction, imPrivateStreaming, subagentDeliveries, subagentSessions, subagentLaunches, subagentWaits, agentInbox, subagentConversations, subagentContinuations, subagentExecutions,
]

export function migratePostgres(pool: Pick<Pool, 'connect'>, action: MigrationAction) {
  return runPostgresMigrations(pool, action, catalog)
}

export { PostgresMigrationError } from './runner.js'
