import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { applyAgentBaseMigration } from '@gugu/database/postgres/migrations/0001_initialize'
import { applySearchUsageMigration, checkSearchUsageMigration } from '@gugu/database/postgres/migrations/0010_search_usage'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Node 搜索用量迁移创建用量表并保存配额记录', {
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
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
