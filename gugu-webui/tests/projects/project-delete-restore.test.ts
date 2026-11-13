import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import type { UserFromRequest } from '../../src/app.js'
import { createProjectTrashService, ProjectTrashExpiredError } from '../../src/domains/projects/application/project-trash.js'
import {
  createLocalProjectTrashStorage,
  createProjectTrashOriginalStorageKeyResolver,
} from '../../src/domains/projects/persistence/project-trash-storage.js'
import { registerProjectRoutes } from '../../src/domains/projects/routes/projects.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'
const deletedAt = '2026-11-13T00:00:00.000Z'

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 17, user_id: ownerId, name: '回归项目', summary: null, client: null,
    status: 'pending', start_date: '2026-11-01', deadline: null,
    color: 'linear-gradient(135deg,#7b7fb2,#c4afc8)', progress: 0,
    stages_json: '[]', current_stage: null, priority: null, archived: false,
    version: 3, done_at: null, created_at: deletedAt, updated_at: deletedAt,
    deleted_at: null,
    ...overrides,
  }
}

function baseState() {
  return {
    project: project(),
    folders: [{ id: 31, user_id: ownerId, project_id: 17, workspace_directory_id: null,
      parent_id: null, name: '文档', version: 2, deleted_at: null }],
    files: [{ id: 41, user_id: ownerId, display_name: '计划', ext: 'md', space: 'project',
      project_id: 17, folder_id: 31, workspace_directory_id: null, stage_name: null,
      mind_map_id: null, storage_key: `${ownerId}/项目文件/2026/11/回归项目 #17/文档/计划.md`,
      version: 4, size: 8, size_bytes: 8, mime_type: 'text/markdown', img_width: null,
      img_height: null, deleted_at: null }, {
      id: 42, user_id: ownerId, display_name: '上次删除', ext: 'txt', space: 'project',
      project_id: 17, folder_id: null, workspace_directory_id: null, stage_name: null,
      mind_map_id: null, storage_key: `${ownerId}/trash/2026/10/上次删除.txt`,
      version: 2, size: 4, size_bytes: 4, mime_type: 'text/plain', img_width: null,
      img_height: null, deleted_at: '2026-10-01T00:00:00.000Z',
    }],
    events: [{ id: 51, user_id: ownerId, title: '交付', date: '2026-11-15', time: null,
      end_time: null, type: 'deadline', client: null, project_id: 17,
      description: '', version: 5, deleted_at: null }],
    tasks: [{ id: 61, user_id: ownerId, event_id: 51, enabled: true, name: '交付提醒',
      payload: '提醒', cron: '0 9 15 11 *', schedule_kind: 'cron', start_at: null,
      reminder_lead_minutes: 60, channels: 'chat', delivery_targets: null }],
  }
}

function makeHarness(initial = baseState()) {
  const state = structuredClone(initial)
  const undo: unknown[] = []
  const published: unknown[] = []
  const storage: unknown[] = []
  let committed = false
  const runtime = {
    async transaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
      committed = false
      const before = structuredClone(state)
      try {
        const result = await work({
        async getOwnedProject(owner: string, id: number) {
          return owner === state.project.user_id && id === state.project.id ? state.project : null
        },
        async listProjectResources(owner: string, id: number, stamp?: string) {
          const same = (row: any) => row.user_id === owner
          const active = (row: any) => row.deleted_at == null
          const deletedInThisOperation = (row: any) => row.deleted_at === stamp
          return {
            folders: state.folders.filter((row: any) => same(row) && row.project_id === id && (stamp ? deletedInThisOperation(row) : active(row))),
            files: state.files.filter((row: any) => same(row) && (row.project_id === id || state.folders.some((folder: any) => folder.id === row.folder_id && folder.project_id === id)) && (stamp ? deletedInThisOperation(row) : active(row))),
            events: state.events.filter((row: any) => same(row) && row.project_id === id && (stamp ? deletedInThisOperation(row) : active(row))),
            tasks: state.tasks.filter((row: any) => same(row) && state.events.some((event: any) => event.id === row.event_id && event.project_id === id)),
          }
        },
        async updateProject(_owner: string, _id: number, fields: Record<string, unknown>) {
          Object.assign(state.project, fields)
          return state.project
        },
        async updateFile(_owner: string, row: any) { Object.assign(state.files.find((item: any) => item.id === row.id)!, row) },
        async updateFolder(_owner: string, row: any) { Object.assign(state.folders.find((item: any) => item.id === row.id)!, row) },
        async updateEvent(_owner: string, row: any) { Object.assign(state.events.find((item: any) => item.id === row.id)!, row) },
        async updateTask(_owner: string, row: any) { Object.assign(state.tasks.find((item: any) => item.id === row.id)!, row) },
        async recordUndo(record: unknown) { undo.push(record) },
        })
        committed = true
        return result
      } catch (error) {
        Object.assign(state, before)
        throw error
      }
    },
    async getProjectFileCount() { return state.files.filter((row: any) => row.deleted_at == null).length },
    async publishResourceChanged(event: unknown) {
      assert.equal(committed, true, '领域事件只能在数据库提交后发布')
      published.push(event)
    },
  }
  const fileStorage = {
    async moveToTrash(owner: string, file: any) {
      storage.push(['trash', owner, file.id, file.storage_key])
      return { storageKey: `${owner}/trash/2026/11/回归项目 #17/文档/计划.md` }
    },
    async restoreFromTrash(owner: string, file: any) {
      storage.push(['restore', owner, file.id, file.storage_key])
      return { storageKey: `${owner}/项目文件/2026/11/回归项目 #17/文档/计划.md`, displayName: file.display_name }
    },
  }
  return { state, undo, published, storage, runtime, fileStorage }
}

