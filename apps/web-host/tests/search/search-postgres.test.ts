import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'
import { createGlobalSearchOperations } from '@gugu/core'
import { createPostgresGlobalSearchSources } from '@gugu/core/search/postgres'
import type { GlobalSearchQuery } from '@gugu/core'

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
  const result = await createGlobalSearchOperations(createPostgresGlobalSearchSources(pool)).search('owner-a', query) as {
    groups: Array<{ items: Array<Record<string, unknown>> }>
  }
  assert.deepEqual(calls[0]?.values, ['owner-a', ['本地'], '本地', 6])
  assert.match(calls[0]?.sql ?? '', /m\.user_id = \$1 OR m\.scope = 'platform'/)
  assert.deepEqual(result.groups[0]?.items[0], {
    id: 'server-1', title: '本地服务', subtitle: 'http · 已启用', enabled: true,
  })
})

test('conversation search snippets count Unicode characters without splitting emoji', async () => {
  let calls = 0
  const content = `${'🙂'.repeat(25)}命中${'🚀'.repeat(25)}`
  const pool = {
    async query() {
      calls += 1
      return calls === 1 ? { rows: [] } : { rows: [{ id: 1, title: '会话', message_id: 2, content }] }
    },
  } as unknown as Pool
  const result = await createGlobalSearchOperations(createPostgresGlobalSearchSources(pool)).search('owner-a', {
    q: '命中', queries: ['命中'], mode: 'OR', perType: 6, types: ['conversation'],
  }) as { groups: Array<{ items: Array<{ subtitle: string }> }> }
  assert.equal(result.groups[0]?.items[0]?.subtitle, `…${'🙂'.repeat(24)}命中${'🚀'.repeat(24)}…`)
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

  const operations = createGlobalSearchOperations(createPostgresGlobalSearchSources(pool))
  const result = await operations.search('11111111-1111-4111-8111-111111111111', {
    q: '', queries: ['发布', '小北'], mode: 'AND', perType: 6, types: ['project'],
  }) as { total: number; groups: Array<{ type: string; items: Array<{ id: number; title: string }> }> }
  assert.equal(result.total, 2)
  assert.equal(result.groups[0]?.type, 'project')
  assert.deepEqual(result.groups[0]?.items.map((item) => item.id), [1, 2])
})


test('认证全局搜索以真实 PostgreSQL 返回归属会话标题和消息，包括默认全来源', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 搜索集成',
}, async () => {
  const isolated = `gugu_search_conversation_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${isolated}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${isolated}` })
  const owner = randomUUID(), foreign = randomUUID(), secret = 'synthetic-search-token-secret'
  const app = createApp({
    appName: '搜索测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return { id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1 } } },
    globalSearch: createGlobalSearchOperations(createPostgresGlobalSearchSources(pool)),
  })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,title text,updated_at timestamptz);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,content text,created_at timestamptz);
      CREATE TABLE projects(id integer,user_id uuid,name text,contact_name text,current_stage text,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE calendar_events(id integer,user_id uuid,title text,description text,contact_name text,deleted_at timestamptz,date date);
      CREATE TABLE clients(id integer,user_id uuid,name text,contact text,email text,phone text,notes text,created_at timestamptz);
      CREATE TABLE user_skills(id integer,owner_id uuid,name text,skill_id text,description_short text,description_long text,updated_at timestamptz);
      CREATE TABLE user_mcp_servers(id integer,user_id uuid,scope text,name text);
      CREATE TABLE scheduled_tasks(id integer,user_id uuid,name text,enabled boolean,end_at timestamptz,updated_at timestamptz);
      CREATE TABLE mind_nodes(id integer,user_id uuid,title text,content_plain text,kind text,deleted_at timestamptz,captured_at timestamptz,updated_at timestamptz);
      CREATE TABLE mind_canvas_items(id integer,node_id integer,canvas_id integer,user_id uuid,deleted_at timestamptz);
      CREATE TABLE mind_maps(id integer,user_id uuid,deleted_at timestamptz);
    `)
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'搜索标题',now()),(2,$1,'其他会话',now()),(3,$2,'搜索私密',now())", [owner, foreign])
    await pool.query("INSERT INTO conversation_messages VALUES (1,1,'搜索标题内正文',now()),(2,2,'一条搜索正文',now()),(3,3,'搜索私密正文',now())")
    const url = '/api/v1/search?queries=%E6%90%9C%E7%B4%A2'
    assert.equal((await app.inject({ url })).statusCode, 401)
    const headers = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
    for (const target of [url, `${url}&types=conversation`]) {
      const response = await app.inject({ url: target, headers })
      assert.equal(response.statusCode, 200, response.body)
      const payload = response.json() as { total: number; groups: Array<{ type: string; items: Array<{ id: number; message_id?: number; subtitle: string }> }> }
      const group = payload.groups.find(item => item.type === 'conversation')!
      assert.equal(payload.total, 2)
      assert.deepEqual(group.items.map(item => item.id), [1, 2])
      assert.equal(group.items[0]?.subtitle, '对话')
      assert.equal(group.items[0]?.message_id, undefined)
      assert.equal(group.items[1]?.message_id, 2)
      assert.match(group.items[1]!.subtitle, /搜索正文/)
    }
  } finally {
    await app.close(); await pool.end(); await admin.query(`DROP SCHEMA "${isolated}" CASCADE`); await admin.end()
  }
})
