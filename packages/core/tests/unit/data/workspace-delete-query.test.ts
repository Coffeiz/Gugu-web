import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceDeleter } from '../../../src/workspaces/workspace-delete.js'
import { createKyselyWorkspaceDeletionRuntime } from '../../../src/workspaces/workspace-delete-store.js'
import type { WorkspaceDeletionTables } from '../../../src/workspaces/workspace-delete-store.js'

// 合成最小表及单列FK匹配旧Host回归，不代表正式SQLite schema、复合owner FK或PG验收。
let directory: string, native: SQLite.Database, db: Kysely<WorkspaceDeletionTables>
let owner: string, other: string, queries: number
const key = (value: string) => value.replaceAll('-', '')
function runtime() { return createKyselyWorkspaceDeletionRuntime(db, 'sqlite') }
function deleter() { return createWorkspaceDeleter(runtime()) }
function rows(table: string) { return native.prepare(`SELECT * FROM ${table} ORDER BY id`).all() }
function snapshot() {
  return Object.fromEntries(['workspaces', 'conversation_sessions', 'scheduled_tasks', 'file_sync_bindings', 'terminal_sessions', 'projects'].map(table => [table, rows(table)]))
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gugu-workspace-delete-'))
  native = new SQLite(join(directory, 'deletion.db'))
  native.pragma('foreign_keys = ON')
  native.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT,project_id INTEGER REFERENCES projects(id));
    CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT,workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL);
    CREATE TABLE scheduled_tasks(id INTEGER PRIMARY KEY,user_id TEXT,workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,event_id INTEGER,enabled INTEGER);
    CREATE TABLE file_sync_bindings(id INTEGER PRIMARY KEY,user_id TEXT,workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE);
    CREATE TABLE terminal_sessions(id INTEGER PRIMARY KEY,owner_id TEXT,workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,running INTEGER);
  `)
  owner = randomUUID(); other = randomUUID(); queries = 0
  native.prepare('INSERT INTO projects VALUES (?,?)').run(9, '保留项目')
  const workspace = native.prepare('INSERT INTO workspaces VALUES (?,?,9)')
  workspace.run(1, key(owner)); workspace.run(2, key(other)); workspace.run(3, key(owner))
  const session = native.prepare('INSERT INTO conversation_sessions VALUES (?,?,?)')
  session.run(11, key(owner), 1); session.run(12, key(other), 1); session.run(13, key(owner), 3); session.run(14, key(other), 2)
  const task = native.prepare('INSERT INTO scheduled_tasks VALUES (?,?,?,?,1)')
  task.run(21, key(owner), 1, null); task.run(22, key(owner), 1, 7); task.run(23, key(other), 1, null)
  task.run(24, key(owner), 3, null); task.run(25, key(other), 2, null)
  native.prepare('INSERT INTO file_sync_bindings VALUES (?,?,?)').run(31, key(owner), 1)
  native.prepare('INSERT INTO file_sync_bindings VALUES (?,?,?)').run(32, key(other), 2)
  native.prepare('INSERT INTO terminal_sessions VALUES (?,?,?,1)').run(41, key(owner), 1)
  await writeFile(join(directory, '保留文件.txt'), '实际文件保留')
  db = new Kysely<WorkspaceDeletionTables>({ dialect: new SqliteDialect({ database: native }), log() { queries++ } })
})
afterEach(async () => { await db?.destroy(); if (native?.open) native.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

describe('工作区删除真实SQLite事务与单列FK副作用', () => {
  it('只主动停用owner普通任务，关联提醒和错误owner引用仅由FK解绑，不触及父资源或文件', async () => {
    expect(await deleter()(owner.toUpperCase(), 1)).toEqual({ ok: true, workspaceId: 1 })
    expect(rows('workspaces')).toEqual([{ id: 2, user_id: key(other), project_id: 9 }, { id: 3, user_id: key(owner), project_id: 9 }])
    expect(rows('conversation_sessions')).toEqual([
      { id: 11, user_id: key(owner), workspace_id: null }, { id: 12, user_id: key(other), workspace_id: null },
      { id: 13, user_id: key(owner), workspace_id: 3 }, { id: 14, user_id: key(other), workspace_id: 2 },
    ])
    expect(rows('scheduled_tasks')).toEqual([
      { id: 21, user_id: key(owner), workspace_id: null, event_id: null, enabled: 0 },
      { id: 22, user_id: key(owner), workspace_id: null, event_id: 7, enabled: 1 },
      { id: 23, user_id: key(other), workspace_id: null, event_id: null, enabled: 1 },
      { id: 24, user_id: key(owner), workspace_id: 3, event_id: null, enabled: 1 },
      { id: 25, user_id: key(other), workspace_id: 2, event_id: null, enabled: 1 },
    ])
    expect(rows('file_sync_bindings')).toEqual([{ id: 32, user_id: key(other), workspace_id: 2 }])
    expect(rows('terminal_sessions')).toEqual([{ id: 41, owner_id: key(owner), workspace_id: null, running: 1 }])
    expect(rows('projects')).toEqual([{ id: 9, name: '保留项目' }])
    expect(await readFile(join(directory, '保留文件.txt'), 'utf8')).toBe('实际文件保留')
  })
  it('delete之前owner过滤不主动修改他人的错误引用或关联提醒', async () => {
    await runtime().transaction(async tx => {
      await tx.detachSessions(owner, 1)
      await tx.disableOrdinaryTasks(owner, 1)
    })
    expect(rows('conversation_sessions')).toContainEqual({ id: 12, user_id: key(other), workspace_id: 1 })
    expect(rows('scheduled_tasks')).toContainEqual({ id: 23, user_id: key(other), workspace_id: 1, event_id: null, enabled: 1 })
    expect(rows('scheduled_tasks')).toContainEqual({ id: 22, user_id: key(owner), workspace_id: 1, event_id: 7, enabled: 1 })
  })
  it('数据端口直接删除也限定owner，不依赖应用层存在性检查', async () => {
    const before = snapshot()
    await runtime().transaction(async tx => {
      expect(await tx.lockOwnedWorkspace(owner, 2)).toBe(false)
      await tx.deleteDeclaration(owner, 2)
    })
    expect(snapshot()).toEqual(before)
  })
  it.each(['lock', 'sessions', 'tasks', 'delete'])('阶段%s之后故障回滚所有写入和FK副作用', async stage => {
    const before = snapshot(), error = new Error('合成事务故障')
    await expect(runtime().transaction(async tx => {
      expect(await tx.lockOwnedWorkspace(owner, 1)).toBe(true)
      if (stage === 'lock') throw error
      await tx.detachSessions(owner, 1)
      if (stage === 'sessions') throw error
      await tx.disableOrdinaryTasks(owner, 1)
      if (stage === 'tasks') throw error
      await tx.deleteDeclaration(owner, 1)
      throw error
    })).rejects.toBe(error)
    expect(snapshot()).toEqual(before)
    expect(await deleter()(owner, 1)).toEqual({ ok: true, workspaceId: 1 })
  })
  it('全部写入之后提交前取消也回滚外键副作用', async () => {
    const before = snapshot(), controller = new AbortController(), error = new Error('合成写后取消')
    const adapter = runtime()
    const remove = createWorkspaceDeleter({
      transaction: (work, options) => adapter.transaction(tx => work({ ...tx,
        async deleteDeclaration(ownerId, workspaceId) {
          await tx.deleteDeclaration(ownerId, workspaceId)
          controller.abort(error)
        },
      }), options),
    })
    await expect(remove(owner, 1, { signal: controller.signal })).rejects.toBe(error)
    expect(snapshot()).toEqual(before)
  })
  it('真实任务表缺失导致应用删除失败，先前解绑会话必须回滚而非假成功', async () => {
    const before = snapshot()
    native.exec('DROP TABLE scheduled_tasks')
    await expect(deleter()(owner, 1)).rejects.toThrow()
    for (const [table, saved] of Object.entries(before)) {
      if (table !== 'scheduled_tasks') expect(rows(table)).toEqual(saved)
    }
    expect(await readFile(join(directory, '保留文件.txt'), 'utf8')).toBe('实际文件保留')
  })
  it.each([0, -1, 999, 2])('缺失或他人工作区%s不产生副作用', async id => {
    const before = snapshot()
    await expect(deleter()(owner, id)).rejects.toMatchObject({ code: 'not_found' })
    expect(snapshot()).toEqual(before)
  })
  it('非法owner/ID与预取消在SQL前拒绝', async () => {
    const before = snapshot()
    await expect(deleter()('invalid-owner', 1)).rejects.toMatchObject({ code: 'invalid_request' })
    for (const id of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(deleter()(owner, id)).rejects.toMatchObject({ code: 'invalid_request' })
    const controller = new AbortController(), reason = new Error('合成预取消')
    controller.abort(reason)
    await expect(deleter()(owner, 1, { signal: controller.signal })).rejects.toBe(reason)
    let entered = false
    await expect(runtime().transaction(async () => { entered = true }, { signal: controller.signal })).rejects.toBe(reason)
    expect(entered).toBe(false)
    expect(queries).toBe(0)
    expect(snapshot()).toEqual(before)
  })
})
