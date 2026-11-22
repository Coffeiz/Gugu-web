import { agentInboxSchema } from '../../shared/agent-inbox.js'
import { definePostgresMigration } from '../runner.js'

export const agentInbox = definePostgresMigration({
  revision: '0032_agent_inbox',
  prerequisites: ['agent_subagent_deliveries'],
  tables: ['agent_inbox_messages', 'agent_inbox_waits'],
  indexes: ['agent_inbox_pending'],
  sql: agentInboxSchema('bytea'),
})
