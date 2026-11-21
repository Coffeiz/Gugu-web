import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { Kysely, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqlAgentSessionLister } from '../../../src/agent/sessions/list.js'

const runtime = { activeStatuses: async (ids: number[]) => new Map(ids.filter(id => id === 1).map(id => [id, true])), filesystemAuthorizationEnabled: () => true, workspaceShellSupported: () => true, sqliteWorkspace: 'available' as const }
async function check(list: (owner: string) => Promise<Record<string, unknown>[]>, owner: string) {
  const result = await list(owner), web = result.find(row => row.id === 1)!, im = result.find(row => row.id === 2)!, blank = result.find(row => row.id === 3)!
  assert.deepEqual(result.map(row => row.id), [3, 2, 1])
  assert.equal(web.lastAssistantId, 2); assert.equal(web.isRunning, true); assert.equal(web.filesystemAuthorized, true)
  assert.equal(web.workspaceName, '工作区'); assert.equal(web.goalStatus, 'paused')
  assert.equal(im.lastAssistantId, undefined); assert.equal(im.isRunning, undefined); assert.equal(im.filesystemAuthorized, false)
  assert.equal(blank.lastAssistantId, 0); assert.equal(blank.source, ''); assert.equal(blank.workspaceName, null)
  assert.equal(web.updatedAt, '2026-01-01T00:00:00.123456Z')
  assert.equal((await list(randomUUID())).length, 0)
}

