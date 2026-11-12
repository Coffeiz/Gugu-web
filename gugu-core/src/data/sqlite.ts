import { CompiledQuery, Kysely, SqliteDialect } from 'kysely'
import type { Driver } from 'kysely'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { CoreError, dataContext } from '../contracts/index.js'
import type { Clock } from './codec.js'
import { SqlDataRuntime } from './runtime.js'
import {
  CLIENT_COLUMNS,
  PROJECT_COLUMNS,
  RECEIPT_COLUMNS,
  SCHEMA_VERSION,
  tablesSql,
} from './schema.js'
import type { Database } from './schema.js'
import type SQLite from 'better-sqlite3'

async function driver(): Promise<typeof SQLite> {
  try {
    return (await import('better-sqlite3')).default
  } catch {
    throw new CoreError('storage_error', 'SQLite 驱动不可用，请检查匹配的运行时制品')
  }
}
class ImmediateDialect extends SqliteDialect {
  override createDriver(): Driver {
    const backend = super.createDriver()
    backend.beginTransaction = async (connection) => {
      await connection.executeQuery(CompiledQuery.raw('BEGIN IMMEDIATE'))
    }
    return backend
  }
}
function columns(db: SQLite.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[])
    .map((row) => row.name)
    .sort()
}
function matchColumns(db: SQLite.Database, table: string, expected: string[]): void {
  if (JSON.stringify(columns(db, table)) !== JSON.stringify([...expected].sort()))
    throw new CoreError('storage_error', '本地表结构不兼容，已拒绝自动修复')
}
function uniqueColumns(db: SQLite.Database, table: string, expected: string[]): void {
  const indexes = db.pragma(`index_list(${table})`) as {
    name: string
    unique: number
    partial: number
  }[]
  const found = indexes.some(
    (index) =>
      index.unique === 1 &&
      index.partial === 0 &&
      JSON.stringify(
        (
          db.pragma(`index_info("${index.name.replaceAll('"', '""')}")`) as {
            name: string
          }[]
        )
          .map((column) => column.name)
          .sort(),
      ) === JSON.stringify([...expected].sort()),
  )
  if (!found) throw new CoreError('storage_error', '本地唯一约束缺失，已拒绝自动修复')
}
function metadata(db: SQLite.Database): { owner: string; version: string } {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
  ).map((row) => row.name)
  if (!tables.includes('core_runtime_meta') || !tables.includes('projects'))
    throw new CoreError('storage_error', '此文件不是已初始化的 Core 数据库')
  const rows = db.prepare('SELECT key,value FROM core_runtime_meta').all() as {
    key: string
    value: string
  }[]
  if (
    ['owner_id', 'schema_version'].some(
      (key) => rows.filter((row) => row.key === key).length !== 1,
    )
  )
    throw new CoreError('storage_error', '本地数据库元数据缺失或重复')
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  let owner: string
  try {
    owner = dataContext(values.owner_id!).ownerId
  } catch {
    throw new CoreError('storage_error', '本地数据库身份缺失或损坏')
  }
  matchColumns(db, 'projects', PROJECT_COLUMNS)
  uniqueColumns(db, 'projects', ['user_id', 'idempotency_key'])
  if (values.schema_version !== '1') matchColumns(db, 'clients', CLIENT_COLUMNS)
  if (values.schema_version === SCHEMA_VERSION) {
    matchColumns(db, 'core_operation_receipts', RECEIPT_COLUMNS)
    uniqueColumns(db, 'core_operation_receipts', ['owner_id', 'operation_id'])
  }
  return { owner, version: values.schema_version! }
}
function pragmas(db: SQLite.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
}
export async function openSqliteRuntime(
  path: string,
  options: {
    allowLegacySchema?: boolean
    clock?: Clock
    exclusive?: boolean
  } = {},
): Promise<{
  runtime: SqlDataRuntime
  ownerId: string
  schemaVersion: string
}> {
  const Driver = await driver(),
    db = new Driver(resolve(path), { fileMustExist: true })
  try {
    pragmas(db)
    if (options.exclusive) {
      try {
        db.pragma('locking_mode = EXCLUSIVE')
        db.exec('BEGIN EXCLUSIVE; COMMIT')
      } catch {
        throw new CoreError('database_in_use', '数据库正由其他运行时使用，请先关闭其他实例')
      }
    }
    const info = metadata(db)
    if (
      info.version !== SCHEMA_VERSION &&
      !(options.allowLegacySchema && info.version === '2')
    )
      throw new CoreError(
        'schema_upgrade_required',
        '本地数据库需要显式迁移，请先备份并运行 migrate',
      )
    // Kysely 驱动延迟初始化；从未查询也要关闭预先打开的原生句柄。
    const runtime = new SqlDataRuntime(
      new Kysely<Database>({ dialect: new ImmediateDialect({ database: db }) }),
      'sqlite',
      options.clock,
      info.version === SCHEMA_VERSION,
      () => {
        if (db.open) db.close()
      },
    )
    return { runtime, ownerId: info.owner, schemaVersion: info.version }
  } catch (error) {
    db.close()
    throw error
  }
}
function createIndexes(db: SQLite.Database): void {
  db.exec(
    'CREATE INDEX ix_projects_user_id ON projects(user_id); CREATE INDEX ix_projects_deleted_at ON projects(deleted_at); CREATE INDEX ix_clients_user_id ON clients(user_id)',
  )
}
export async function initializeSqlite(path: string): Promise<void> {
  const target = resolve(path),
    parent = dirname(target),
    Driver = await driver()
  if (existsSync(target)) throw new CoreError('storage_error', '数据库已存在，已拒绝覆盖')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, '.core-initialize-')),
    temporary = join(directory, 'core.db')
  let db: SQLite.Database | undefined
  try {
    closeSync(openSync(temporary, 'wx', 0o600))
    db = new Driver(temporary)
    pragmas(db)
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal')
      throw new CoreError('storage_error', '本地数据库无法启用 WAL')
    db.exec('BEGIN IMMEDIATE')
    const schema = tablesSql('sqlite')
    db.exec(
      `${schema.projects}; ${schema.clients}; ${schema.receipts}; CREATE TABLE core_runtime_meta (key VARCHAR(50) PRIMARY KEY NOT NULL,value VARCHAR(100) NOT NULL);`,
    )
    createIndexes(db)
    const insert = db.prepare('INSERT INTO core_runtime_meta (key,value) VALUES (?,?)')
    insert.run('schema_version', SCHEMA_VERSION)
    insert.run('owner_id', randomUUID())
    db.exec('COMMIT')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    db = undefined
    // 完整文件发布前目标不可见；硬链接不覆盖已出现的用户文件。
    linkSync(temporary, target)
  } finally {
    db?.close()
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(temporary + suffix)) unlinkSync(temporary + suffix)
    rmdirSync(directory)
  }
}
export async function migrateSqlite(path: string): Promise<string> {
  const target = resolve(path),
    Driver = await driver(),
    db = new Driver(target, { fileMustExist: true })
  let backup: string | undefined
  try {
    pragmas(db)
    db.exec('BEGIN IMMEDIATE')
    const info = metadata(db)
    if (!['1', '2'].includes(info.version))
      throw new CoreError('schema_upgrade_required', '只支持版本 1 或 2 的显式升级')
    if (info.version === '1' && columns(db, 'clients').length)
      throw new CoreError('storage_error', '本地表结构不兼容，已拒绝自动修复')
    backup = join(
      dirname(target),
      `${basename(target)}.backup-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}.db`,
    )
    const source = new Driver(target, { readonly: true, fileMustExist: true })
    try {
      await source.backup(backup)
    } finally {
      source.close()
    }
    const checked = new Driver(backup, { fileMustExist: true })
    try {
      if (checked.pragma('integrity_check', { simple: true }) !== 'ok')
        throw new CoreError('storage_error', '数据库备份完整性验证失败')
      // 备份必须可独立恢复，不能遗留依赖其 WAL/SHM 的备份制品。
      checked.pragma('journal_mode = DELETE')
    } finally {
      checked.close()
    }
    const schema = tablesSql('sqlite')
    if (info.version === '1') {
      db.exec(schema.clients)
      db.exec('CREATE INDEX ix_clients_user_id ON clients(user_id)')
    }
    db.exec(schema.receipts)
    db.prepare("UPDATE core_runtime_meta SET value=? WHERE key='schema_version'").run(
      SCHEMA_VERSION,
    )
    db.exec('COMMIT')
    return backup
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
