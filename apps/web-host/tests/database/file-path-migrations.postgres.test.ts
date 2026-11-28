import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { initialize } from '../../../../packages/database/src/postgres/migrations/0001_initialize.js'
import { webDomain } from '../../../../packages/database/src/postgres/migrations/0002_web_domain.js'
import { runPostgresMigrations } from '../../../../packages/database/src/postgres/runner.js'
import { migratePostgres } from '../../../../packages/database/src/postgres/migrate.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('路径迁移移除旧目录和文件 ID，保留文件、工作区、回收站及文件配额', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件路径迁移回归',
}, async () => {
  const schema = `gugu_file_paths_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = '11111111-1111-4111-8111-111111111111'

  try {
    await runPostgresMigrations(pool, 'apply', [initialize, webDomain])
    await pool.query(
      `INSERT INTO users(id,username,email,hashed_password)
       VALUES($1,'path-migration-test','path-migration@example.invalid','test-hash')`, [ownerId],
    )
    const directory = await pool.query<{ id: number }>(
      `INSERT INTO workspace_directories(user_id,name,directory_name) VALUES($1,'工作区','workspace') RETURNING id`,
      [ownerId],
    )
    const folder = await pool.query<{ id: number }>(
      `INSERT INTO folders(user_id,name) VALUES($1,'旧目录') RETURNING id`, [ownerId],
    )
    const activePath = `${ownerId}/个人文件/旧目录/笔记.txt`
    const trashPath = `${ownerId}/trash/旧目录/已删除.txt`
    const activeFile = await pool.query<{ id: number }>(
      `INSERT INTO files(user_id,display_name,ext,folder_id,storage_key)
       VALUES($1,'笔记','txt',$2,$3) RETURNING id`, [ownerId, folder.rows[0]!.id, activePath],
    )
    await pool.query(
      `INSERT INTO files(user_id,display_name,ext,folder_id,storage_key,deleted_at)
       VALUES($1,'已删除','txt',$2,$3,CURRENT_TIMESTAMP)`, [ownerId, folder.rows[0]!.id, trashPath],
    )
    await pool.query(`INSERT INTO workspaces(user_id,name,kind,directory_id) VALUES($1,'有效工作区','directory',$2)`,
      [ownerId, directory.rows[0]!.id])
    await pool.query(`INSERT INTO workspaces(user_id,name,kind,folder_id) VALUES($1,'旧目录工作区','folder',$2)`,
      [ownerId, folder.rows[0]!.id])
    const fileId = activeFile.rows[0]!.id
    await pool.query(
      `INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,
         before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at)
       VALUES('op-path-migration',$1,'tab','group-path-migration','files','update','[]'::json,
         $2::json,$2::json,'{}'::json,'{}'::json,'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 day')`,
      [ownerId, JSON.stringify({ items: { [`file:${fileId}`]: { storage_key: activePath } } })],
    )

    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    assert.equal(await migratePostgres(pool, 'check'), 'applied')

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name IN ('files','workspaces','users')`, [schema],
    )
    const columnSet = new Set(columns.rows.map(row => `${row.table_name}.${row.column_name}`))
    assert.equal(columnSet.has('files.id'), false)
    assert.equal(columnSet.has('files.folder_id'), false)
    assert.equal(columnSet.has('files.storage_key'), false)
    assert.equal(columnSet.has('workspaces.folder_id'), false)
    assert.equal(columnSet.has('users.storage_limit_bytes'), true)
    assert.equal((await pool.query(`SELECT to_regclass($1) AS name`, [`${schema}.folders`])).rows[0]?.name, null)
    for (const table of ['storage_quota_ledgers', 'storage_quota_events'])
      assert.equal((await pool.query(`SELECT to_regclass($1) AS name`, [`${schema}.${table}`])).rows[0]?.name, table)

    const files = await pool.query<{ path: string; deleted_at: Date | null }>(
      `SELECT path,deleted_at FROM files WHERE user_id=$1 ORDER BY path`, [ownerId],
    )
    const fileStates = new Map(files.rows.map(row => [row.path, row.deleted_at !== null]))
    assert.equal(fileStates.get(activePath), false)
    assert.equal(fileStates.get(trashPath), true)
    assert.equal(fileStates.size, 2)
    const primaryKey = await pool.query<{ columns: string }>(
      `SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text AS columns
       FROM pg_constraint constraint_row
       CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY key(attnum,ordinality)
       JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=key.attnum
       WHERE constraint_row.conrelid='files'::regclass AND constraint_row.contype='p'`,
    )
    assert.equal(primaryKey.rows[0]?.columns, '{user_id,path}')

    const workspaces = await pool.query<{ name: string }>(
      `SELECT name FROM workspaces WHERE user_id=$1 ORDER BY name`, [ownerId],
    )
    assert.deepEqual(workspaces.rows.map(row => row.name), ['有效工作区'])
    await pool.query('UPDATE users SET storage_limit_bytes=123456 WHERE id=$1', [ownerId])
    await pool.query(`INSERT INTO storage_quota_ledgers(user_id,category,limit_bytes,used_bytes)
      VALUES($1,'personal',123456,17)`, [ownerId])
    await pool.query(`INSERT INTO storage_quota_events(user_id,category,operation,delta_bytes,idempotency_key)
      VALUES($1,'personal','upload',17,'path-migration-test')`, [ownerId])
    assert.equal(Number((await pool.query(`SELECT storage_limit_bytes FROM users WHERE id=$1`, [ownerId])).rows[0]?.storage_limit_bytes), 123456)
    const quota = await pool.query<{ limit_bytes: string; used_bytes: string }>(
      `SELECT limit_bytes,used_bytes FROM storage_quota_ledgers WHERE user_id=$1 AND category='personal'`, [ownerId],
    )
    assert.deepEqual([Number(quota.rows[0]?.limit_bytes), Number(quota.rows[0]?.used_bytes)], [123456, 17])
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM storage_quota_events WHERE user_id=$1`, [ownerId])).rows[0]?.count, 1)

    const undo = await pool.query<{ before_state: { items: Record<string, { path?: string; storage_key?: string }> } }>(
      `SELECT before_state FROM undo_operations WHERE id='op-path-migration'`,
    )
    const snapshot = undo.rows[0]?.before_state.items[`file:${fileId}`]
    assert.equal(snapshot?.path, activePath)
    assert.equal(snapshot?.storage_key, undefined)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})

test('完整 PostgreSQL 迁移链可复查且文件表只保留路径', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行完整隔离 PostgreSQL 迁移回归',
}, async () => {
  const schema = `gugu_file_path_catalog_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })

  try {
    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    const fields = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name IN ('files','workspaces','users')`, [schema],
    )
    const present = new Set(fields.rows.map(field => `${field.table_name}.${field.column_name}`))
    for (const field of ['files.id', 'files.folder_id', 'files.storage_key', 'workspaces.folder_id'])
      assert.equal(present.has(field), false, field)
    for (const field of ['files.path', 'users.storage_limit_bytes']) assert.equal(present.has(field), true, field)
    assert.equal((await pool.query(`SELECT to_regclass($1) AS name`, [`${schema}.folders`])).rows[0]?.name, null)
    for (const table of ['storage_quota_ledgers', 'storage_quota_events'])
      assert.equal((await pool.query(`SELECT to_regclass($1) AS name`, [`${schema}.${table}`])).rows[0]?.name, table, table)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