test('DELETE 项目按 owner 软删同一批资源、停用提醒、事务内写 Undo 并提交后发布四类事件', async () => {
  const harness = makeHarness()
  const trash = createProjectTrashService(harness.runtime as never, harness.fileStorage as never)
  await trash.deleteProject(ownerId, 17, { undoContextId: 'tab-delete', clientId: 'web-1' })

  const stamp = harness.state.project.deleted_at
  assert.ok(stamp)
  assert.equal(harness.state.project.version, 4)
  for (const row of [...harness.state.folders, harness.state.files[0]!, ...harness.state.events]) {
    assert.equal(row.deleted_at, stamp, '所有关联墓碑使用同一删除时间')
  }
  assert.equal(harness.state.files[0].storage_key, `${ownerId}/trash/2026/11/回归项目 #17/文档/计划.md`)
  assert.equal(harness.state.files[0].version, 5)
  assert.equal(harness.state.folders[0].version, 3)
  assert.equal(harness.state.events[0].version, 6)
  assert.equal(harness.state.tasks[0].enabled, false)
  assert.equal(harness.undo.length, 1)
  const undo = harness.undo[0] as any
  assert.equal(undo.resource, 'projects')
  assert.equal(undo.action, 'delete')
  assert.equal(undo.userId, ownerId)
  assert.equal(undo.contextId, 'tab-delete')
  assert.deepEqual(undo.targetRefs.map(({ kind, id }: any) => `${kind}:${id}`).sort(),
    ['event:51', 'file:41', 'folder:31', 'project:17', 'task:61'])
  assert.deepEqual(harness.published.map((event: any) => [event.resource, event.operation]), [
    ['projects', 'delete'], ['files', 'delete'], ['calendar', 'delete'], ['scheduled_tasks', 'update'],
  ])
  assert.deepEqual(harness.published.map((event: any) => event.entityIds ?? event.entityId), [17, [41, 31], [51], [61]])
})

test('DELETE 只接受当前 owner 的活动项目，重复删除和越权都按 404 隐藏资源', async () => {
  const harness = makeHarness()
  const trash = createProjectTrashService(harness.runtime as never, harness.fileStorage as never)
  await assert.rejects(trash.deleteProject(otherOwnerId, 17), { code: 'not_found' })
  await trash.deleteProject(ownerId, 17)
  await assert.rejects(trash.deleteProject(ownerId, 17), { code: 'not_found' })
})

test('RESTORE 仅恢复相同删除批次、保留物理路径冲突策略并重新启用关联提醒', async () => {
  const harness = makeHarness()
  const trash = createProjectTrashService(harness.runtime as never, harness.fileStorage as never)
  await trash.deleteProject(ownerId, 17)
  const response = await trash.restoreProject(ownerId, 17)
  assert.equal(harness.state.project.deleted_at, null)
  assert.equal(harness.state.project.version, 5)
  assert.equal(harness.state.files[0].deleted_at, null)
  assert.equal(harness.state.files[0].version, 6)
  assert.equal(harness.state.files[0].storage_key, `${ownerId}/项目文件/2026/11/回归项目 #17/文档/计划.md`)
  assert.equal(harness.state.files[1].deleted_at, '2026-10-01T00:00:00.000Z', '旧删除批次的文件不能被恢复')
  assert.equal(harness.state.events[0].deleted_at, null)
  assert.equal(harness.state.tasks[0].enabled, true)
  assert.equal((response as any).id, 17)
  assert.deepEqual(harness.published.slice(-4).map((event: any) => [event.resource, event.operation]), [
    ['projects', 'create'], ['files', 'create'], ['calendar', 'create'], ['scheduled_tasks', 'update'],
  ])
  assert.equal(harness.undo.length, 0, 'Python restore 不写新的 Undo 操作')
})

