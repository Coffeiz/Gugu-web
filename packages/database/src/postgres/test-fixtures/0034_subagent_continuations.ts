import { subagentContinuationSchema } from '../../shared/subagent-continuations.js'
import { definePostgresMigration } from '../runner.js'

export const subagentContinuations = definePostgresMigration({
  revision: '0034_subagent_continuations',
  prerequisites: ['agent_subagent_conversations', 'agent_subagent_launches'],
  tables: ['agent_subagent_continuations', 'agent_subagent_execution_sessions', 'agent_subagent_execution_launches'],
  sql: subagentContinuationSchema('bytea').replaceAll('CREATE VIEW IF NOT EXISTS', 'CREATE VIEW'),
})
