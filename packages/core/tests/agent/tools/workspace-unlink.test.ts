import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { createWorkspaceDirectoryDeleteTool, createWorkspaceUnlinkTool, type WorkspaceDirectoryDeletePort, type WorkspaceDirectoryDeletePreview, type WorkspaceUnlinkConfirmation } from '../../../src/agent/tools/workspaces.js'
import { createAgentWorkspaceQueries } from '../../../src/workspaces/workspace-list.js'
import { createKyselyAgentWorkspaceReader } from '../../../src/workspaces/workspace-list-store.js'

let core: SqlDataRuntime, folder: string, owner: string, other: string, registry: ReturnType<typeof createToolRegistry>
let prepared = 0, claimed = 0
const identity = () => ({ ownerId: owner, sessionId: '17', runId: 'unlink-run' })
const call = (input: unknown) => ({ id: 'unlink-1', name: 'unlink_workspace', input })
const query = (statement: string) => sql.raw<Record<string, unknown>>(statement).execute(core.db)
function confirmation(action = 'unlink_workspace'): WorkspaceUnlinkConfirmation {
  return {
    gate: {
      async prepare() { prepared++; return { ok: true, value: { id: 'interaction', kind: 'confirmation', toolCall: call({ workspace_id: 1 }) } } },
      async verify() { return { ok: true, value: { intentId: 'intent', operationId: 'op', interactionId: 'interaction', receiptId: 'receipt', binding: {}, purpose: 'action', action, targetsDigest: 'targets', versionsDigest: 'versions', authorizationEpoch: 'epoch', expiresAt: Date.now() + 60_000 } } },
    },
    async claim() { claimed++; return true },
  } as unknown as WorkspaceUnlinkConfirmation
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-workspace-unlink-'))
  await initializeSqlite(join(folder, 'core.db'))
  const opened = await openSqliteRuntime(join(folder, 'core.db'))
  core = opened.runtime; owner = opened.ownerId; other = randomUUID(); prepared = 0; claimed = 0
  const ownerKey = owner.replaceAll('-', ''), otherKey = other.replaceAll('-', '')
  await query('CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,deleted_at TEXT)')
  await query('CREATE TABLE IF NOT EXISTS workspace_directories(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,directory_name TEXT,is_system INTEGER,is_default INTEGER,deleted_at TEXT,created_at TEXT,updated_at TEXT)')
  await query("CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,folder_id INTEGER,project_id INTEGER,directory_id INTEGER,enabled INTEGER,is_default INTEGER,created_at TEXT,updated_at TEXT)")
  await query(`INSERT INTO workspace_directories VALUES(7,'${ownerKey}','保留目录','fixed',0,0,NULL,'2026-01-01','2026-01-01')`)
  await query(`INSERT INTO workspaces VALUES(1,'${ownerKey}','对话工作区','directory',NULL,NULL,7,1,0,'2026-01-01','2026-01-01'),(2,'${otherKey}','他人工作区','directory',NULL,NULL,7,1,0,'2026-01-01','2026-01-01')`)
  const workspaces = createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(core.db, 'sqlite'))
  registry = createToolRegistry({ groups: [{ id: 'workspaces', name: '工作区', tools: [createWorkspaceUnlinkTool(core, workspaces, confirmation())] }], authorize: async () => true })
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

it('先请求持久确认；确认后仅解除owner绑定并停用普通任务，保留提醒、他人引用和目标目录', async () => {
  const request = call({ workspace_id: 1 })
  const base = { identity: identity(), roundId: 'round-1', signal: new AbortController().signal, execute: async () => { throw new Error('不执行进程') } }
  expect(await registry.tools.dispatch(request, { ...base, resolution: null })).toMatchObject({ kind: 'waiting' })
  expect(prepared).toBe(1)
  expect((await query('SELECT id FROM workspaces ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }])
  const result = await registry.tools.dispatch(request, { ...base, resolution: { status: 'confirmed', interactionId: 'interaction', receiptId: 'receipt' } as never })
  expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { success: true, deleted_workspace_id: 1, name: '对话工作区' } })
  expect(claimed).toBe(1)
  expect((await query('SELECT id FROM workspaces ORDER BY id')).rows).toEqual([{ id: 2 }])
  expect((await query('SELECT id FROM conversation_sessions ORDER BY id')).rows).toEqual([])
  expect((await query('SELECT id FROM scheduled_tasks ORDER BY id')).rows).toEqual([])
  expect((await query('SELECT id,directory_name FROM workspace_directories')).rows).toEqual([{ id: 7, directory_name: 'fixed' }])
})

it('拒绝异主和非法参数；确认后响应丢失只查收据，不重复删除', async () => {
  const scope = { identity: identity(), roundId: 'round-1', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不执行进程') } }
  expect(await registry.tools.dispatch(call({ workspace_id: 2 }), { ...scope, resolution: null })).toMatchObject({ kind: 'completed', successful: false, value: { error: '工作区不存在；workspace_id 不是 directory_id、project_id 或 folder_id' } })
  expect(await registry.tools.dispatch(call({ workspace_id: -1 }), scope)).toMatchObject({ kind: 'completed', successful: false })
  const operate = core.operationWithTransaction.bind(core)
  let calls = 0
  vi.spyOn(core, 'operationWithTransaction').mockImplementation(async (...args) => {
    calls++
    if (calls === 2) { await operate(...args); throw new Error('合成提交应答丢失') }
    return operate(...args)
  })
  const result = await registry.tools.dispatch(call({ workspace_id: 1 }), { ...scope, resolution: { status: 'confirmed', interactionId: 'interaction', receiptId: 'receipt' } as never })
  expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false })
  expect(claimed).toBe(1)
  expect((await query('SELECT id FROM workspaces WHERE user_id=?'.replace('?', `'${owner.replaceAll('-', '')}'`))).rows).toEqual([])
})

