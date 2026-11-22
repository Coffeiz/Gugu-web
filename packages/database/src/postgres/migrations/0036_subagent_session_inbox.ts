import { subagentSessionInboxIndexes } from '../../shared/subagent-deliveries.js'
import { definePostgresMigration } from '../runner.js'

export const subagentSessionInbox = definePostgresMigration({
  revision: '0036_subagent_session_inbox',
  prerequisites: ['agent_subagent_deliveries', 'agent_inbox_messages'],
  tables: [],
  sql: subagentSessionInboxIndexes,
})
