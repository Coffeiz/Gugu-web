import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { applyAgentSnapshotMigration, checkAgentSnapshotMigration } from '../../src/migrations/agent-snapshot-migrate.js'

function fixture(failDdl = false) {
  const calls: string[] = []
  const client = { async query(sql: string) {
    calls.push(sql)
    if (sql.includes('current_schema() IS NOT NULL')) return { rows: [{ valid: true }] }
    if (sql.includes('SELECT version_num')) return { rows: [{ version_num: '20261115000007' }] }
    if (sql.includes('to_regclass($1)')) return { rows: [{ name: null }] }
    if (sql.includes('unnest($1')) return { rows: [{ name: null }, { name: null }] }
    if (sql.includes('CREATE TABLE gugu_agent_snapshot_manifest') && failDdl) throw new Error('synthetic-secret')
    return { rows: [] }
  }, release() { calls.push('release') } } as unknown as PoolClient
  return { calls, pool: { async connect() { return client } } as unknown as Pick<Pool, 'connect'> }
}
test('检查无台账只读返回 pending，不创建表', async () => {
  const { pool,calls } = fixture()
  assert.equal(await checkAgentSnapshotMigration(pool), 'pending')
  assert.ok(calls.includes('BEGIN READ ONLY')); assert.ok(calls.includes('COMMIT'))
  assert.equal(calls.some(sql => /CREATE|INSERT|UPDATE/i.test(sql)), false)
})
test('显式迁移 DDL 失败回滚且不暴露底层异常', async () => {
  const { pool,calls } = fixture(true)
  await assert.rejects(applyAgentSnapshotMigration(pool), error => error instanceof Error && !error.message.includes('synthetic-secret'))
  assert.ok(calls.includes('ROLLBACK')); assert.ok(calls.some(sql => sql.includes('pg_advisory_xact_lock')))
  assert.equal(calls.includes('COMMIT'), false); assert.equal(calls.at(-1), 'release')
})

test('搜索路径遮蔽及伪造台账或错误表结构均拒绝且不写入', async () => {
  for (const fault of ['shadow', 'checksum', 'columns']) {
    const calls: string[] = []
    const client = { async query(sql: string) {
      calls.push(sql)
      if (sql.includes('current_schema() IS NOT NULL')) return { rows: [{ valid: fault !== 'shadow' }] }
      if (sql.includes('SELECT version_num')) return { rows: [{ version_num: '20261115000007' }] }
      if (sql.includes('to_regclass($1)')) return { rows: [{ name: 'gugu_node_schema_migrations' }] }
      if (sql.includes('SELECT revision,checksum')) {
        const { AGENT_SNAPSHOT_CHECKSUM, AGENT_SNAPSHOT_REVISION } = await import('../../src/migrations/agent-snapshot-schema.js')
        return { rows: [{ revision: AGENT_SNAPSHOT_REVISION, checksum: fault === 'checksum' ? 'fake' : AGENT_SNAPSHOT_CHECKSUM }] }
      }
      if (sql.includes('unnest($1')) return { rows: [{ name: 'one' }, { name: 'two' }] }
      return { rows: [] }
    }, release() {} } as unknown as PoolClient
    const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
    await assert.rejects(checkAgentSnapshotMigration(pool), { code: 'incompatible' })
    assert.ok(calls.includes('ROLLBACK'))
    assert.equal(calls.some(sql => /CREATE|INSERT|UPDATE/i.test(sql)), false)
  }
})

