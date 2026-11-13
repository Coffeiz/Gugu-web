import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreError, type ProjectRecord } from '@gugu/core'
import { createProjectUpdater } from '../../src/domains/projects/application/project-update.js'
import type {
  ProjectUpdateRuntime,
  ProjectUpdateTransaction,
} from '../../src/domains/projects/application/project-update.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const stages = [
  { key: 's0', label: '准备', todos: [] },
  { key: 's1', label: '交付', todos: [] },
]

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 17,
    user_id: ownerId,
    name: '原项目',
    summary: null,
    client: null,
    status: 'pending',
    start_date: '2026-11-01',
    deadline: '2026-12-01',
    color: 'linear-gradient(135deg,#7b7fb2,#c4afc8)',
    progress: 0,
    stages_json: JSON.stringify(stages),
    current_stage: 's0',
    priority: null,
    version: 4,
    archived: false,
    done_at: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

function fakeRuntime(initial = project()) {
  let row = initial
  let committed = false
  const undo: unknown[] = []
  const events: unknown[] = []
  const runtime: ProjectUpdateRuntime = {
    async transaction<T>(work: (tx: ProjectUpdateTransaction) => Promise<T>) {
      committed = false
      let working = row
      const result = await work({
        async getOwned(owner, id) {
          return owner === working.user_id && id === working.id && working.deleted_at === null ? working : null
        },
        async updateIfVersion(owner, id, version, fields) {
          if (owner !== working.user_id || id !== working.id || working.deleted_at !== null || working.version !== version)
            return null
          const updated = { ...working, ...fields, version: working.version + 1, updated_at: '2026-11-13T00:00:00.000Z' }
          if ('status' in fields) {
            updated.done_at = fields.status === 'done' ? working.done_at ?? '2026-11-13T00:00:00.000Z' : null
          }
          working = updated
          return working
        },
        async updateFileStoragePrefixes() {},
        async recordUndo(record) { undo.push(record) },
      })
      row = working
      committed = true
      return result
    },
    async publishProjectUpdated(event) {
      assert.equal(committed, true, '项目事件必须在提交后发布')
      events.push(event)
    },
    async renameProjectDirectory() {},
    async getFileCount() { return 3 },
  }
  return { runtime, get row() { return row }, undo, events }
}

test('PATCH 项目转换 camelCase 字段，按 owner/version CAS 更新，并同事务写 Undo、提交后发事件', async () => {
  const fake = fakeRuntime()
  const update = createProjectUpdater(fake.runtime)
  const result = await update(ownerId, 17, {
    version: 4,
    name: '新项目',
    startDate: '2026-11-02',
    currentStage: 's1',
    status: 'done',
    progress: 60,
  }, { undoContextId: 'tab-1', clientId: 'web-1' })

  assert.equal(fake.row.name, '新项目')
  assert.equal(fake.row.start_date, '2026-11-02')
  assert.equal(fake.row.current_stage, 's1')
  assert.equal(fake.row.version, 5)
  assert.ok(fake.row.done_at)
  assert.equal(fake.undo.length, 1)
  const undo = fake.undo[0] as { resource: string; action: string; beforeState: any; afterState: any; baseVersions: any }
  assert.equal(undo.resource, 'projects')
  assert.equal(undo.action, 'update')
  assert.equal(undo.beforeState.items['project:17'].version, 4)
  assert.equal(undo.afterState.items['project:17'].version, 5)
  assert.deepEqual(undo.baseVersions, { 'project:17': { version: 4 } })
  assert.equal(fake.events.length, 1)
  assert.deepEqual(fake.events[0], {
    userId: ownerId,
    resource: 'projects',
    origin: 'web-1',
    operation: 'update',
    entityId: 17,
    payload: result,
  })
  assert.deepEqual(result, {
    id: 17,
    name: '新项目',
    client: null,
    status: 'done',
    startDate: '2026-11-02',
    deadline: '2026-12-01',
    color: 'linear-gradient(135deg,#7b7fb2,#c4afc8)',
    progress: 60,
    stages,
    currentStage: 's1',
    archived: false,
    priority: null,
    version: 5,
    doneAt: fake.row.done_at,
    updatedAt: '2026-11-13T00:00:00.000Z',
    deletedAt: null,
    createdAt: '2026-11-01',
    fileCount: 3,
  })
})

test('PATCH 要求 version；无字段更新只回当前响应且不增加 Undo/event（含陈旧 version）', async () => {
  const fake = fakeRuntime()
  const update = createProjectUpdater(fake.runtime)
  await assert.rejects(update(ownerId, 17, { name: '缺版本' }), { code: 'invalid_request' })
  const response = await update(ownerId, 17, { version: 3 })
  assert.equal(response.name, '原项目')
  assert.equal(fake.undo.length, 0)
  assert.equal(fake.events.length, 0)
})

test('PATCH 按 owner 隔离并用 CAS 将陈旧 version 映射为冲突', async () => {
  const fake = fakeRuntime()
  const update = createProjectUpdater(fake.runtime)
  await assert.rejects(update('ad0902a0-c899-44ee-b180-d54eb04e4604', 17, { version: 4, name: '越权' }), { code: 'not_found' })
  await assert.rejects(update(ownerId, 17, { version: 3, name: '过期修改' }), { code: 'conflict' })
  assert.equal(fake.row.name, '原项目')
  assert.equal(fake.undo.length, 0)
  assert.equal(fake.events.length, 0)
})

test('PATCH 校验字段、日期和 version 范围；不会部分写入', async () => {
  const fake = fakeRuntime()
  const update = createProjectUpdater(fake.runtime)
  for (const body of [
    { version: 4, name: '   ' },
    { version: 4, startDate: '2026-02-30' },
    { version: 4, startDate: '2026-12-02' },
    { version: 0, progress: 5 },
  ]) {
    await assert.rejects(update(ownerId, 17, body), (error) => error instanceof CoreError && error.code === 'invalid_request')
  }
  assert.equal(fake.row.name, '原项目')
  assert.equal(fake.row.version, 4)
  assert.equal(fake.undo.length, 0)
  assert.equal(fake.events.length, 0)
  // Python Pydantic 默认忽略额外字段，且 PATCH 的无字段分支不做 version CAS。
  const noKnownFields = await update(ownerId, 17, { version: 3, unknownField: true })
  assert.equal(noKnownFields.name, '原项目')
})

test('Undo 写入失败回滚更新且不发布事件', async () => {
  const fake = fakeRuntime()
  const runtime: ProjectUpdateRuntime = {
    ...fake.runtime,
    async transaction<T>(work: (tx: ProjectUpdateTransaction) => Promise<T>): Promise<T> {
      return fake.runtime.transaction((tx) => work({ ...tx, async recordUndo() { throw new Error('undo failed') } }))
    },
  }
  const update = createProjectUpdater(runtime)
  await assert.rejects(update(ownerId, 17, { version: 4, name: '待回滚' }, { undoContextId: 'tab-1' }), /undo failed/)
  assert.equal(fake.row.name, '原项目')
  assert.equal(fake.row.version, 4)
  assert.equal(fake.events.length, 0)
})
