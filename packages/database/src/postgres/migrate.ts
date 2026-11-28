import type { Pool } from 'pg'
import type { MigrationAction } from '../shared/command.js'
import { postgresBaselineSql, postgresBaselineTables, postgresBaselineFunctions } from '../migrations/baseline/postgres-schema.js'
import { conversationRoleSequenceIndex } from '../migrations/0049_conversation_role_sequence.js'
import { logicalMigrations } from '../migrations/catalog.js'
import { compileLogicalMigrations, type LogicalMigration } from '../migrations/plan.js'
import { definePostgresMigration, runPostgresMigrations } from './runner.js'

const baseline = definePostgresMigration({
  revision: '0000_baseline',
  sql: postgresBaselineSql,
  tables: postgresBaselineTables,
  functions: postgresBaselineFunctions,
  downstreamIndexes: [conversationRoleSequenceIndex],
  downstreamStages: [{ revision: '0052_contact_address', addedFields: ['clients.address'] }],
})

export const checkPostgresBaseline = baseline.check

export function definePostgresLogicalMigrations(items: readonly LogicalMigration[]) {
  return compileLogicalMigrations('postgres', items).map(item => definePostgresMigration({
    revision: item.id, sql: item.checksumInput, statements: item.statements,
    tables: item.tables ?? [], createdObjects: item.createdObjects,
    indexes: item.indexes, prerequisites: item.prerequisites,
  }))
}

const shared = definePostgresLogicalMigrations(logicalMigrations)

export function migratePostgres(pool: Pick<Pool, 'connect'>, action: MigrationAction) {
  return runPostgresMigrations(pool, action, [baseline, ...shared])
}

export { PostgresMigrationError } from './runner.js'

/** 宿主管理独立迁移目录。连接的当前 schema 决定迁移账本所在位置。 */
export { definePostgresMigration, runPostgresMigrations }
