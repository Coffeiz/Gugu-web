import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { createGlobalSearchOperations, parseGlobalSearchQuery } from '@gugu/core'
import { createPostgresGlobalSearchSources } from '@gugu/core/search/postgres'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = randomUUID(), foreign = randomUUID(), secret = 'synthetic-shared-search-signing-key'
const schema = `gugu_search_shared_${randomUUID().replaceAll('-', '')}`
let admin: Pool, pool: Pool, app: ReturnType<typeof createApp>
interface Item { id: number | string; title: string; subtitle?: string; message_id?: number; [key: string]: unknown }
interface Result { query: string; queries: string[]; mode: string; total: number; groups: Array<{ type: string; label: string; items: Item[] }> }

// 真实PG合成表只验公共搜索SQL与路由；不代表正式SQLite schema、RAG或Provider验收。
describe('共享Core搜索与认证Host路由的真实隔离PostgreSQL', { skip: !url && '需要显式隔离 GUGU_WEBUI_TEST_DATABASE_URL', concurrency: false }, () => {
  before(async () => {
    admin = new Pool({ connectionString: url, max: 1 })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5000 })
    await pool.query(`
      CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,contact_name text,status text,current_stage text,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,search_romaji text,space text,size text,workspace_directory_id integer,project_id integer,folder_id integer,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,name text,search_romaji text,workspace_directory_id integer,project_id integer,parent_id integer,deleted_at timestamptz,created_at timestamptz);
      CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,name text,deleted_at timestamptz);
      CREATE TABLE calendar_events(id integer PRIMARY KEY,user_id uuid,title text,description text,contact_name text,deleted_at timestamptz,date text);
      CREATE TABLE clients(id integer PRIMARY KEY,user_id uuid,name text,contact text,email text,phone text,notes text,created_at timestamptz);
      CREATE TABLE user_skills(id integer PRIMARY KEY,owner_id uuid,name text,skill_id text,description_short text,description_long text,body text,enabled boolean,updated_at timestamptz);
      CREATE TABLE user_mcp_servers(id text PRIMARY KEY,user_id uuid,scope text,name text,transport text,enabled boolean,endpoint text,credential_slots jsonb);
      CREATE TABLE scheduled_tasks(id integer PRIMARY KEY,user_id uuid,name text,enabled boolean,end_at timestamptz,updated_at timestamptz,schedule_kind text,cron text,interval_minutes integer);
      CREATE TABLE mind_nodes(id integer PRIMARY KEY,user_id uuid,title text,content_plain text,kind text,deleted_at timestamptz,captured_at timestamptz,updated_at timestamptz,version integer);
      CREATE TABLE mind_canvas_items(id integer PRIMARY KEY,node_id integer,canvas_id integer,user_id uuid,deleted_at timestamptz);
      CREATE TABLE mind_maps(id integer PRIMARY KEY,user_id uuid,deleted_at timestamptz);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,title text,updated_at timestamptz);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,content text,created_at timestamptz);
    `)
    const inserts: Array<[string, unknown[]]> = [
      ["INSERT INTO projects VALUES (1,$1,'命中','小北','active','',NULL,'2026-01-01'),(2,$1,'命中扩展','小北','pending','',NULL,'2026-01-03'),(3,$2,'命中其他账号','小北','active','',NULL,'2026-01-01'),(4,$1,'命中已删','小北','active','','2026-01-01','2026-01-01')", [owner, foreign]],
      ["INSERT INTO workspace_directories VALUES (1,$1,'主工作区',NULL),(2,$2,'私有目录名',NULL)", [owner, foreign]],
      ["INSERT INTO folders VALUES (1,$1,'命中目录',NULL,1,NULL,NULL,NULL,'2026-01-01'),(2,$1,'命中子目录',NULL,1,NULL,1,NULL,'2026-01-02'),(3,$2,'私有父名',NULL,2,NULL,NULL,NULL,'2026-01-01'),(4,$1,'命中越权父链',NULL,1,NULL,3,NULL,'2026-01-03'),(5,$1,'命中错根',NULL,2,NULL,NULL,NULL,'2026-01-04')", [owner, foreign]],
      ["INSERT INTO files VALUES (1,$1,'命中','txt',NULL,'workspace','12 B',1,NULL,2,NULL,'2026-01-04'),(2,$1,'命中坏父链','txt',NULL,'workspace','1 B',1,NULL,4,NULL,'2026-01-03'),(3,$1,'命中错根文件','txt',NULL,'workspace','1 B',2,NULL,5,NULL,'2026-01-02'),(4,$2,'命中其他文件','txt',NULL,'personal','1 B',NULL,NULL,NULL,NULL,'2026-01-01'),(5,$1,'命中删除文件','txt',NULL,'personal','1 B',NULL,NULL,NULL,'2026-01-01','2026-01-01')", [owner, foreign]],
      ["INSERT INTO calendar_events VALUES (1,$1,'命中日程','说明','小北',NULL,'2026-01-01'),(2,$2,'命中其他日程','说明','小北',NULL,'2026-01-01'),(3,$1,'命中删除日程','说明','小北','2026-01-01','2026-01-01')", [owner, foreign]],
      ["INSERT INTO clients VALUES (1,$1,'命中联系人','小北',NULL,NULL,'备注','2026-01-01'),(2,$2,'命中其他联系人',NULL,NULL,NULL,NULL,'2026-01-01')", [owner, foreign]],
      ["INSERT INTO user_skills VALUES (1,$1,'命中技能','U1','元数据说明','长说明','机密正文仅内部',false,'2026-01-01'),(2,$2,'命中其他技能','U2','其他','其他','其他私密正文',true,'2026-01-01')", [owner, foreign]],
      ["INSERT INTO user_mcp_servers VALUES ('user-mcp',$1,'user','命中私有MCP','http',true,'https://endpoint-secret.example.invalid','[{\"secret\":\"凭据秘密\"}]'),('platform-mcp',$2,'platform','命中平台MCP','stdio',false,'platform-endpoint-secret','[]'),('foreign-mcp',$2,'user','命中其他私有MCP','http',true,'other-secret','[]')", [owner, foreign]],
      ["INSERT INTO scheduled_tasks VALUES (1,$1,'命中有效任务',true,'2999-01-01','2026-01-01','cron','0 9 * * *',NULL),(2,$1,'命中停用任务',false,NULL,'2026-01-01','cron','0 9 * * *',NULL),(3,$1,'命中过期任务',true,'2000-01-01','2026-01-01','cron','0 9 * * *',NULL),(4,$2,'命中其他任务',true,NULL,'2026-01-01','cron','0 9 * * *',NULL)", [owner, foreign]],
      ["INSERT INTO mind_nodes VALUES (1,$1,'命中便签','正文','note',NULL,'2026-01-01','2026-01-01',2),(2,$1,'命中画布便签','正文','canvas_note',NULL,'2026-01-01','2026-01-01',1),(3,$2,'命中其他便签','私密','note',NULL,'2026-01-01','2026-01-01',1),(4,$1,'命中已删便签','正文','note','2026-01-01','2026-01-01','2026-01-01',1),(5,$1,'命中越权画布','正文','canvas_note',NULL,'2026-01-01','2026-01-01',1)", [owner, foreign]],
      ["INSERT INTO mind_maps VALUES (1,$1,NULL),(2,$2,NULL)", [owner, foreign]],
      ["INSERT INTO mind_canvas_items VALUES (1,2,1,$1,NULL),(2,5,2,$1,NULL)", [owner]],
      ["INSERT INTO conversation_sessions VALUES (1,$1,'命中标题','2026-01-03'),(2,$1,'正文会话','2026-01-02'),(3,$2,'命中其他会话','2026-01-01'),(5,$1,'重复扫描会话','2026-01-01'),(6,$1,'扫描窗口之外','2026-01-01')", [owner, foreign]],
      ["INSERT INTO conversation_messages VALUES (1,1,'命中标题内正文','2026-01-03'),(2,2,$1,'2026-01-02'),(3,3,'命中其他正文','2026-01-01'),(4,6,'窗口探针','2026-01-01')", [`${'🙂'.repeat(25)}命中${'🚀'.repeat(25)}`]],
    ]
    for (const [sql, values] of inserts) await pool.query(sql, values)
    for (let i = 0; i < 8; i++) await pool.query('INSERT INTO conversation_messages VALUES ($1,5,$2,$3)', [100 + i, '窗口探针', `2026-02-01T00:00:0${i}Z`])
    app = createApp({ appName: '共享搜索测试', isReady: async () => true,
      userAuth: { secret, async lookupUser(id) { return { id, username: 'synthetic', displayName: null, email: 'synthetic@example.test',
        avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1 } } },
      globalSearch: createGlobalSearchOperations(createPostgresGlobalSearchSources(pool)),
    })
  })
  after(async () => {
    await app?.close(); await pool?.end()
    if (admin) {
      try {
        if (!/^gugu_search_shared_[a-f0-9]{32}$/.test(schema)) throw new Error('测试schema范围无效')
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally { await admin.end() }
    }
  })
  async function search(query: string, user = owner): Promise<Result> {
    const response = await app.inject({ url: `/api/v1/search?${query}`, headers: { authorization: `Bearer ${signedUserToken(secret, user)}` } })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as Result
  }
  it('默认全部11来源经过真实SQL，保留分组次序、查询形状、ANDOR与perType', async () => {
    assert.equal((await app.inject({ url: '/api/v1/search?q=命中' })).statusCode, 401)
    const all = await search(`q=${encodeURIComponent('命中')}&per_type=1`)
    assert.deepEqual(all.groups.map(group => group.type), ['project', 'file', 'folder', 'event', 'client', 'skill', 'mcp', 'scheduled_task', 'note', 'canvas_note', 'conversation'])
    assert.equal(all.total, 11)
    assert.equal(all.query, '命中'); assert.deepEqual(all.queries, ['命中']); assert.equal(all.mode, 'OR')
    assert.ok(all.groups.every(group => group.items.length === 1 && group.label))
    assert.equal(all.groups[0]!.items[0]!.id, 1)
    const filtered = await search(`queries=${encodeURIComponent('命中')}&queries=${encodeURIComponent('小北')}&mode=AND&types=project&per_type=2`)
    assert.deepEqual(filtered.groups.map(group => group.type), ['project'])
    assert.deepEqual(filtered.groups[0]!.items.map(item => item.id), [1, 2])
    const either = await search(`queries=${encodeURIComponent('无匹配词')}&queries=${encodeURIComponent('小北')}&mode=OR&types=project`)
    assert.equal(either.total, 2)
    assert.deepEqual(await search('q=%20%20'), { query: '', queries: [], mode: 'OR', total: 0, groups: [] })
  })
  it('真实来源保护owner/软删/有效任务和私有metadata，导航不泄漏错owner父链或根', async () => {
    const result = await search(`q=${encodeURIComponent('命中')}&per_type=200`)
    const group = (type: string) => result.groups.find(value => value.type === type)!.items
    assert.deepEqual(group('project').map(item => item.id), [1, 2])
    assert.deepEqual(group('scheduled_task').map(item => item.id), [1])
    assert.deepEqual(group('canvas_note').map(item => item.id), [2])
    assert.deepEqual(group('skill')[0], { id: 'U1', title: '命中技能', subtitle: '元数据说明', enabled: false })
    assert.deepEqual(new Set(group('mcp').map(item => item.id)), new Set(['user-mcp', 'platform-mcp']))
    const text = JSON.stringify(result)
    for (const hidden of ['机密正文', 'endpoint-secret', '凭据秘密', '其他账号', '其他文件', '删除文件', '删除日程', '已删便签', '其他会话', '私有目录名', '私有父名']) assert.equal(text.includes(hidden), false, hidden)
    const good = group('file').find(item => item.id === 1)!
    assert.equal(good.workspace_directory_name, '主工作区')
    assert.deepEqual(good.folder_path, [{ id: 1, name: '命中目录' }, { id: 2, name: '命中子目录' }])
    assert.deepEqual(group('file').find(item => item.id === 2)!.folder_path, [])
    assert.equal(group('file').find(item => item.id === 3)!.workspace_directory_name, undefined)
    assert.equal(group('folder').find(item => item.id === 5)!.workspace_directory_name, undefined)
    const foreignResult = await search(`q=${encodeURIComponent('命中')}&types=project&types=conversation`, foreign)
    assert.deepEqual(foreignResult.groups.map(value => value.items.map(item => item.id)), [[3], [3]])
    assert.equal((await search(`q=${encodeURIComponent('机密正文')}&types=skill`)).total, 0)
  })
  it('认证HTTP链保留Python空白和casefold去重，原始词仍用于真实PG匹配', async () => {
    await pool.query("INSERT INTO projects VALUES (100,$1,'Straße','','active','',NULL,'2026-01-01'),(101,$1,'STRASSE','','active','',NULL,'2026-01-01')", [owner])
    try {
      const urlQuery = (values: string[]) => new URLSearchParams([
        ...values.map(value => ['queries', value]), ['mode', 'AND'], ['types', 'project'],
      ]).toString()
      const first = await search(urlQuery(['Straße', 'STRASSE']))
      assert.deepEqual(first.queries, ['Straße'])
      assert.equal(first.query, 'Straße')
      assert.deepEqual(first.groups[0]!.items.map(item => item.id), [100])
      const reverse = await search(urlQuery(['STRASSE', 'Straße']))
      assert.deepEqual(reverse.groups[0]!.items.map(item => item.id), [101])
      const spaced = await search(new URLSearchParams({ q: '\u001c命中\u0085', types: 'project' }).toString())
      assert.equal(spaced.query, '命中'); assert.deepEqual(spaced.queries, ['命中']); assert.equal(spaced.total, 2)
      const bom = '\ufeff命中\ufeff'
      const retained = await search(new URLSearchParams({ q: bom, types: 'project' }).toString())
      assert.equal(retained.query, bom); assert.deepEqual(retained.queries, [bom]); assert.equal(retained.total, 0)
    } finally { await pool.query('DELETE FROM projects WHERE id IN (100,101) AND user_id=$1', [owner]) }
  })
  it('会话标题优先并去重，Unicode片段不割裂emoji，消息候选窗口保持8条', async () => {
    const result = await search(`q=${encodeURIComponent('命中')}&types=conversation&per_type=20`)
    const items = result.groups[0]!.items
    assert.deepEqual(items.map(item => item.id), [1, 2])
    assert.equal(items[0]!.subtitle, '对话'); assert.equal(items[0]!.message_id, undefined)
    assert.equal(items[1]!.message_id, 2)
    assert.equal(items[1]!.subtitle, `…${'🙂'.repeat(24)}命中${'🚀'.repeat(24)}…`)
    const scan = await search(`q=${encodeURIComponent('窗口探针')}&types=conversation&per_type=20`)
    assert.deepEqual(scan.groups[0]!.items.map(item => item.id), [5])
    assert.equal(scan.total, 1)
  })
  it('消息实际查询复用Python片段首词选择和控制空白边界', async () => {
    await pool.query("INSERT INTO conversation_sessions VALUES (20,$1,'折叠片段','2026-01-03'),(21,$1,'空白片段','2026-01-02')", [owner])
    try {
      await pool.query('INSERT INTO conversation_messages VALUES (20,20,$1,$3),(21,21,$2,$3)',
        ['甲'.repeat(70) + 'ß' + '乙'.repeat(30) + 'needle' + '丙'.repeat(30), '\u0085\ufeffneedle\ufeff\u001c', '2026-01-03'])
      const query = new URLSearchParams([['queries', 'ss'], ['queries', 'needle'], ['types', 'conversation'], ['mode', 'OR']])
      const result = await search(query.toString())
      const items = result.groups[0]!.items
      // ss先casefold命中ß，但lower无法定位，Python此时退回前60码点，不选择后面的needle。
      assert.equal(items.find(item => item.id === 20)!.subtitle, '甲'.repeat(60))
      assert.equal(items.find(item => item.id === 21)!.subtitle, '\ufeffneedle\ufeff')
    } finally {
      await pool.query('DELETE FROM conversation_messages WHERE session_id IN (20,21)')
      await pool.query('DELETE FROM conversation_sessions WHERE id IN (20,21) AND user_id=$1', [owner])
    }
  })
  it('真实并发文件位置查询取消后等待全部待锁兄弟排空，连接可归还和复用', async () => {
    const operations = createGlobalSearchOperations(createPostgresGlobalSearchSources(pool))
    const query = parseGlobalSearchQuery({ q: '命中', types: 'file' })
    const oid = await admin.query<{ oid: number }>(
      'SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',
      [schema, 'folders'],
    )
    assert.equal(oid.rowCount, 1)
    const blocker = await pool.connect()
    const controller = new AbortController(), reason = new Error('合成文件导航取消')
    let settled = false
    let observed: Promise<{ value: unknown; error: unknown }> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query(`LOCK TABLE "${schema}".folders IN ACCESS EXCLUSIVE MODE`)
      const pending = operations.search(owner, query, { signal: controller.signal })
      observed = pending.then(value => { settled = true; return { value, error: undefined } },
        error => { settled = true; return { value: undefined, error } })
      const deadline = Date.now() + 5000
      let waiting = 0
      while (Date.now() < deadline) {
        const locks = await admin.query<{ waiting: number }>(
          "SELECT count(*)::integer AS waiting FROM pg_locks WHERE relation=$1::oid AND locktype='relation' AND NOT granted",
          [oid.rows[0]!.oid],
        )
        waiting = locks.rows[0]!.waiting
        if (waiting >= 2) break
        if (settled) break
      }
      assert.ok(waiting >= 2, `需观测到至少两个真实导航兄弟待锁，实际${waiting}`)
      controller.abort(reason)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, false, '锁尚未释放时不能丢弃仍在运行的导航查询')
    } finally {
      if (!controller.signal.aborted) controller.abort(reason)
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      if (observed) await observed
    }
    const outcome = await observed!
    assert.equal(outcome.value, undefined)
    assert.equal(outcome.error, reason)
    assert.equal(pool.waitingCount, 0)
    // 所有原有连接均已归还；借满pool也能完成，不依赖新建额外连接掩盖泄漏。
    const borrowed = await Promise.allSettled(Array.from({ length: 4 }, () => pool.connect()))
    try {
      assert.ok(borrowed.every(result => result.status === 'fulfilled'), '取消后应能借满全部连接')
      assert.equal(pool.waitingCount, 0)
    } finally { for (const result of borrowed) if (result.status === 'fulfilled') result.value.release() }
    assert.equal(pool.idleCount, pool.totalCount)
    const again = await operations.search(owner, query) as Result
    assert.equal(again.groups[0]!.type, 'file')
    assert.equal(again.groups[0]!.items.length, 3)
  })

  it('默认全来源遇到真实表缺失拒绝，不返回前面来源已生成的部分groups', async () => {
    const operations = createGlobalSearchOperations(createPostgresGlobalSearchSources(pool))
    let renamed = false
    try {
      await pool.query('ALTER TABLE clients RENAME TO clients_temporarily_unavailable')
      renamed = true
      await assert.rejects(operations.search(owner, parseGlobalSearchQuery({ q: '命中' })),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
    } finally {
      if (renamed) await pool.query('ALTER TABLE clients_temporarily_unavailable RENAME TO clients')
    }
    const restored = await operations.search(owner, parseGlobalSearchQuery({ q: '命中' })) as Result
    assert.equal(restored.groups.length, 11)
  })

})