it('物理目录删除先请求绑定计数快照的确认，再把固定快照交给Host删除端口', async () => {
  const preview: WorkspaceDirectoryDeletePreview = { id: 7, name: '工作目录', directory_name: 'fixed-segment',
    is_default: false, is_system: false, file_count: 3, folder_count: 2, bound_session_count: 4, bound_task_count: 1 }
  const applied: unknown[] = []
  const port: WorkspaceDirectoryDeletePort = {
    async preview(_identity, id) { return id === preview.id ? preview : null },
    async apply(input) { applied.push(input); return { kind: 'completed', successful: true, mutated: true,
      value: { success: true, deleted_directory_id: input.directoryId, name: input.preview.name } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const tool = createWorkspaceDirectoryDeleteTool(port, confirmation('delete_workspace_directory'))
  const deleteRegistry = createToolRegistry({ groups: [{ id: 'workspaces', name: '工作区', tools: [tool] }], authorize: async () => true })
  const request = { id: 'delete-directory', name: 'delete_workspace_directory', input: { directory_id: 7 } }
  const base = { identity: identity(), roundId: 'round-delete', signal: new AbortController().signal, execute: async () => { throw new Error('不执行进程') } }
  expect(await deleteRegistry.tools.dispatch(request, { ...base, resolution: null })).toMatchObject({ kind: 'waiting' })
  expect(applied).toHaveLength(0)
  expect(await deleteRegistry.tools.dispatch(request, { ...base, resolution: { status: 'confirmed', interactionId: 'interaction', receiptId: 'receipt' } as never }))
    .toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { deleted_directory_id: 7 } })
  expect(applied).toHaveLength(1)
  expect(applied[0]).toMatchObject({ directoryId: 7, preview, confirmation: { action: 'delete_workspace_directory' } })
})

it('确认重试优先读取持久结果；目录已移除时不要求重新预览', async () => {
  const preview: WorkspaceDirectoryDeletePreview = { id: 8, name: '已删除目录', directory_name: 'removed',
    is_default: false, is_system: false, file_count: 0, folder_count: 0, bound_session_count: 0, bound_task_count: 0 }
  let previews = 0
  const port: WorkspaceDirectoryDeletePort = {
    async preview() { previews++; return null },
    async apply() { throw new Error('持久结果已存在，不应再次应用') },
    async reconcile(input) {
      expect(input).toMatchObject({ directoryId: 8, toolCallId: 'retry-delete' })
      return { kind: 'completed', successful: true, mutated: false,
        value: { success: true, deleted_directory_id: 8, name: preview.name } }
    },
  }
  const tool = createWorkspaceDirectoryDeleteTool(port, confirmation('delete_workspace_directory'))
  const deleteRegistry = createToolRegistry({ groups: [{ id: 'workspaces', name: '工作区', tools: [tool] }], authorize: async () => true })
  const result = await deleteRegistry.tools.dispatch({ id: 'retry-delete', name: 'delete_workspace_directory', input: { directory_id: 8 } }, {
    identity: identity(), roundId: 'round-delete', signal: new AbortController().signal,
    resolution: { status: 'confirmed', interactionId: 'interaction', receiptId: 'receipt' } as never,
    execute: async () => { throw new Error('不执行进程') },
  })
  expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false, value: { deleted_directory_id: 8 } })
  expect(previews).toBe(0)
})
