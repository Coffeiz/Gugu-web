import { createAgentSchemaMigration } from './agent-schema-migrate.js'
import { webDomainFunctions, webDomainSql, webDomainTables } from './web-domain-schema.js'

export const { apply: applyWebDomainMigration, check: checkWebDomainMigration } = createAgentSchemaMigration({
  ledger: 'gugu_node_web_domain_migrations',
  revision: 'web_domain_0001',
  sql: webDomainSql,
  tables: webDomainTables,
  functions: webDomainFunctions,
  prerequisites: ['users'],
  lockKey: ':gugu-web-domain-schema',
})