test('SQLite 使用 runtime.db 并在缺表时失败关闭', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-list-'))
  try {
    const connection = new Kysely<any>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    const db = { db: connection, close: () => connection.destroy() }
    try {
      const list = createSqlAgentSessionLister(db.db, 'sqlite', runtime)
      await assert.rejects(list(randomUUID()), (e: unknown) => e instanceof Error && 'code' in e && e.code === 'schema_upgrade_required')
      for (const statement of [
        'CREATE TABLE workspaces(id integer primary key,name text,user_id text)',
        'CREATE TABLE conversation_sessions(id integer primary key,user_id text,title text,source text,chat_type text,workspace_id integer,session_context text,updated_at text,created_at text)',
        'CREATE TABLE conversation_messages(id integer primary key,session_id integer,role text,content text,content_json text,files text,conversation_seq integer)',
        'CREATE TABLE filesystem_authorization_grants(user_id text,subject_type text,subject_id text,revoked_at text,expires_at text)',
      ]) await sql.raw(statement).execute(db.db)
      const owner = randomUUID(), key = owner.replaceAll('-', '')
      await sql`INSERT INTO workspaces VALUES (1,'工作区',${key}),(2,'他人私有',${randomUUID().replaceAll('-', '')})`.execute(db.db)
      await sql`INSERT INTO conversation_sessions VALUES (1,${key},'网页','web','private',1,'{"goal_mode":true,"goal_text":"目标","goal_status":"paused"}','2026-01-01 00:00:00.123456','2026-01-01 00:00:00.000000'),(2,${key},'IM','qq','group',NULL,NULL,'2026-01-02 00:00:00.000000','2026-01-01 00:00:00.000000'),(3,${key},'空来源','','private',2,NULL,'2026-01-03 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(db.db)
      await sql`INSERT INTO conversation_messages VALUES (1,1,'assistant','正文',NULL,NULL,1),(2,1,'assistant','',NULL,'[{"id":1}]',2),(3,1,'assistant','工具','null',NULL,3),(4,1,'assistant','',NULL,'[]',4)`.execute(db.db)
      await sql`INSERT INTO filesystem_authorization_grants VALUES (${key},'session','1',NULL,NULL),(${key},'session','2',NULL,'2000-01-01 00:00:00.000000')`.execute(db.db)
      await check(list, owner)
      for (let i = 0; i < 51; i++) {
        await sql`INSERT INTO conversation_sessions VALUES (${100 + i},${key},'网页','web','private',NULL,NULL,'2027-01-01 00:00:00.000000','2026-01-01 00:00:00.000000'),(${200 + i},${key},'IM','qq','group',NULL,NULL,'2027-01-01 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(db.db)
      }
      const limited = await list(owner)
      assert.equal(limited.filter(row => row.source === 'web').length, 50)
      assert.equal(limited.filter(row => row.source !== 'web').length, 50)
    } finally { await db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('SQLite 授权到期按 UTC 微秒严格比较并限制 owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-grant-us-'))
  try {
    const connection = new Kysely<any>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    const db = { db: connection, close: () => connection.destroy() }
    try {
      for (const statement of [
        'CREATE TABLE workspaces(id integer primary key,name text,user_id text)',
        'CREATE TABLE conversation_sessions(id integer primary key,user_id text,title text,source text,chat_type text,workspace_id integer,session_context text,updated_at text,created_at text)',
        'CREATE TABLE conversation_messages(id integer primary key,session_id integer,role text,content text,content_json text,files text,conversation_seq integer)',
        'CREATE TABLE filesystem_authorization_grants(user_id text,subject_type text,subject_id text,revoked_at text,expires_at text)',
      ]) await sql.raw(statement).execute(db.db)
      const owner = randomUUID(), key = owner.replaceAll('-', ''), other = randomUUID().replaceAll('-', '')
      for (let id = 1; id <= 5; id++) await sql`INSERT INTO conversation_sessions VALUES (${id},${key},'会话','web','private',NULL,NULL,'2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(db.db)
      await sql`INSERT INTO filesystem_authorization_grants VALUES (${key},'session','1',NULL,'2026-01-01 00:00:00.123455'),(${key},'session','2',NULL,'2026-01-01 00:00:00.123456'),(${key},'session','3',NULL,'2026-01-01 00:00:00.123457'),(${other},'session','4',NULL,'2027-01-01 00:00:00.000000'),(${key},'session','5',NULL,'2026-01-01T08:00:00.123457+08:00')`.execute(db.db)
      const list = createSqlAgentSessionLister(db.db, 'sqlite', { ...runtime, clock: () => '2026-01-01T00:00:00.123456Z' })
      const rows = await list(owner), authorized = new Map(rows.map(row => [row.id, row.filesystemAuthorized]))
      assert.deepEqual([...authorized].sort(([a], [b]) => Number(a) - Number(b)), [[1, false], [2, false], [3, true], [4, false], [5, true]])
    } finally { await db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('真实 SQLite v6 明确未装配工作区时可列出无绑定会话，启用缺失能力则拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-list-v6-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime: db, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', '')
      await sql`INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (${owner},'本地会话',0,'','web',1,'2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(db.db)
      const base = { activeStatuses: async () => new Map<number, boolean>(), workspaceShellSupported: () => false, filesystemAuthorizationEnabled: () => false }
      const list = createSqlAgentSessionLister(db.db, 'sqlite', { ...base, sqliteWorkspace: 'unavailable' })
      const rows = await list(ownerId)
      assert.equal(rows.length, 1); assert.equal(rows[0]?.workspaceName, null); assert.equal(rows[0]?.filesystemAuthorized, false)
      assert.deepEqual(await list(randomUUID()), [])
      await assert.rejects(createSqlAgentSessionLister(db.db, 'sqlite', base)(ownerId), /未明确装配/)
      await assert.rejects(createSqlAgentSessionLister(db.db, 'sqlite', { ...base, sqliteWorkspace: 'unavailable', workspaceShellSupported: () => true })(ownerId), /工作区存储未装配/)
      await assert.rejects(createSqlAgentSessionLister(db.db, 'sqlite', { ...base, sqliteWorkspace: 'available' })(ownerId), /所需数据表尚未初始化/)
      await assert.rejects(createSqlAgentSessionLister(db.db, 'sqlite', { ...base, sqliteWorkspace: 'unavailable', filesystemAuthorizationEnabled: () => true })(ownerId), /所需数据表尚未初始化/)
      await assert.rejects(createSqlAgentSessionLister(db.db, 'sqlite', { ...base, sqliteWorkspace: 'unavailable', filesystemAuthorizationEnabled: () => true })(randomUUID()), /所需数据表尚未初始化/)
    } finally { await db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未装配工作区时拒绝有绑定的旧库，包括被列表上限隐藏的会话', async () => {
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
  try {
    await sql`CREATE TABLE conversation_sessions(id integer primary key,user_id text,title text,source text,chat_type text,workspace_id integer,session_context text,updated_at text,created_at text)`.execute(db)
    await sql`CREATE TABLE conversation_messages(id integer primary key,session_id integer,role text,content text,content_json text,files text,conversation_seq integer)`.execute(db)
    const owner = randomUUID(), key = owner.replaceAll('-', '')
    await sql`INSERT INTO conversation_sessions VALUES (1,${key},'旧绑定','web','private',42,NULL,'2000-01-01 00:00:00.000000','2000-01-01 00:00:00.000000')`.execute(db)
    for (let i = 0; i < 50; i++) await sql`INSERT INTO conversation_sessions VALUES (${i + 2},${key},'新会话','web','private',NULL,NULL,'2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(db)
    const list = createSqlAgentSessionLister(db, 'sqlite', { sqliteWorkspace: 'unavailable', activeStatuses: async () => new Map(), filesystemAuthorizationEnabled: () => false, workspaceShellSupported: () => false })
    await assert.rejects(list(owner), /未支持的工作区绑定/)
    assert.deepEqual(await list(randomUUID()), [])
  } finally { await db.destroy() }
})

test('SQLite 时间先校验全部会话再分页，拒绝隐藏的非法或非规范 offset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-session-time-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime: db, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', '')
      for (let i = 0; i < 52; i++) {
        const timestamp = i === 51 ? '2025-01-01 00:00:00.000000' : `2026-01-01 00:00:00.${String(i).padStart(6, '0')}`
        await sql`INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (${owner},${`会话${i}`},0,'','web',1,${timestamp},${timestamp})`.execute(db.db)
      }
      const list = createSqlAgentSessionLister(db.db, 'sqlite', { sqliteWorkspace: 'unavailable', activeStatuses: async () => new Map(), filesystemAuthorizationEnabled: () => false, workspaceShellSupported: () => false })
      const rows = await list(ownerId)
      assert.equal(rows.length, 50); assert.equal(rows[0]?.updatedAt, '2026-01-01T00:00:00.00005Z'); assert.equal(rows[1]?.updatedAt, '2026-01-01T00:00:00.000049Z')
      await sql`UPDATE conversation_sessions SET session_context='not-json' WHERE title='会话50'`.execute(db.db)
      await assert.rejects(list(ownerId), /会话上下文数据格式无效/)
      await sql`UPDATE conversation_sessions SET session_context='null' WHERE title='会话50'`.execute(db.db)
      assert.equal((await list(ownerId))[0]?.goalStatus, null)
      await sql`UPDATE conversation_sessions SET session_context='[]' WHERE title='会话50'`.execute(db.db)
      assert.equal((await list(ownerId))[0]?.goalStatus, null)
      await sql`UPDATE conversation_sessions SET session_context='\"文字\"' WHERE title='会话50'`.execute(db.db)
      assert.equal((await list(ownerId))[0]?.goalStatus, null)
      await sql`UPDATE conversation_sessions SET created_at='not-a-date' WHERE title='会话51'`.execute(db.db)
      await assert.rejects(list(ownerId), /数据时间格式无效/)
      await sql`UPDATE conversation_sessions SET created_at='2025-01-01T08:00:00.000000+08:00' WHERE title='会话51'`.execute(db.db)
      await assert.rejects(list(ownerId), /会话时间不是规范 UTC 微秒格式/)
      await sql`UPDATE conversation_sessions SET created_at='2025-01-01 00:00:00.000000',updated_at='2025-01-01T08:00:00.000000+08:00' WHERE title='会话51'`.execute(db.db)
      await assert.rejects(list(ownerId), /会话时间不是规范 UTC 微秒格式/)
    } finally { await db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
