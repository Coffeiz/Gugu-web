import { createAgentSchemaMigration } from './agent-schema-migrate.js'
import { agentRunPrerequisiteIndexes, agentRunSql, agentRunTables } from './agent-run-schema.js'

export { AgentSchemaMigrationError as AgentRunMigrationError } from './agent-schema-migrate.js'

export const { check: checkAgentRunMigration, apply: applyAgentRunMigration } = createAgentSchemaMigration({
  ledger: 'gugu_node_agent_run_migrations',
  revision: 'agent_run_0001',
  sql: agentRunSql,
  tables: agentRunTables,
  indexes: agentRunPrerequisiteIndexes,
  prerequisites: ['users', 'conversation_sessions', 'conversation_messages', 'interaction_prompts'],
  lockKey: ':gugu-agent-run-schema',
})
