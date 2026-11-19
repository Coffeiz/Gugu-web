import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { Pool } from 'pg'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { AgentDispatchLease } from '../../../src/modules/agent/run/dispatch.js'
import { createPostgresImAccess } from '../../../src/modules/im/gateway/inbound/access.js'
import { createPostgresImMemorySearch } from '../../../src/modules/im/gateway/memory/search.js'
import { createAgentToolRegistry } from '../../../src/modules/agent/tools/registry.js'
import { imCanUseTool } from '@gugu/core/im/access'

/** Core索引/排名与私有文件实际执行；PG lease/配置/游标查询为明确替身，不声称PG联调。 */
async function fixture(ownerPrivate = false, mixed = false, member = false, databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-memory-search-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  let cleanupPostgres = async () => {}
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db')); runtime = opened.runtime
    const owner = opened.ownerId, root = join(directory, 'storage')
    const identity = { ownerId: owner, sessionId: '17', runId: 'synthetic-im-run' }
    await sql`CREATE TABLE IF NOT EXISTS memory_reflection_cursors(id TEXT PRIMARY KEY,owner_user_id TEXT,platform TEXT,bot_id TEXT,scope_type TEXT,scope_id TEXT,scope_version INTEGER,updated_at TEXT)`.execute(runtime.db)
    await sql`CREATE TABLE IF NOT EXISTS memory_scope_tombstones(owner_user_id TEXT,platform TEXT,bot_id TEXT,scope_type TEXT,scope_id TEXT,status TEXT)`.execute(runtime.db)
    for (const [type, id] of [['group', 'group-a'], ['group', 'group-b'], ['platform-user', 'group-a:member-a'], ['platform-user', 'group-b:member-a']])
      await sql`INSERT INTO memory_reflection_cursors VALUES(${`${type}:${id}`},${owner},'telegram','7',${type},${id},1,'2026-01-01T00:00:00Z')`.execute(runtime.db)
    async function memory(branch: string, id: string, value: string) {
      const target = join(root, owner, '.agent', 'im', 'telegram', '7', branch, encodeURIComponent(id))
      await mkdir(target, { recursive: true }); await writeFile(join(target, 'memory.md'), value)
    }
    await memory('groups', 'group-a', '北极星发布计划，当前群确认周五进行灰度发布。')
    await memory('groups', 'group-b', '北极星发布计划，其他群的独立内部安排。')
    await memory('platform-users', 'group-a:member-a', '北极星发布计划，本人成员负责回归测试。')
    await memory('platform-users', 'group-a:member-b', '北极星发布计划，其他成员私人记录不可读取。')
    await memory('platform-users', 'group-b:member-a', '北极星发布计划，跨群本人成员负责验收。')
    await mkdir(join(root, owner, '.agent'), { recursive: true })
    await writeFile(join(root, owner, '.agent', 'memory.md'), '北极星发布计划，owner私人预算不得进入群聊。')
    const state = { enabled: true, group: true, member: true, active: true, configured: true, authorizations: 0,
      revokeAt: Number.POSITIVE_INFINITY, snapshot: { rag_revision: 'synthetic-r1', snapshot_context: '已有授权上下文' } as unknown }
    let pool = { async query(statement: string, values: unknown[] = []) {
      const result = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length })
      if (statement.includes('FROM user_bots b JOIN users')) {
        state.authorizations++
        if (state.authorizations >= state.revokeAt) state.enabled = false
        return result([{ id: '7', owner_id: owner, platform: 'telegram', enabled: state.enabled, is_active: true, account_status: 'active',
          owner_platform_user_id: 'synthetic-owner', group_allowed_tools: ['search_memory'], group_owner_memory_enabled: false,
          group_chat_enabled: true, feishu_group_chat_enabled: null }])
      }
      if (statement.startsWith('SELECT group_memory_enabled')) return result([{ group_memory_enabled: state.group, member_memory_enabled: state.member }])
      if (statement.includes('FROM memory_reflection_cursors')) {
        assert.deepEqual(values.slice(0, 3), [owner, 'telegram', '7'])
        return result(['group-a', 'group-b'].map(group => ({ owner_user_id: owner, platform: 'telegram', bot_id: '7',
          scope_type: values[3], scope_id: values[3] === 'group' ? group : `${group}:member-a` })))
      }
      assert.deepEqual(values.slice(0, 3), [owner, identity.sessionId, identity.runId])
      if (statement.startsWith('SELECT 1 FROM conversation_sessions')) {
        assert.deepEqual(values.slice(3), ['synthetic-lease', 1]); return result(state.active ? [{}] : [])
      }
      if (statement.startsWith('SELECT active_run_id,context_epoch')) return result(state.active ? [{ active_run_id: identity.runId, context_epoch: 1, session_context: state.snapshot }] : [])
      throw new Error('未声明的查询替身路径')
    } } as unknown as Pick<Pool, 'query'>
    if (databaseUrl) {
      const { Pool } = await import('pg'), schema = `im_memory_${randomUUID().replaceAll('-', '')}`
      const admin = new Pool({ connectionString: databaseUrl })
      const actual = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
      cleanupPostgres = async () => { await actual.end(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() } }
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await actual.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
        CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,owner_platform_user_id text,
          group_allowed_tools json,group_owner_memory_enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,
          group_memory_enabled boolean,member_memory_enabled boolean);
        CREATE TABLE conversation_sessions(user_id uuid,id integer,active_run_id text,context_epoch integer,session_context jsonb);
        CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
        CREATE TABLE memory_reflection_cursors(id serial,owner_user_id uuid,platform text,bot_id text,scope_type text,scope_id text);`)
      await actual.query(`INSERT INTO users VALUES($1,true,'active')`, [owner])
      await actual.query(`INSERT INTO user_bots VALUES(7,$1,'telegram',true,'synthetic-owner','[]',false,true,NULL,true,true)`, [owner])
      await actual.query(`INSERT INTO conversation_sessions VALUES($1,17,$2,1,$3)`, [owner, identity.runId, JSON.stringify(state.snapshot)])
      await actual.query(`INSERT INTO agent_run_dispatch VALUES($1,17,$2,'selected','synthetic-lease',1,clock_timestamp()+interval '1 hour')`, [owner, identity.runId])
      await actual.query(`INSERT INTO memory_reflection_cursors(owner_user_id,platform,bot_id,scope_type,scope_id)
        VALUES($1,'telegram','7','group','group-a'),($1,'telegram','7','group','group-b')`, [owner])
      pool = actual
    }
    const access = createPostgresImAccess({ query: async (statement, values) => pool.query(statement, values), supportedPlatforms: () => ['telegram'] })
    const input = { ownerId: owner, platform: 'telegram' as const, botId: '7', chatType: ownerPrivate ? 'c2c' as const : 'group' as const,
      chatId: ownerPrivate ? null : 'group-a', platformUserId: ownerPrivate || !mixed && !member ? 'synthetic-owner' : 'member-a',
      botMentioned: !ownerPrivate && !mixed && !member, mentionsOtherBot: false,
      ...(mixed ? { speakers: [{ platformUserId: 'member-a' }, { platformUserId: 'member-b' }] } : {}) }
    const snapshot = await access.snapshot(input), actor = snapshot.actor(input)
    state.authorizations = 0
    const lease: AgentDispatchLease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start', cancelRequested: false,
      input: { v: 3, source: 'im', userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64),
        im: { platform: actor.platform, botId: actor.botId, chatType: actor.chatType, chatId: actor.chatId, platformUserId: actor.platformUserId } } }
    const options = { pool, core: runtime, storageRoot: root, lease, actor, bot: snapshot.bot, access,
      async configuration() { return { identity: { ownerId: owner, workspaceId: null, subject: { kind: 'session' as const, id: identity.sessionId } },
        source: 'telegram', toolNames: state.configured ? ['search_memory'] : [] } } }
    const port = createPostgresImMemorySearch(options)
    return { port, identity, state, options, pool,
      async tombstone() { await sql`INSERT INTO memory_scope_tombstones VALUES(${owner},'telegram','7','group','group-a','deleted')`.execute(runtime!.db) },
      async close() { await cleanupPostgres(); await runtime!.close(); assert.ok(directory.startsWith(join(tmpdir(), 'gugu-im-memory-search-'))); await rm(directory, { recursive: true, force: true }) },
    }
  } catch (error) { await cleanupPostgres(); await runtime?.close(); assert.ok(directory.startsWith(join(tmpdir(), 'gugu-im-memory-search-'))); await rm(directory, { recursive: true, force: true }); throw error }
}
const signal = () => new AbortController().signal
const query = { query: '北极星发布计划', strategy: 'bm25' as const, limit: 25 }

test('实际群owner memory搜索默认只读当前群，显式跨群仍不读取私人或成员记忆', async () => {
  const f = await fixture()
  try {
    const current = JSON.stringify(await f.port.search(f.identity, query, signal()))
    assert.match(current, /当前群确认周五/u)
    assert.doesNotMatch(current, /私人预算|其他群的独立|本人成员|其他成员私人|跨群本人成员/u)
    const cross = JSON.stringify(await f.port.search(f.identity, { ...query, scope: 'all_my_groups' }, signal()))
    assert.match(cross, /其他群的独立/u); assert.doesNotMatch(cross, /私人预算|本人成员|其他成员私人|跨群本人成员/u)
    await assert.rejects(f.port.search(f.identity, { ...query, scope: 'private_memory' }, signal()), /IM 记忆搜索未授权/u)
  } finally { await f.close() }
})
test('成员及混合批次不能扩大旧工具白名单，owner私聊有真实个人记忆且不能伪装Web dispatch', async () => {
  const mixed = await fixture(false, true), owner = await fixture(true), member = await fixture(false, false, true)
  try {
    await assert.rejects(mixed.port.search(mixed.identity, { ...query, scope: 'all_my_groups' }, signal()), /IM 记忆搜索未授权/u)
    await assert.rejects(member.port.search(member.identity, query, signal()), /IM 记忆搜索未授权/u)
    assert.match(JSON.stringify(await owner.port.search(owner.identity, { ...query, scope: 'private_memory' }, signal())), /owner私人预算/u)
    assert.throws(() => createPostgresImMemorySearch({ ...owner.options, lease: { ...owner.options.lease,
      input: { v: 2, source: 'web', userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) } } }))
  } finally { await mixed.close(); await owner.close(); await member.close() }
})
test('缓存命中仍复核租约/配置/权限与墓碑，读取期间撤权不返回已读资料', async () => {
  const f = await fixture()
  try {
    assert.match(JSON.stringify(await f.port.search(f.identity, query, signal())), /当前群确认周五/u)
    await f.tombstone()
    assert.doesNotMatch(JSON.stringify(await f.port.search(f.identity, query, signal())), /当前群确认周五/u)
    f.state.configured = false; await assert.rejects(f.port.search(f.identity, query, signal())); f.state.configured = true
    f.state.active = false; await assert.rejects(f.port.search(f.identity, query, signal())); f.state.active = true
    f.state.authorizations = 0; f.state.revokeAt = 3
    await assert.rejects(f.port.search(f.identity, query, signal()), /IM 记忆搜索未授权/u)
  } finally { await f.close() }
})
test('消息快照缺失/坏版本与跨owner/run拒绝，取消保留原signal原因', async () => {
  const f = await fixture()
  try {
    for (const change of [{ ownerId: 'other' }, { runId: 'other-run' }]) await assert.rejects(f.port.search({ ...f.identity, ...change }, query, signal()))
    f.state.snapshot = { snapshot_context: '不能用空版本绕过' }; await assert.rejects(f.port.search(f.identity, query, signal()))
    const controller = new AbortController(), reason = new Error('合成取消'); controller.abort(reason)
    await assert.rejects(f.port.search(f.identity, query, controller.signal), error => error === reason)
  } finally { await f.close() }
})
test('正式工具注册器发现与实际分派复用同一memory端口，成员不暴露search_memory Schema', async () => {
  const owner = await fixture(true), member = await fixture(false, false, true)
  try {
    const registry = (f: typeof owner) => createAgentToolRegistry({ core: f.options.core, memorySearch: f.port,
      authorize: async (identity, name) => identity.ownerId === f.identity.ownerId && name === 'search_memory'
        && f.state.configured && imCanUseTool(f.options.actor, name) })
    const actual = registry(owner)
    assert.ok((await actual.capabilities(owner.identity)).some(tool => tool.name === 'search_memory'))
    const result = await actual.tools.dispatch({ id: 'synthetic-search', name: 'search_memory', input: { ...query, scope: 'private_memory' } },
      { identity: owner.identity, roundId: '1', signal: signal(), resolution: null, execute: async () => { throw new Error('只读检索不得执行进程') } })
    assert.equal(result.kind === 'completed' && result.successful, true)
    assert.match(JSON.stringify(result), /owner私人预算/u)
    assert.equal((await registry(member).capabilities(member.identity)).some(tool => tool.name === 'search_memory'), false)
  } finally { await owner.close(); await member.close() }
})

const databaseUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PostgreSQL实际授权/租约/游标/快照与正式Core文件检索，失效后缓存不得继续返回', {
  skip: !databaseUrl && '显式设置 GUGU_IM_GATEWAY_TEST_DATABASE_URL；查询替身不证明生产SQL', timeout: 30000,
}, async () => {
  // 配置选择为合成Provider配置；PG、SQLite索引/墓碑、文件加载和排名器实际执行。
  const f = await fixture(false, false, false, databaseUrl)
  try {
    assert.match(JSON.stringify(await f.port.search(f.identity, query, signal())), /当前群确认周五/u)
    assert.match(JSON.stringify(await f.port.search(f.identity, { ...query, scope: 'all_my_groups' }, signal())), /其他群的独立/u)
    await f.pool.query(`UPDATE agent_run_dispatch SET fence=2`)
    await assert.rejects(f.port.search(f.identity, query, signal()), /IM 记忆搜索未授权/u)
    await f.pool.query(`UPDATE agent_run_dispatch SET fence=1,lease_expires_at=clock_timestamp()-interval '1 second'`)
    await assert.rejects(f.port.search(f.identity, query, signal()), /IM 记忆搜索未授权/u)
    await f.pool.query(`UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()+interval '1 hour'`)
    await f.pool.query(`UPDATE user_bots SET group_memory_enabled=false`)
    await assert.rejects(f.port.search(f.identity, query, signal()), /IM 记忆搜索未授权/u)
    await f.pool.query(`UPDATE user_bots SET group_memory_enabled=true,group_chat_enabled=false`)
    await assert.rejects(f.port.search(f.identity, query, signal()), /IM 记忆搜索未授权/u)
    await f.pool.query(`UPDATE user_bots SET group_chat_enabled=true`)
    await f.pool.query(`UPDATE conversation_sessions SET session_context='{"snapshot_context":"缺少版本"}'`)
    await assert.rejects(f.port.search(f.identity, query, signal()), /IM 记忆搜索未授权/u)
    await f.pool.query(`UPDATE conversation_sessions SET session_context=$1`, [JSON.stringify(f.state.snapshot)])
    await f.pool.query(`UPDATE users SET is_active=false`)
    await assert.rejects(f.port.search(f.identity, query, signal()), /IM 记忆搜索未授权/u)
  } finally { await f.close() }
})
