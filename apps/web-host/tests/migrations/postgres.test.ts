import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { assertImHostSchema } from '../../src/modules/im/gateway/host-settings.js'
import { checkDatabaseReadiness } from '../../src/database.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('空库统一迁移只读检查、整体回滚、串行落库并拒绝结构漂移', {
  skip: !url && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `migrations_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const state = async () => (await pool.query(`SELECT to_regclass('users') AS users,
      to_regclass('gugu_schema_migrations') AS ledger`)).rows[0]
    assert.equal(await migratePostgres(pool, 'check'), 'pending')
    assert.deepEqual(await state(), { users: null, ledger: null })

    await pool.query("CREATE TABLE knowledge_index_entries(value text); INSERT INTO knowledge_index_entries VALUES ('保留')")
    await assert.rejects(migratePostgres(pool, 'apply'), { code: 'incompatible', revision: '0011_rag_index' })
    assert.deepEqual(await state(), { users: null, ledger: null })
    assert.equal((await pool.query('SELECT value FROM knowledge_index_entries')).rows[0].value, '保留')
    await pool.query('DROP TABLE knowledge_index_entries')

    const concurrent = await Promise.all([migratePostgres(pool, 'apply'), migratePostgres(pool, 'apply')])
    assert.deepEqual(concurrent.sort(), ['applied', 'unchanged'])
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    await checkDatabaseReadiness(statement => pool.query(statement))
    await assertImHostSchema(pool)
    const jobs = await pool.query('SELECT mode, status, updated_at FROM data_import_jobs')
    assert.equal(jobs.rowCount, 0)
    assert.ok((await pool.query("SELECT to_regclass('project_undo_journals') AS journal")).rows[0].journal)

    const revision = '0004_agent_snapshots'
    const { rows: [entry] } = await pool.query('SELECT checksum FROM gugu_schema_migrations WHERE revision=$1', [revision])
    await pool.query("UPDATE gugu_schema_migrations SET checksum='伪造' WHERE revision=$1", [revision])
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision })
    await pool.query('UPDATE gugu_schema_migrations SET checksum=$1 WHERE revision=$2', [entry.checksum, revision])

    await pool.query('ALTER TABLE files DISABLE TRIGGER gugu_project_file_count_insert')
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision: '0002_web_domain' })
    await assert.rejects(migratePostgres(pool, 'apply'), { code: 'incompatible', revision: '0002_web_domain' })
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
