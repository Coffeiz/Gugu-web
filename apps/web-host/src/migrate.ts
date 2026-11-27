import { Pool } from 'pg'
import { createPostgresPool } from '@gugu/database/postgres/pool'
import { PostgresMigrationError, migratePostgres } from '@gugu/database/postgres'
import { parseMigrationAction, reportMigration } from '@gugu/database/command'

try {
  const action = parseMigrationAction(process.argv.slice(2))
  const connectionString = process.env.GUGU_WEBUI_DATABASE_URL?.trim()
  if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString))
    throw new Error('数据库配置无效')
  const pool = createPostgresPool(Pool, { connectionString, max: 1 })
  try {
    reportMigration(await migratePostgres(pool, action))
  } finally {
    await pool.end()
  }
} catch (error) {
  process.stderr.write(`${new Date().toISOString()} ${(error instanceof PostgresMigrationError ? error.message : '迁移命令或数据库配置无效')}\n`)
  process.exitCode = 1
}
