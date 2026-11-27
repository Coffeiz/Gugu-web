import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { initialize } from '@gugu/database/postgres/migrations/0001_initialize'
import { webDomain } from '@gugu/database/postgres/migrations/0002_web_domain'
import { runPostgresMigrations } from '../../../../packages/database/src/postgres/runner.js'
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
    await assert.rejects(migratePostgres(pool, 'apply'), { code: 'incompatible', revision: '0000_baseline' })
    assert.deepEqual(await state(), { users: null, ledger: null })
    assert.equal((await pool.query('SELECT value FROM knowledge_index_entries')).rows[0].value, '保留')
    await pool.query('DROP TABLE knowledge_index_entries')

    const concurrent = await Promise.all([migratePostgres(pool, 'apply'), migratePostgres(pool, 'apply')])
    assert.deepEqual(concurrent.sort(), ['applied', 'unchanged'])
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    const removedSchema = await pool.query<{ folders: string | null; fileId: boolean; filePath: boolean; fileStorageKey: boolean; fileFolderId: boolean; workspaceFolderId: boolean; storageLimit: boolean }>(`
      SELECT to_regclass('folders')::text AS folders,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='id') AS "fileId",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='path') AS "filePath",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='storage_key') AS "fileStorageKey",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='folder_id') AS "fileFolderId",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workspaces' AND column_name='folder_id') AS "workspaceFolderId",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='storage_limit_bytes') AS "storageLimit"
    `)
    assert.deepEqual(removedSchema.rows[0], {
      folders: null, fileId: false, filePath: true, fileStorageKey: false, fileFolderId: false, workspaceFolderId: false, storageLimit: true,
    })
    assert.deepEqual((await pool.query(`SELECT a.attname AS column_name
      FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid='files'::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)`)).rows,
    [{ column_name: 'user_id' }, { column_name: 'path' }])
    const retainedQuotas = await pool.query<{ tokenLimits: boolean; searchLimit: boolean; tokenWindow: boolean }>(`
      SELECT
        (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users'
          AND column_name IN ('token_limit_monthly','token_limit_6h','token_limit_weekly')) AS "tokenLimits",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='search_limit_daily') AS "searchLimit",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='quota_window_started_at') AS "tokenWindow"
    `)
    assert.deepEqual(retainedQuotas.rows[0], { tokenLimits: true, searchLimit: true, tokenWindow: true })
    const restoredQuotaTables = await pool.query<{ ledgers: string | null; events: string | null }>(`
      SELECT to_regclass('storage_quota_ledgers')::text AS ledgers, to_regclass('storage_quota_events')::text AS events
    `)
    assert.deepEqual(restoredQuotaTables.rows[0], { ledgers: 'storage_quota_ledgers', events: 'storage_quota_events' })
    const owner = randomUUID()
    await pool.query('INSERT INTO users(id,username,email,hashed_password) VALUES ($1,$2,$3,$4)',
      [owner, `path-${owner}`, `${owner}@example.invalid`, 'synthetic'])
    const { rows: [project] } = await pool.query<{ id: number }>(
      `INSERT INTO projects(user_id,name,status,start_date,color,progress,stages_json,version,archived,created_at,updated_at)
       VALUES ($1,'路径项目','active','2026-11-01','#000000',0,'[]',1,false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`, [owner],
    )
    await pool.query(`INSERT INTO files(user_id,display_name,ext,space,project_id,path)
      VALUES ($1,'嵌套文件','txt','project',$2,$3)`, [owner, project!.id, `${owner}/项目文件/2026/11/路径项目 #${project!.id}/目录/文件.txt`])
    assert.equal((await pool.query<{ file_count: string }>(
      'SELECT file_count FROM project_file_counts WHERE project_id=$1', [project!.id],
    )).rows[0]?.file_count, '1')
    await pool.query('UPDATE files SET deleted_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND project_id=$2', [owner, project!.id])
    assert.equal((await pool.query('SELECT 1 FROM project_file_counts WHERE project_id=$1', [project!.id])).rowCount, 0)
    await checkDatabaseReadiness(statement => pool.query(statement))
    await assertImHostSchema(pool)
    const jobs = await pool.query('SELECT mode, status, updated_at FROM data_import_jobs')
    assert.equal(jobs.rowCount, 0)
    assert.ok((await pool.query("SELECT to_regclass('project_undo_journals') AS journal")).rows[0].journal)

    const revision = '0000_baseline'
    const { rows: [entry] } = await pool.query('SELECT checksum FROM gugu_schema_migrations WHERE revision=$1', [revision])
    await pool.query("UPDATE gugu_schema_migrations SET checksum='伪造' WHERE revision=$1", [revision])
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision })
    await pool.query('UPDATE gugu_schema_migrations SET checksum=$1 WHERE revision=$2', [entry.checksum, revision])

    const { rows: [constraint] } = await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='scheduled_tasks'::regclass AND conname='scheduled_tasks_execution_mode_check'")
    await pool.query('ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_execution_mode_check')
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision: '0000_baseline' })
    await pool.query(`ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_execution_mode_check ${constraint.definition}`)
    assert.equal(await migratePostgres(pool, 'check'), 'applied')

    await pool.query('ALTER TABLE files DISABLE TRIGGER gugu_project_file_count_insert')
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision: '0000_baseline' })
    await assert.rejects(migratePostgres(pool, 'apply'), { code: 'incompatible', revision: '0000_baseline' })
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})

test('拒绝旧迁移台账并保留既有数据', { skip: !url }, async () => {
  const schema = `legacy_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    assert.equal(await runPostgresMigrations(pool, 'apply', [initialize, webDomain]), 'applied')
    const owner = randomUUID()
    await pool.query("INSERT INTO users(id,username,email,hashed_password) VALUES($1,'synthetic','synthetic@example.test','synthetic')", [owner])
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible' })
    await assert.rejects(migratePostgres(pool, 'apply'), { code: 'incompatible' })
    assert.equal((await pool.query('SELECT id FROM users WHERE id=$1', [owner])).rows[0]?.id, owner)
    assert.deepEqual((await pool.query('SELECT revision FROM gugu_schema_migrations ORDER BY revision')).rows,
      [{ revision: '0001_initialize' }, { revision: '0002_web_domain' }])
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
