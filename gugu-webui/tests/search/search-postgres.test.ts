import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresGlobalSearchOperations } from '../../src/domains/search/search-postgres.js'
import type { GlobalSearchQuery } from '../../src/domains/search/search.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const pools: Pool[] = []
let adminPool: Pool | undefined
let schema: string | undefined

after(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
  if (adminPool && schema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
  await adminPool?.end()
})

test('MCP global-search results expose no endpoint and bind the authenticated owner to the query', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values })
      return { rows: [{
        id: 'server-1', user_id: 'owner-a', scope: 'user', name: '本地服务', transport: 'http',
        enabled: true, endpoint: 'https://secret.example.invalid', search_hits: 1,
      }] }
    },
  } as unknown as Pool
  const query: GlobalSearchQuery = {
    q: '', queries: ['本地'], mode: 'OR', perType: 6, types: ['mcp'],
  }
  const result = await createPostgresGlobalSearchOperations(pool).search('owner-a', query) as {
    groups: Array<{ items: Array<Record<string, unknown>> }>
  }
  assert.deepEqual(calls[0]?.values, ['owner-a', ['本地'], '本地', 6])
  assert.match(calls[0]?.sql ?? '', /m\.user_id = \$1 OR m\.scope = 'platform'/)
  assert.deepEqual(result.groups[0]?.items[0], {
    id: 'server-1', title: '本地服务', subtitle: 'http · 已启用', enabled: true,
  })
})

test('PostgreSQL global search filters by owner, supports AND terms, and ranks exact project names first', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 搜索集成',
}, async () => {
  schema = `gugu_search_${randomUUID().replaceAll('-', '')}`
  adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  pools.push(pool)
  await pool.query(`
    CREATE TABLE projects (
      id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, contact_name text,
      status text, current_stage text, deleted_at timestamptz, updated_at timestamptz NOT NULL
    );
    INSERT INTO projects (id,user_id,name,contact_name,status,current_stage,updated_at) VALUES
      (1,'11111111-1111-4111-8111-111111111111','发布','小北','active','',now()),
      (2,'11111111-1111-4111-8111-111111111111','发布准备清单','小北','active','',now()),
      (3,'22222222-2222-4222-8222-222222222222','发布私有项目','小北','active','',now()),
      (4,'11111111-1111-4111-8111-111111111111','已删除发布','小北','active','',now());
    UPDATE projects SET deleted_at=now() WHERE id=4;
  `)

  const operations = createPostgresGlobalSearchOperations(pool)
  const result = await operations.search('11111111-1111-4111-8111-111111111111', {
    q: '', queries: ['发布', '小北'], mode: 'AND', perType: 6, types: ['project'],
  }) as { total: number; groups: Array<{ type: string; items: Array<{ id: number; title: string }> }> }
  assert.equal(result.total, 2)
  assert.equal(result.groups[0]?.type, 'project')
  assert.deepEqual(result.groups[0]?.items.map((item) => item.id), [1, 2])
})
