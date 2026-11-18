import { Pool } from 'pg'
import { applyAgentBaseMigration, checkAgentBaseMigration } from './agent-base-migrate.js'
import { applyAgentRunMigration, checkAgentRunMigration } from './agent-run-migrate.js'
import { AgentSchemaMigrationError } from './agent-schema-migrate.js'

import { applyWebDomainMigration, checkWebDomainMigration } from './web-domain-migrate.js'
import { applyFilesystemAuthorizationMigration, checkFilesystemAuthorizationMigration } from './filesystem-authorization-migrate.js'
import { applySecurityEventsMigration, checkSecurityEventsMigration } from './security-events-migrate.js'
import { applyTerminalSessionsMigration, checkTerminalSessionsMigration } from './terminal-sessions-migrate.js'

const commands = new Map<string, (pool: Pool) => Promise<'pending' | 'applied' | 'unchanged'>>([
  ['web-check', checkWebDomainMigration],
  ['web-apply', applyWebDomainMigration],
  ['base-check', checkAgentBaseMigration],
  ['base-apply', applyAgentBaseMigration],
  ['filesystem-authorization-check', checkFilesystemAuthorizationMigration],
  ['filesystem-authorization-apply', applyFilesystemAuthorizationMigration],
  ['security-events-check', checkSecurityEventsMigration],
  ['security-events-apply', applySecurityEventsMigration],
  ['terminal-sessions-check', checkTerminalSessionsMigration],
  ['terminal-sessions-apply', applyTerminalSessionsMigration],
  ['check', checkAgentRunMigration],
  ['apply', applyAgentRunMigration],
])

async function main() {
  const migrate = commands.get(process.argv[2] ?? '')
  const connectionString = process.env.GUGU_WEBUI_DATABASE_URL?.trim()
  if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString) || process.argv.length !== 3 || !migrate)
    throw new Error('迁移命令或数据库配置无效')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const result = await migrate(pool)
    process.stdout.write(result + '\n')
    if (result === 'pending') process.exitCode = 2
  } finally { await pool.end() }
}

main().catch(error => {
  process.stderr.write(error instanceof AgentSchemaMigrationError ? error.message + '\n' : 'Agent 运行迁移命令或数据库配置无效\n')
  process.exitCode = 1
})
