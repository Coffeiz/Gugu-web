import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { migrateGroupToolPermissions } from '../../src/migrations/group-tool-permissions.js'
import type { MigrationPool } from '../../src/migrations/group-tool-permissions.js'

const connectionString = process.env.GUGU_WEBUI_MIGRATION_TEST_DATABASE_URL

test('真实PostgreSQL隔离schema迁移保留白名单语义且重复执行无副作用', {
  skip: !connectionString && '设置 GUGU_WEBUI_MIGRATION_TEST_DATABASE_URL 后运行隔离 PostgreSQL 集成测试',
}, async () => {
  assert.ok(connectionString)
  const adminPool = new Pool({ connectionString })
  const schema = `migration_${randomUUID().replaceAll('-', '')}`
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const schemaPool = new Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await schemaPool.query(`
      CREATE TABLE user_bots (
        id integer PRIMARY KEY,
        group_allowed_tools jsonb
      )
    `)
    await schemaPool.query(
      'INSERT INTO user_bots (id, group_allowed_tools) VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)',
      [
        1, JSON.stringify(['web_search', 'http_get', 'xng_search']),
        2, JSON.stringify(['image_search', 'inspect_images', 'retired_tool']),
        3, JSON.stringify(['web_search', 'retired_tool']),
        4, null,
      ],
    )
    const adapter: MigrationPool = {
      async connect() {
        const client = await schemaPool.connect()
        return {
          async query(sql, values) {
            const result = await client.query(sql, values)
            return { rows: result.rows, rowCount: result.rowCount }
          },
          release: () => client.release(),
        }
      },
    }

    assert.equal(await migrateGroupToolPermissions(adapter), 2)
    const migrated = await schemaPool.query(
      'SELECT id, group_allowed_tools FROM user_bots ORDER BY id',
    )
    assert.deepEqual(migrated.rows.map(row => row.group_allowed_tools), [
      ['web_search', 'http_get', 'xng_search'],
      ['xng_search', 'http_get', 'similar_image_search', 'read_file'],
      ['web_search', 'http_get'],
      null,
    ])
    assert.equal(await migrateGroupToolPermissions(adapter), 0)
  } finally {
    await schemaPool.end()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  }
})
