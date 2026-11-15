import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceBindings } from '../../../src/workspaces/workspace-bindings.js'
import { createKyselyWorkspaceBindingRuntime } from '../../../src/workspaces/workspace-bindings-store.js'
import type { WorkspaceBindingTables } from '../../../src/workspaces/workspace-bindings-store.js'

// 合成表只验证真实SQL绑定端口，不代表正式SQLite schema迁移或Host接线。
let directory: string, native: SQLite.Database, db: Kysely<WorkspaceBindingTables>
let owner: string, other: string, queries: number
const key = (value: string) => value.replaceAll('-', '')
function session(id: number, user = owner, workspaceId: number | null = null) {
  native.prepare('INSERT INTO conversation_sessions(id,user_id,workspace_id) VALUES (?,?,?)').run(id, key(user), workspaceId)
}
function workspace(id: number, user = owner, enabled = true) {
  native.prepare('INSERT INTO workspaces(id,user_id,name,kind,folder_id,project_id,directory_id,enabled,is_default,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, key(user), '工作区' + id, 'directory', null, null, id + 10, Number(enabled), 0, '2026-01-01')
}
function saved(id = 1) {
  return native.prepare('SELECT workspace_id FROM conversation_sessions WHERE id=?').get(id) as { workspace_id: number | null }
}
function operations() { return createWorkspaceBindings(createKyselyWorkspaceBindingRuntime(db, 'sqlite')) }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gugu-workspace-binding-'))
  native = new SQLite(join(directory, 'bindings.db'))
  native.exec('CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,folder_id INTEGER,project_id INTEGER,directory_id INTEGER,enabled INTEGER,is_default INTEGER,updated_at TEXT);'
    + 'CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT,workspace_id INTEGER);')
  owner = randomUUID(); other = randomUUID(); queries = 0
  db = new Kysely<WorkspaceBindingTables>({ dialect: new SqliteDialect({ database: native }), log() { queries++ } })
})
afterEach(async () => { await db?.destroy(); if (native?.open) native.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

describe('工作区绑定真实临时SQLite事务', () => {
  it('bind持久写入与固定count1，current返回count0，unbind实际清空', async () => {
    workspace(1); session(1); session(2, owner, 1)
    const api = operations()
    expect(await api.bind(owner.toUpperCase(), 1, 1)).toEqual({ id: 1, name: '工作区1', kind: 'directory', folderId: null,
      projectId: null, directoryId: 11, enabled: true, isDefault: false, boundSessionCount: 1 })
    expect(saved()).toEqual({ workspace_id: 1 })
    expect(await api.current(owner, 1)).toMatchObject({ id: 1, boundSessionCount: 0 })
    await api.unbind(owner, 1)
    expect(saved()).toEqual({ workspace_id: null })
    expect(await api.current(owner, 1)).toBeNull()
    expect(saved(2)).toEqual({ workspace_id: 1 })
  })
  it('停用项current仍可见，但新的bind拒绝且不修改原绑定', async () => {
    workspace(1, owner, false); session(1, owner, 1); session(2)
    const api = operations()
    expect(await api.current(owner, 1)).toMatchObject({ id: 1, enabled: false })
    await expect(api.bind(owner, 1, 2)).rejects.toMatchObject({ code: 'not_found' })
    expect(saved(2).workspace_id).toBeNull()
  })
  it('他人会话和工作区拒绝；错误跨owner历史绑定current隐藏目标', async () => {
    workspace(1); workspace(2, other); session(1); session(2, other); session(3, owner, 2)
    const api = operations()
    await expect(api.bind(owner, 1, 2)).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.bind(owner, 2, 1)).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.unbind(owner, 2)).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.current(owner, 2)).rejects.toMatchObject({ code: 'not_found' })
    expect(await api.current(owner, 3)).toBeNull()
    expect(saved(2).workspace_id).toBeNull()
    expect(saved(3).workspace_id).toBe(2)
  })
  it('不存在会话报错，无绑定和已消失工作区返回null', async () => {
    session(1); session(2, owner, 999)
    const api = operations()
    await expect(api.current(owner, 999)).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.bind(owner, 999, 1)).rejects.toMatchObject({ code: 'not_found' })
    expect(await api.current(owner, 1)).toBeNull()
    expect(await api.current(owner, 2)).toBeNull()
  })
  it.each([0, -1])('整数ID%s保持not_found，不扩大为默认目标', async id => {
    workspace(1); session(1)
    const api = operations()
    await expect(api.bind(owner, id, 1)).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.bind(owner, 1, id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(api.unbind(owner, id)).rejects.toMatchObject({ code: 'not_found' })
    expect(saved().workspace_id).toBeNull()
  })
  it.each([1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('非safe整数ID%s在SQL前拒绝', async id => {
    await expect(operations().bind(owner, id, 1)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(queries).toBe(0)
  })
  it('非法owner与预取消在SQL前拒绝，不启动事务', async () => {
    await expect(operations().current('invalid-owner', 1)).rejects.toMatchObject({ code: 'invalid_request' })
    const controller = new AbortController(), reason = new Error('合成预取消')
    controller.abort(reason)
    await expect(operations().bind(owner, 1, 1, { signal: controller.signal })).rejects.toBe(reason)
    expect(queries).toBe(0)
  })
  it('写入后故障回滚且连接仍可用', async () => {
    workspace(1); session(1)
    const runtime = createKyselyWorkspaceBindingRuntime(db, 'sqlite'), reason = new Error('合成事务故障')
    await expect(runtime.transaction(async tx => { await tx.setWorkspace(owner, 1, 1); throw reason })).rejects.toBe(reason)
    expect(saved().workspace_id).toBeNull()
    await operations().bind(owner, 1, 1)
    expect(saved().workspace_id).toBe(1)
  })
  it('事务内写入后取消在commit前回滚，owner限定UPDATE不能修改他人会话', async () => {
    workspace(1); session(1); session(2, other)
    const runtime = createKyselyWorkspaceBindingRuntime(db, 'sqlite'), controller = new AbortController(), reason = new Error('合成事务取消')
    await expect(runtime.transaction(async tx => {
      await tx.setWorkspace(owner, 1, 1)
      controller.abort(reason)
    }, { signal: controller.signal })).rejects.toBe(reason)
    expect(saved().workspace_id).toBeNull()
    await runtime.transaction(tx => tx.setWorkspace(owner, 2, 1))
    expect(saved(2).workspace_id).toBeNull()
  })
})
