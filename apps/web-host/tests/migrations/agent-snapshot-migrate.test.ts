import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PoolClient } from 'pg'
import { applyAgentSnapshotMigration, checkAgentSnapshotMigration } from '@gugu/database/postgres/migrations/0004_agent_snapshots'

test('隔离 PostgreSQL：只读检查、并发迁移、重复执行与真实结构拒绝', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
  const { Pool: PgPool } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL!
  const schema = `snapshot_migration_${randomUUID().replaceAll('-', '')}`
  const admin = new PgPool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new PgPool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL,role text NOT NULL);
      CREATE TABLE agent_run_dispatch(user_id uuid NOT NULL,session_id integer NOT NULL,run_id varchar(128) NOT NULL,message_id integer NOT NULL,UNIQUE(user_id,session_id,run_id))`)
    assert.equal(await checkAgentSnapshotMigration(pool), 'pending')
    assert.equal((await pool.query("SELECT to_regclass('gugu_schema_migrations') AS name")).rows[0].name, null)
    const outcomes = await Promise.all([applyAgentSnapshotMigration(pool), applyAgentSnapshotMigration(pool)])
    assert.deepEqual(outcomes.sort(), ['applied', 'unchanged'])
    assert.equal(await checkAgentSnapshotMigration(pool), 'applied')
    assert.equal(await applyAgentSnapshotMigration(pool), 'unchanged')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_schema_migrations')).rows[0].n, 1)
    await pool.query('ALTER TABLE gugu_agent_snapshot_chunks DROP CONSTRAINT gugu_agent_snapshot_chunks_ordinal_check')
    await assert.rejects(checkAgentSnapshotMigration(pool), { code: 'incompatible' })
    await assert.rejects(applyAgentSnapshotMigration(pool), { code: 'incompatible' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_schema_migrations')).rows[0].n, 1)
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() }
  }
})

test('隔离 PostgreSQL：冲突导致事务回滚且保留原有对象', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
  const { Pool: PgPool } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL!
  const schema = `snapshot_conflict_${randomUUID().replaceAll('-', '')}`
  const admin = new PgPool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new PgPool({ connectionString: url, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL,role text NOT NULL);
      CREATE TABLE agent_run_dispatch(user_id uuid NOT NULL,session_id integer NOT NULL,run_id varchar(128) NOT NULL,message_id integer NOT NULL,UNIQUE(user_id,session_id,run_id));
      CREATE TABLE sentinel(original text); INSERT INTO sentinel VALUES ('保留')`)
    let injected = false
    const faultPool = { async connect() {
      const client = await pool.connect()
      return {
        async query(sql: string, values?: unknown[]) {
          const marker = 'CREATE TABLE gugu_agent_snapshot_chunks'
          if (sql.includes(marker)) {
            const prefix = sql.slice(0, sql.indexOf(marker))
            await client.query(prefix)
            injected = true
            return client.query('CREATE TABLE gugu_agent_snapshot_chunks (value gugu_nonexistent_type)')
          }
          return client.query(sql, values)
        },
        release() { client.release() },
      } as unknown as PoolClient
    } } as unknown as Pick<Pool, 'connect'>
    await assert.rejects(applyAgentSnapshotMigration(faultPool), error =>
      error instanceof Error && 'code' in error && error.code === 'unavailable'
      && !error.message.includes('gugu_nonexistent_type'))
    assert.equal(injected, true)
    assert.equal((await pool.query('SELECT original FROM sentinel')).rows[0].original, '保留')
    assert.equal((await pool.query("SELECT to_regclass('gugu_agent_snapshot_manifest') AS name")).rows[0].name, null)
    assert.equal((await pool.query("SELECT to_regclass('gugu_schema_migrations') AS name")).rows[0].name, null)
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() }
  }
})
