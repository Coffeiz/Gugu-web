import { createAgentSchemaMigration } from './agent-schema-migrate.js'
import { agentBaseSql, agentBaseTables } from './agent-base-schema.js'
import { agentRunPrerequisiteIndexes } from './agent-run-schema.js'

export const { check: checkAgentBaseMigration, apply: applyAgentBaseMigration } = createAgentSchemaMigration({
  ledger: 'gugu_node_agent_base_migrations',
  revision: 'agent_base_0001',
  sql: agentBaseSql,
  tables: agentBaseTables,
  downstreamIndexes: agentRunPrerequisiteIndexes,
  lockKey: ':gugu-agent-base-schema',
})
