import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { initializeSqlite, migrateSqlite, migrateSqliteLogical } from '@gugu/database/sqlite'
import { loadSqliteDriver } from '@gugu/database/sqlite/driver'
import { definePostgresLogicalMigrations } from '../../../../packages/database/src/postgres/migrate.js'
import { runPostgresMigrations } from '../../../../packages/database/src/postgres/runner.js'
import { conversationRoleSequenceIndex as index } from '../../../../packages/database/src/migrations/0049_conversation_role_sequence.js'
import type { LogicalMigration } from '../../../../packages/database/src/migrations/plan.js'

const sample: LogicalMigration = {
  id: '9000_sample',
  targets: ['postgres', 'sqlite'],
  tables: ['sample_shared'],
  build: db => [db.schema.createTable('sample_shared').addColumn('id', 'integer')],
  after: { postgres: db => [db.schema.alterTable('sample_shared').addColumn('pg_only', 'integer')] },
}
const broken: LogicalMigration = {
  ...sample,
  build: db => [...sample.build(db), db.schema.createTable('sample_shared').addColumn('id', 'integer')],
}

test('SQLite 共同迁移覆盖建库、旧库升级、结构校验和事务重试', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-logical-migration-'))
  const path = join(dir, 'database.sqlite')
  const Driver = await loadSqliteDriver()
  try {
    assert.equal(await migrateSqlite(path, 'check'), 'pending')
    await initializeSqlite(path)
    assert.equal(await migrateSqlite(path, 'check'), 'applied')
    const db = new Driver(path)
    try {
      db.exec(`DROP TRIGGER rag_snapshot_insert;
        DROP TRIGGER rag_snapshot_update;
        DROP TRIGGER rag_snapshot_delete;
        DROP TRIGGER rag_snapshot_owner_update;
        DROP TABLE rag_snapshot_generations;
        DROP TABLE agent_chat_receipts;
        DELETE FROM gugu_logical_migrations WHERE id >= '0050_agent_chat_receipts'`)
    } finally { db.close() }
    assert.equal(await migrateSqlite(path, 'check'), 'pending')
    assert.equal(await migrateSqlite(path, 'apply'), 'applied')
    assert.equal(await migrateSqlite(path, 'apply'), 'unchanged')
    const triggers = new Driver(path)
    try {
      const definition = (triggers.prepare("SELECT sql FROM sqlite_schema WHERE name='rag_snapshot_delete'").get() as { sql: string }).sql
      triggers.exec('DROP TRIGGER rag_snapshot_delete')
      await assert.rejects(migrateSqlite(path, 'check'), /结构不兼容|对象不存在/)
      triggers.exec(definition)
    } finally { triggers.close() }
    const reopened = new Driver(path)
    try {
      reopened.exec(`DROP INDEX ${index}; CREATE INDEX ${index} ON conversation_messages(role)`)
    } finally { reopened.close() }
    await assert.rejects(migrateSqlite(path, 'check'), /结构不兼容/)

    const fixture = new Driver(':memory:')
    try {
      assert.throws(() => migrateSqliteLogical(fixture, 'apply', [broken]))
      assert.deepEqual(fixture.prepare('SELECT name FROM sqlite_schema').all(), [])
      assert.equal(migrateSqliteLogical(fixture, 'apply', [sample]), 'applied')
      assert.deepEqual(fixture.pragma('table_info(sample_shared)').map((column: { name: string }) => column.name), ['id'])
    } finally { fixture.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('PostgreSQL 共同迁移保留历史校验，并验证引擎步骤和事务回滚', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `logical_${randomUUID().replaceAll('-', '')}`
  const fixture = `${schema}_fixture`
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const scratch = new Pool({ connectionString: url, options: `-c search_path=${fixture}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE SCHEMA "${fixture}"`)
    assert.equal(await migratePostgres(pool, 'check'), 'pending')
    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    await pool.query("DROP TABLE agent_chat_receipts; DELETE FROM gugu_schema_migrations WHERE revision='0050_agent_chat_receipts'")
    assert.equal(await migratePostgres(pool, 'check'), 'pending')
    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    assert.equal(await migratePostgres(pool, 'apply'), 'unchanged')
    await pool.query(`DROP INDEX ${index}; CREATE INDEX ${index} ON conversation_messages(role)`)
    await assert.rejects(migratePostgres(pool, 'check'), /结构不兼容/)

    const run = (item: LogicalMigration) => runPostgresMigrations(scratch, 'apply', definePostgresLogicalMigrations([item]))
    await assert.rejects(run(broken), /迁移失败/)
    const empty = await scratch.query("SELECT to_regclass('sample_shared') AS sample, to_regclass('gugu_schema_migrations') AS ledger")
    assert.deepEqual(empty.rows[0], { sample: null, ledger: null })
    assert.equal(await run(sample), 'applied')
    const columns = await scratch.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sample_shared' ORDER BY ordinal_position")
    assert.deepEqual(columns.rows, [{ column_name: 'id' }, { column_name: 'pg_only' }])
  } finally {
    await pool.end()
    await scratch.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${fixture}" CASCADE`)
    await admin.end()
  }
})
