import { Pool } from 'pg'
import { applyAgentSnapshotMigration, checkAgentSnapshotMigration } from './agent-snapshot-migrate.js'

async function main() {
  const command = process.argv[2]
  const connectionString = process.env.GUGU_WEBUI_DATABASE_URL?.trim()
  if (!['check', 'apply'].includes(command ?? '') || process.argv.length !== 3 || !connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) throw new Error('迁移命令或数据库配置无效')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const result = command === 'check' ? await checkAgentSnapshotMigration(pool) : await applyAgentSnapshotMigration(pool)
    process.stdout.write(`${result}\n`)
    if (result === 'pending') process.exitCode = 2
  } finally { await pool.end() }
}
main().catch(() => { process.stderr.write('Node 迁移操作失败\n'); process.exitCode = 1 })
