import { createHash } from 'node:crypto'
import type SQLite from 'better-sqlite3'
import { logicalMigrations } from '../migrations/catalog.js'
import { compileLogicalMigrations, type LogicalMigration } from '../migrations/plan.js'
import type { MigrationAction, MigrationStatus } from '../shared/command.js'
import { DatabaseError } from '../shared/error.js'

const ledger = 'gugu_logical_migrations'

export function migrateSqliteLogical(db: SQLite.Database, action: MigrationAction,
  catalog: readonly LogicalMigration[] = logicalMigrations): MigrationStatus {
  const plans = compileLogicalMigrations('sqlite', catalog)
  const definition = (name: string) => (db.prepare(
    'SELECT type, sql FROM main.sqlite_schema WHERE name=?').get(name) as { type: string; sql: string | null } | undefined)
  const fingerprint = (migration: LogicalMigration) => {
    const objects = [...(migration.tables ?? []), ...(migration.indexes ?? []), ...(migration.triggers ?? [])].map(definition)
    if (objects.some(object => !object?.sql))
      throw new DatabaseError('schema_upgrade_required', 'SQLite 逻辑迁移管理的对象不存在')
    return createHash('sha256').update(JSON.stringify(objects)).digest('hex')
  }
  const run = () => {
    const ledgerColumns = db.pragma('main.table_info(gugu_logical_migrations)') as { name: string }[]
    const legacyLedger = ledgerColumns.map(column => column.name).join(',') === 'id,checksum'
    if (legacyLedger) {
      const entries = db.prepare('SELECT id, checksum FROM main.gugu_logical_migrations ORDER BY id').all() as { id: string; checksum: string }[]
      for (const [index, entry] of entries.entries()) {
        const plan = plans[index]
        const indexName = plan?.indexes?.[0]
        const statement = plan?.statements[0]
        if (!plan || entry.id !== '0049_conversation_role_sequence' || plan.id !== entry.id
          || plan.checksum !== entry.checksum || !indexName || !statement
          || definition(indexName)?.sql?.replace(/^CREATE INDEX /u, 'create index ') !== statement.sql)
          throw new DatabaseError('schema_upgrade_required', 'SQLite 旧迁移记录或索引结构不兼容')
      }
      if (action === 'check') return 'pending'
      db.exec("ALTER TABLE main.gugu_logical_migrations ADD COLUMN definition_hash TEXT NOT NULL DEFAULT ''")
      const update = db.prepare('UPDATE main.gugu_logical_migrations SET definition_hash=? WHERE id=?')
      for (const [index, entry] of entries.entries()) update.run(fingerprint(plans[index]!), entry.id)
    }
    const applied = definition(ledger)
      ? db.prepare('SELECT id, checksum, definition_hash AS definitionHash FROM main.gugu_logical_migrations ORDER BY id').all() as { id: string; checksum: string; definitionHash: string }[]
      : []
    for (const [index, entry] of applied.entries()) {
      const plan = plans[index]
      if (!plan || plan.id !== entry.id || plan.checksum !== entry.checksum
        || entry.definitionHash !== fingerprint(plan))
        throw new DatabaseError('schema_upgrade_required', 'SQLite 逻辑迁移记录或结构不兼容')
    }
    const pending = plans.slice(applied.length)
    if (action === 'check') return pending.length ? 'pending' : 'applied'
    if (!pending.length) return legacyLedger ? 'applied' : 'unchanged'
    db.exec('CREATE TABLE IF NOT EXISTS main.gugu_logical_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, definition_hash TEXT NOT NULL)')
    for (const migration of pending) {
      if (migration.prerequisites?.some(name => !definition(name)))
        throw new DatabaseError('schema_upgrade_required', 'SQLite 逻辑迁移缺少依赖对象')
      for (const { sql, parameters } of migration.statements) db.prepare(sql).run(...parameters)
      db.prepare('INSERT INTO main.gugu_logical_migrations(id,checksum,definition_hash) VALUES(?,?,?)').run(migration.id, migration.checksum, fingerprint(migration))
    }
    return 'applied'
  }
  const transaction = db.transaction(run)
  return action === 'apply' ? transaction.immediate() : transaction.deferred()
}
