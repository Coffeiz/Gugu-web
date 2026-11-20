import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseError } from 'pg'
import { configureDiagnosticLog } from '../../src/shared/log-files.js'
import { createToolRegistry, createWorkspaceTool } from '@gugu/core/tools'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { AgentDispatchLease } from '../../src/modules/agent/run/dispatch.js'
import { createWebAgentWorkspaceCreatePort } from '../../src/modules/agent/tools/workspaces/create.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '22', runId: 'workspace-create-run' }
const lease = { identity, token: 'lease', fence: 1, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as AgentDispatchLease
const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
  execute: async () => { throw new Error('工作区工具不得调用宿主执行器') } }
let folder = ''
let core: SqlDataRuntime
let leaseActive = true
const pool = { async query() { return { rowCount: leaseActive ? 1 : 0, rows: leaseActive ? [{}] : [] } } } as never

async function setup() {
  folder = await mkdtemp(join(tmpdir(), 'gugu-workspace-create-'))
  await initializeSqlite(join(folder, 'core.db'))
  core = (await openSqliteRuntime(join(folder, 'core.db'))).runtime
  leaseActive = true
}
async function cleanup() {
  await core?.close()
  if (folder) await rm(folder, { recursive: true, force: true })
}
function hostPort(overrides: Record<string, unknown> = {}) {
  return createWebAgentWorkspaceCreatePort({
    core, pool, lease,
    async createDeclaration(ownerId, input) { return { id: input.projectId ?? input.folderId ?? Number(ownerId.length) } },
    async createDirectory(_ownerId, name) { return { id: name.length } },
    async readWorkspace(ownerId, id) { return { workspace_id: id, name: '文件夹绑定', kind: 'folder', folder_id: 19, owner: ownerId } },
    async listWorkspaces(ownerId) { return [{ id: 61, kind: 'directory', directory_id: 81, name: '物理目录', owner: ownerId }] },
    ...overrides,
  })
}

test('真实 ToolRegistry dispatch 将三种工作区创建委托给 Host 领域操作，并持久回放调用结果', async t => {
  await setup()
  t.after(cleanup)
  const calls: unknown[] = []
  const port = hostPort({
    async createDeclaration(ownerId: string, input: { name: string; kind: 'project' | 'folder'; projectId?: number; folderId?: number; enabled: boolean }) { calls.push(['declaration', ownerId, input]); return { id: 51 } },
    async createDirectory(ownerId: string, name: string) { calls.push(['directory', ownerId, name]); return { id: 81 } },
    async readWorkspace(ownerId, id) { return { workspace_id: id, name: '文件夹绑定', kind: 'folder', folder_id: 19, owner: ownerId } },
    async listWorkspaces(ownerId) { return [{ id: 61, kind: 'directory', directory_id: 81, name: '物理目录', owner: ownerId }] },
  })
  const registry = createToolRegistry({ groups: [{ id: 'workspaces', name: '工作区', tools: [createWorkspaceTool(port)] }], authorize: async () => true })
  const dispatch = (input: unknown, id = 'create') => registry.tools.dispatch({ id, name: 'create_workspace', input }, scope)

  const project = await dispatch({ workspace_name: '项目绑定', kind: 'project', project_id: 17, enabled: false }, 'project')
  assert.equal(project.kind, 'completed')
  assert.equal(project.kind === 'completed' && project.successful, true, JSON.stringify(project))
  assert.deepEqual(calls[0], ['declaration', identity.ownerId, { name: '项目绑定', kind: 'project', projectId: 17, enabled: false }])

  const folder = await dispatch({ workspace_name: '文件夹绑定', kind: 'folder', folder_id: 19 }, 'folder')
  assert.deepEqual(folder.kind === 'completed' ? folder.value : null, { success: true, workspace: {
    workspace_id: 51, name: '文件夹绑定', kind: 'folder', folder_id: 19, owner: identity.ownerId,
  } })
  assert.deepEqual(calls[1], ['declaration', identity.ownerId, { name: '文件夹绑定', kind: 'folder', folderId: 19, enabled: true }])

  const directory = await dispatch({ workspace_name: '物理目录', kind: 'directory' }, 'directory')
  assert.deepEqual(directory.kind === 'completed' ? directory.value : null, { success: true, workspace: {
    id: 61, kind: 'directory', directory_id: 81, name: '物理目录', owner: identity.ownerId,
  } })
  assert.deepEqual(calls[2], ['directory', identity.ownerId, '物理目录'])
  const replay = await dispatch({ workspace_name: '物理目录', kind: 'directory' }, 'directory')
  assert.deepEqual(replay.kind === 'completed' ? replay.value : replay, { success: true, workspace: {
    id: 61, kind: 'directory', directory_id: 81, name: '物理目录', owner: identity.ownerId,
  } })
  assert.equal(calls.length, 3, '重放只读持久回执，不能再次创建目录')
  assert.deepEqual(await port.reconcile({ identity, roundId: 'round-1', toolCallId: 'directory', args: { workspace_name: '物理目录', kind: 'directory' } }), {
    kind: 'completed', successful: true, mutated: false, value: { success: true, workspace: {
      id: 61, kind: 'directory', directory_id: 81, name: '物理目录', owner: identity.ownerId,
    } },
  })
})