test('RESTORE 隐藏越权/未删除项目，并对超过 30 天的墓碑返回 410', async () => {
  const expired = makeHarness({ ...baseState(), project: project({ deleted_at: '2026-10-01T00:00:00.000Z' }) })
  const trash = createProjectTrashService(expired.runtime as never, expired.fileStorage as never)
  await assert.rejects(trash.restoreProject(otherOwnerId, 17), { code: 'not_found' })
  await assert.rejects(trash.restoreProject(ownerId, 17), { statusCode: 410 })

  const active = makeHarness()
  const activeTrash = createProjectTrashService(active.runtime as never, active.fileStorage as never)
  await assert.rejects(activeTrash.restoreProject(ownerId, 17), { code: 'not_found' })
})

test('缺失 owner WorkspaceDirectory 使项目 restore 事务回滚并保留全部墓碑', async () => {
  const initial = baseState()
  const workspaceFile = initial.files[0] as Record<string, unknown>
  workspaceFile.space = 'workspace'
  workspaceFile.workspace_directory_id = 27
  const harness = makeHarness(initial)
  const deleted = createProjectTrashService(harness.runtime as never, harness.fileStorage as never)
  await deleted.deleteProject(ownerId, 17)
  const stamp = harness.state.project.deleted_at
  assert.ok(stamp)
  const publishedBeforeRestore = harness.published.length

  const resolver = createProjectTrashOriginalStorageKeyResolver({
    async getOwnedProject() { return null },
    async getOwnedWorkspaceDirectory() { return null },
    async getOwnedMindMap() { return null },
    async resolveOwnedFolderPath() { return null },
  })
  const storage = createLocalProjectTrashStorage('/tmp/project-trash-metadata-test', resolver)
  const restore = createProjectTrashService(harness.runtime as never, storage)
  await assert.rejects(restore.restoreProject(ownerId, 17), /工作区目录不存在/)

  assert.equal(harness.state.project.deleted_at, stamp)
  assert.equal(harness.state.folders[0]!.deleted_at, stamp)
  assert.equal(harness.state.files[0]!.deleted_at, stamp)
  assert.equal(harness.state.events[0]!.deleted_at, stamp)
  assert.equal(harness.state.tasks[0]!.enabled, false)
  assert.equal(harness.published.length, publishedBeforeRestore, '事务失败不发送 restore 事件')
})

test('项目删除/恢复路由传递 owner 和元数据，DELETE 返回空 204', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const calls: unknown[] = []
  const userFromRequest = (() => ({
    id: otherOwnerId, requestContext: { data: { ownerId } },
  })) as unknown as UserFromRequest
  const deleteProject = async (...args: unknown[]) => { calls.push(['delete', ...args]) }
  const restoreProject = async (...args: unknown[]) => {
    calls.push(['restore', ...args])
    return { id: 17, name: '回归项目', deletedAt: null }
  }
  registerProjectRoutes(app, userFromRequest, { deleteProject, restoreProject })
  try {
    const deleted = await app.inject({
      method: 'DELETE', url: '/api/v1/projects/17',
      headers: { 'x-undo-context-id': 'tab-1', 'x-client-id': 'web-1' },
    })
    const restored = await app.inject({
      method: 'POST', url: '/api/v1/projects/17/restore',
      headers: { 'x-client-id': 'web-2' },
    })
    assert.equal(deleted.statusCode, 204)
    assert.equal(deleted.body, '')
    assert.equal(restored.statusCode, 200)
    assert.deepEqual(calls, [
      ['delete', ownerId, 17, { idempotencyKey: null, undoContextId: 'tab-1', clientId: 'web-1' }],
      ['restore', ownerId, 17, { idempotencyKey: null, undoContextId: null, clientId: 'web-2' }],
    ])
  } finally {
    await app.close()
  }
})

test('项目事件是 best-effort：发布异常不改变已提交的成功响应', async () => {
  const harness = makeHarness()
  const runtime = {
    ...harness.runtime,
    async publishResourceChanged() { throw new Error('redis unavailable') },
  }
  const trash = createProjectTrashService(runtime as never, harness.fileStorage as never)
  await assert.doesNotReject(trash.deleteProject(ownerId, 17))
  assert.ok(harness.state.project.deleted_at)
})

test('项目 DELETE/restore HTTP 错误沿用 owner-scoped 404 和保留期 410', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const userFromRequest = (() => ({ id: ownerId, requestContext: { data: { ownerId } } })) as unknown as UserFromRequest
  registerProjectRoutes(app, userFromRequest, {
    deleteProject: async (_owner, projectId) => {
      if (projectId !== 17) throw new CoreError('not_found', '项目不存在')
    },
    restoreProject: async (_owner, projectId) => {
      if (projectId === 18) throw new ProjectTrashExpiredError()
      throw new CoreError('not_found', '项目不在回收站中')
    },
  })
  try {
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/projects/18' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/projects/17/restore' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/projects/18/restore' })).statusCode, 410)
  } finally {
    await app.close()
  }
})
