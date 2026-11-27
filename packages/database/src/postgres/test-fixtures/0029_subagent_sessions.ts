import { subagentSessionSchema } from '../../shared/subagent-sessions.js'
import { definePostgresMigration } from '../runner.js'

export const subagentSessions = definePostgresMigration({
  revision: '0029_subagent_sessions',
  prerequisites: ['conversation_sessions', 'agent_subagent_deliveries'],
  tables: ['agent_subagent_sessions'],
  sql: subagentSessionSchema,
})