test('Web 端口拒绝不同 lease 或已失效的 dispatch，不调用工作区领域服务', async t => {
  await setup()
  t.after(cleanup)
  let called = false
  const port = hostPort({
    async createDeclaration() { called = true; return { id: 1 } },
    async createDirectory() { called = true; return { id: 1 } },
    async readWorkspace() { return null }, async listWorkspaces() { return [] },
  })
  const foreign = await port.create({ identity: { ...identity, sessionId: '23' }, roundId: 'round-1', toolCallId: 'bad', args: { workspace_name: '目录', kind: 'directory' }, signal: new AbortController().signal })
  assert.deepEqual(foreign.kind === 'completed' ? foreign.value : foreign, { error: '工作区创建授权已失效' })
  leaseActive = false
  const expired = await port.create({ identity, roundId: 'round-1', toolCallId: 'expired', args: { workspace_name: '目录', kind: 'directory' }, signal: new AbortController().signal })
  assert.deepEqual(expired.kind === 'completed' ? expired.value : expired, { error: '工作区创建授权已失效' })
  assert.equal(called, false)
})

test('取消的调用在持久预留和领域副作用前停止', async t => {
  await setup()
  t.after(cleanup)
  let calls = 0
  const port = hostPort({ async createDirectory() { calls++; return { id: 1 } } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(port.create({ identity, roundId: 'round-1', toolCallId: 'cancelled',
    args: { workspace_name: '目录', kind: 'directory' }, signal: controller.signal }))
  assert.equal(calls, 0)
})

test('持久预留后创建结果未知时只返回 unknown，重派同一调用不会重复副作用', async t => {
  await setup()
  t.after(cleanup)
  let calls = 0
  const port = hostPort({ async createDirectory() { calls++; throw new Error('创建响应未知') } })
  const request = { identity, roundId: 'round-1', toolCallId: 'uncertain', args: { workspace_name: '目录', kind: 'directory' as const } }
  assert.deepEqual(await port.create({ ...request, signal: new AbortController().signal }), { kind: 'unknown' })
  assert.deepEqual(await port.reconcile(request), { kind: 'unknown' })
  assert.deepEqual(await port.create({ ...request, signal: new AbortController().signal }), { kind: 'unknown' })
  assert.deepEqual(await port.create({ ...request, args: { ...request.args, workspace_name: '改参目录' }, signal: new AbortController().signal }), { kind: 'unknown' })
  assert.equal(calls, 1)
})

test('并发重派同一个调用最多执行一次创建，旁路重放只读最终回执', async t => {
  await setup()
  t.after(cleanup)
  let calls = 0
  const port = hostPort({ async createDirectory() {
    calls++
    await new Promise(resolve => setTimeout(resolve, 30))
    return { id: 81 }
  } })
  const request = { identity, roundId: 'round-1', toolCallId: 'parallel', args: { workspace_name: '目录', kind: 'directory' as const } }
  const [first, second] = await Promise.all([
    port.create({ ...request, signal: new AbortController().signal }),
    port.create({ ...request, signal: new AbortController().signal }),
  ])
  assert.equal(calls, 1)
  assert.ok(first.kind === 'completed' || first.kind === 'unknown')
  assert.ok(second.kind === 'completed' || second.kind === 'unknown')
  assert.deepEqual(await port.reconcile(request), { kind: 'completed', successful: true, mutated: false,
    value: { success: true, workspace: { id: 61, kind: 'directory', directory_id: 81, name: '物理目录', owner: identity.ownerId } } })
})


test('工作区创建失败保留未知结果，并记录可关联 Run 的脱敏数据库原因', async t => {
  await setup()
  t.after(cleanup)
  configureDiagnosticLog(join(folder, 'web.log'))
  const error = new DatabaseError('合成工作区名称不应写入日志', 0, 'error')
  Object.assign(error, { code: '23502', table: 'workspaces', column: 'created_at', detail: '合成私有错误详情' })
  const port = hostPort({ async createDeclaration() { throw error } })
  const outcome = await port.create({ identity, roundId: 'round-1', toolCallId: 'sql-failure',
    args: { workspace_name: '合成用户输入', kind: 'project', project_id: 17 }, signal: new AbortController().signal })
  assert.deepEqual(outcome, { kind: 'unknown' })
  const log = await readFile(join(folder, 'gugu-diag.log'), 'utf8')
  const payload = JSON.parse(log.split(' | ')[1]!)
  assert.deepEqual(payload, {
    run_id: identity.runId, phase: 'create_declaration', reason: 'operation_failed',
    sqlstate: '23502', table: 'workspaces', column: 'created_at',
  })
  assert.doesNotMatch(log, /合成|owner_id/)
})