test('伪造的列默认值、长度或缺失 CHECK 不得通过结构校验', async () => {
  const { AGENT_SNAPSHOT_CHECKSUM, AGENT_SNAPSHOT_REVISION } = await import('../../src/migrations/agent-snapshot-schema.js')
  for (const fault of ['default', 'length', 'check']) {
    const columns = [
      ['gugu_node_schema_migrations','revision','text'], ['gugu_node_schema_migrations','checksum','text'], ['gugu_node_schema_migrations','applied_at','timestamp with time zone'],
      ...[['user_id','uuid'],['session_id','integer'],['run_id','character varying'],['message_id','integer'],['codec_version','integer'],['key_version','integer'],['wrapped_key','bytea'],['chunk_count','bigint'],['total_bytes','bigint'],['digest','bytea'],['created_at','timestamp with time zone']].map(([n,t]) => ['gugu_agent_snapshot_manifest',n,t]),
      ...[['user_id','uuid'],['session_id','integer'],['run_id','character varying'],['message_id','integer'],['ordinal','bigint'],['nonce','bytea'],['ciphertext','bytea']].map(([n,t]) => ['gugu_agent_snapshot_chunks',n,t]),
    ].map(([table_name,column_name,data_type]) => ({ table_name,column_name,data_type,is_nullable:'NO',character_maximum_length: column_name === 'run_id' ? (fault === 'length' ? 127 : 128) : null, column_default: ['applied_at','created_at'].includes(column_name!) ? (fault === 'default' ? null : 'CURRENT_TIMESTAMP') : null }))
    const client = { async query(sql: string) {
      if (sql.includes('current_schema() IS NOT NULL')) return { rows: [{ valid: true }] }
      if (sql.includes('SELECT version_num')) return { rows: [{ version_num: '20261115000007' }] }
      if (sql.includes('to_regclass($1)')) return { rows: [{ name: 'ledger' }] }
      if (sql.includes('SELECT revision,checksum')) return { rows: [{ revision: AGENT_SNAPSHOT_REVISION, checksum: AGENT_SNAPSHOT_CHECKSUM }] }
      if (sql.includes('unnest($1')) return { rows: [{ name: 'one' }, { name: 'two' }] }
      if (sql.includes('information_schema.columns')) return { rows: columns }
      return { rows: [] }
    }, release() {} } as unknown as PoolClient
    const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
    await assert.rejects(checkAgentSnapshotMigration(pool), { code: 'incompatible' })
  }
})

test('隔离 PostgreSQL：只读检查、并发迁移、重复执行与真实结构拒绝', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
  const { Pool: PgPool } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL!
  const schema = `snapshot_migration_${randomUUID().replaceAll('-', '')}`
  const admin = new PgPool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new PgPool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`CREATE TABLE alembic_version(version_num varchar(32) NOT NULL); INSERT INTO alembic_version VALUES ('20261115000007');
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL,role text NOT NULL);
      CREATE TABLE agent_run_dispatch(user_id uuid NOT NULL,session_id integer NOT NULL,run_id varchar(128) NOT NULL,message_id integer NOT NULL,UNIQUE(user_id,session_id,run_id))`)
    assert.equal(await checkAgentSnapshotMigration(pool), 'pending')
    assert.equal((await pool.query("SELECT to_regclass('gugu_node_schema_migrations') AS name")).rows[0].name, null)
    const outcomes = await Promise.all([applyAgentSnapshotMigration(pool), applyAgentSnapshotMigration(pool)])
    assert.deepEqual(outcomes.sort(), ['applied', 'unchanged'])
    assert.equal(await checkAgentSnapshotMigration(pool), 'applied')
    assert.equal(await applyAgentSnapshotMigration(pool), 'unchanged')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_node_schema_migrations')).rows[0].n, 1)
    await pool.query('ALTER TABLE gugu_agent_snapshot_chunks DROP CONSTRAINT gugu_agent_snapshot_chunks_ordinal_check')
    await assert.rejects(checkAgentSnapshotMigration(pool), { code: 'incompatible' })
    await assert.rejects(applyAgentSnapshotMigration(pool), { code: 'incompatible' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_node_schema_migrations')).rows[0].n, 1)
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
    await pool.query(`CREATE TABLE alembic_version(version_num varchar(32) NOT NULL); INSERT INTO alembic_version VALUES ('20261115000007');
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
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
    await assert.rejects(applyAgentSnapshotMigration(faultPool), { code: 'unavailable' })
    assert.equal(injected, true)
    assert.equal((await pool.query('SELECT original FROM sentinel')).rows[0].original, '保留')
    assert.equal((await pool.query("SELECT to_regclass('gugu_agent_snapshot_manifest') AS name")).rows[0].name, null)
    assert.equal((await pool.query("SELECT to_regclass('gugu_node_schema_migrations') AS name")).rows[0].name, null)
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() }
  }
})
