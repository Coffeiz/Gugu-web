import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { AgentSchemaMigrationError } from '../../src/migrations/agent-schema-migrate.js'
import { applyAgentBaseMigration } from '../../src/migrations/agent-base-migrate.js'
import { applySearchUsageMigration, checkSearchUsageMigration } from '../../src/migrations/search-usage-migrate.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Node 搜索用量迁移可创建新表并接管兼容既有表而保留配额记录', {
  skip: !url ? '需要隔离 PostgreSQL' : false,
}, async () => {
  const schema = `search_usage_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const schemaUrl = new URL(url!)
  schemaUrl.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: schemaUrl.toString() })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await applyAgentBaseMigration(pool)
    assert.equal(await checkSearchUsageMigration(pool), 'pending')
    assert.equal(await applySearchUsageMigration(pool), 'applied')
    assert.equal(await checkSearchUsageMigration(pool), 'applied')
    const freshOwner = randomUUID()
    await pool.query(`INSERT INTO users(id,username,email,hashed_password)
      VALUES($1,'搜索用户','search@example.test','synthetic')`, [freshOwner])
    await pool.query('INSERT INTO search_usage(user_id,query,created_at) VALUES($1,$2,now())', [freshOwner, 'Node 新环境'])
    assert.deepEqual((await pool.query('SELECT query FROM search_usage WHERE user_id=$1', [freshOwner])).rows,
      [{ query: 'Node 新环境' }])

    await admin.query(`CREATE SCHEMA "${schema}_legacy"`)
    const legacyUrl = new URL(url!)
    legacyUrl.searchParams.set('options', `-c search_path=${schema}_legacy`)
    const legacy = new Pool({ connectionString: legacyUrl.toString() })
    try {
      await applyAgentBaseMigration(legacy)
      const oldOwner = randomUUID()
      await legacy.query(`INSERT INTO users(id,username,email,hashed_password)
        VALUES($1,'历史用户','legacy-search@example.test','synthetic')`, [oldOwner])
      await legacy.query(`CREATE TABLE search_usage(
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        query varchar(500) NOT NULL, created_at timestamptz NOT NULL)`)
      await legacy.query('CREATE INDEX ix_search_usage_user_id ON search_usage(user_id)')
      await legacy.query('CREATE INDEX ix_search_usage_created_at ON search_usage(created_at)')
      await legacy.query('INSERT INTO search_usage(user_id,query,created_at) VALUES($1,$2,now())', [oldOwner, '已存在的每日用量'])
      assert.equal(await checkSearchUsageMigration(legacy), 'pending')
      assert.equal(await applySearchUsageMigration(legacy), 'applied')
      assert.equal(await checkSearchUsageMigration(legacy), 'applied')
      assert.deepEqual((await legacy.query('SELECT user_id,query FROM search_usage')).rows,
        [{ user_id: oldOwner, query: '已存在的每日用量' }])
    } finally {
      await legacy.end()
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}_legacy" CASCADE`)
    }

    await admin.query(`CREATE SCHEMA "${schema}_bad"`)
    const badUrl = new URL(url!)
    badUrl.searchParams.set('options', `-c search_path=${schema}_bad`)
    const bad = new Pool({ connectionString: badUrl.toString() })
    try {
      await applyAgentBaseMigration(bad)
      await bad.query('CREATE TABLE search_usage(id integer PRIMARY KEY)')
      await assert.rejects(checkSearchUsageMigration(bad), (error: unknown) =>
        error instanceof AgentSchemaMigrationError && error.code === 'incompatible')
    } finally {
      await bad.end()
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}_bad" CASCADE`)
    }
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
