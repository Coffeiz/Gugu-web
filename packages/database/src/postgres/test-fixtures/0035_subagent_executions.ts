import { subagentExecutionMigration } from '../../shared/subagent-executions.js'
import { definePostgresMigration } from '../runner.js'

export const subagentExecutions = definePostgresMigration({
  revision: '0035_subagent_executions',
  prerequisites: ['agent_subagent_sessions', 'agent_subagent_launches', 'agent_subagent_continuations'],
  tables: ['agent_subagent_executions'],
  sql: subagentExecutionMigration('bytea'),
})
