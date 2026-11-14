import assert from 'node:assert/strict'
import test from 'node:test'
import { createProjectCreator } from '../../src/domains/projects/application/project-create.js'
import type { ProjectCreateRecord } from '../../src/domains/projects/application/project-create.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const projectInput = {
  name: '迁移验证项目',
  client: null,
  status: 'pending',
  start_date: null,
  deadline: null,
  color: 'linear-gradient(135deg,#c4afc8,#b07090)',
  stages: [],
  current_stage: null,
  progress: 0,
}

class UniqueViolation extends Error {
  code = '23505'
}

function fakeRuntime() {
  const rows = new Map<string, any>()
  const undo: unknown[] = []
  const events: unknown[] = []
  let nextId = 1
  let committed = false
  const runtime = {
    async transaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        async findIdempotent(owner: string, key: string) {
          return rows.get(`${owner}:${key}`) ?? null
        },
        async insertProject(owner: string, fields: Record<string, unknown>, idem: { keyHash: string; fingerprint: string } | null): Promise<ProjectCreateRecord> {
          const now = '2026-11-13T00:00:00.000Z'
          const row: ProjectCreateRecord = {
            id: nextId++, user_id: owner, name: String(fields.name), summary: null,
            client: fields.client as string | null, status: String(fields.status),
            start_date: fields.start_date as string | null, deadline: fields.deadline as string | null,
            color: String(fields.color), progress: Number(fields.progress),
            stages_json: fields.stages_json as string, current_stage: fields.current_stage as string | null,
            priority: null, version: 1, archived: false, done_at: null,
            created_at: now, updated_at: now, deleted_at: null,
            idempotency_fingerprint: idem?.fingerprint ?? null,
          }
          if (idem) {
            const index = `${owner}:${idem.keyHash}`
            if (rows.has(index)) throw new UniqueViolation()
            rows.set(index, row)
          }
          return row
        },
        async recordUndo(entry: unknown) { undo.push(entry) },
      }
      const result = await work(tx)
      committed = true
      return result
    },
    async publishProjectCreated(event: unknown) {
      assert.equal(committed, true, '项目事件必须在提交后发布')
      events.push(event)
    },
  }
  return { runtime, rows, undo, events }
}

test('创建项目校验字段、绑定当前 owner，并在事务内记录 Undo、提交后发布事件', async () => {
  const fake = fakeRuntime()
  const create = createProjectCreator(fake.runtime)
  const result = await create(ownerId, projectInput, {
    idempotencyKey: 'create-1', undoContextId: 'tab-1', clientId: 'web-1',
  })

  assert.equal(result.project.user_id, ownerId)
  assert.equal(result.project.name, projectInput.name)
  assert.equal(fake.rows.size, 1)
  assert.equal(fake.undo.length, 1)
  assert.deepEqual(fake.undo[0], {
    userId: ownerId,
    contextId: 'tab-1',
    resource: 'projects',
    action: 'create',
    targetRefs: [{ kind: 'project', id: result.project.id }],
    beforeState: { items: {} },
    afterState: { items: { [`project:${result.project.id}`]: {
      id: result.project.id,
      name: projectInput.name,
      client: null,
      status: 'pending',
      start_date: null,
      deadline: null,
      color: 'linear-gradient(135deg,#c4afc8,#b07090)',
      progress: 0,
      stages: [],
      current_stage: null,
      priority: null,
      archived: false,
      done_at: null,
      version: 1,
      deleted_at: null,
    } } },
    baseVersions: { [`project:${result.project.id}`]: { version: 0 } },
  })
  assert.equal(fake.events.length, 1)
  assert.deepEqual(fake.events[0], {
    userId: ownerId,
    resource: 'projects',
    origin: 'web-1',
    operation: 'create',
    entityId: result.project.id,
    payload: {
      id: result.project.id,
      name: projectInput.name,
      client: null,
      status: 'pending',
      startDate: null,
      deadline: null,
      color: 'linear-gradient(135deg,#c4afc8,#b07090)',
      progress: 0,
      stages: [],
      currentStage: null,
      archived: false,
      priority: null,
      version: 1,
      doneAt: null,
      updatedAt: '2026-11-13T00:00:00.000Z',
      deletedAt: null,
      createdAt: '2026-11-13',
      fileCount: 0,
    },
  })
})

test('相同 Idempotency-Key 和内容重放同一项目且不重复 Undo 或事件', async () => {
  const fake = fakeRuntime()
  const create = createProjectCreator(fake.runtime)
  const options = { idempotencyKey: 'same-key', undoContextId: 'tab-1' }
  const first = await create(ownerId, projectInput, options)
  const replay = await create(ownerId, { ...projectInput }, options)

  assert.equal(replay.project.id, first.project.id)
  assert.equal(replay.created, false)
  assert.equal(fake.rows.size, 1)
  assert.equal(fake.undo.length, 1)
  assert.equal(fake.events.length, 1)
})

test('创建缺省字段与 Python schema 默认值一致', async () => {
  const fake = fakeRuntime()
  const create = createProjectCreator(fake.runtime)
  const result = await create(ownerId, { name: '默认项目' })
  assert.equal(result.project.status, 'pending')
  assert.equal(result.project.progress, 0)
  assert.equal(result.project.color, 'linear-gradient(135deg,#7b7fb2,#c4afc8)')
  assert.equal(result.project.stages_json, '[]')
})

test('相同 Idempotency-Key 的不同内容冲突；非法项目和非法 key 被拒绝', async () => {
  const fake = fakeRuntime()
  const create = createProjectCreator(fake.runtime)
  await create(ownerId, projectInput, { idempotencyKey: 'same-key' })
  await assert.rejects(
    create(ownerId, { ...projectInput, name: '另一个项目' }, { idempotencyKey: 'same-key' }),
    { code: 'conflict' },
  )
  await assert.rejects(create(ownerId, { ...projectInput, name: '   ' }), { code: 'invalid_request' })
  await assert.rejects(create(ownerId, projectInput, { idempotencyKey: '   ' }), { code: 'invalid_request' })
  assert.equal(fake.rows.size, 1)
})

test('两个并发相同请求由唯一约束收敛到一个项目', async () => {
  const fake = fakeRuntime()
  const create = createProjectCreator(fake.runtime)
  const results = await Promise.all([
    create(ownerId, projectInput, { idempotencyKey: 'race-key', undoContextId: 'tab-1' }),
    create(ownerId, projectInput, { idempotencyKey: 'race-key', undoContextId: 'tab-1' }),
  ])
  assert.equal(results[0]!.project.id, results[1]!.project.id)
  assert.equal(results.filter((result) => result.created).length, 1)
  assert.equal(fake.rows.size, 1)
  assert.equal(fake.undo.length, 1)
  assert.equal(fake.events.length, 1)
})

test('Undo 写入失败时不发布项目事件', async () => {
  const fake = fakeRuntime()
  const runtime = {
    ...fake.runtime,
    async transaction<T>(work: (tx: any) => Promise<T>) {
      return fake.runtime.transaction(async (tx: any) => ({
        ...await work({ ...tx, async recordUndo() { throw new Error('undo failed') } }),
      }))
    },
  }
  const create = createProjectCreator(runtime)
  await assert.rejects(create(ownerId, projectInput, { undoContextId: 'tab-1' }), /undo failed/)
  assert.equal(fake.events.length, 0)
})

test('提交后项目事件发布失败不改变创建成功结果或已提交的项目和 Undo', async () => {
  const fake = fakeRuntime()
  const runtime = {
    ...fake.runtime,
    async publishProjectCreated() { throw new Error('event backend unavailable') },
  }
  const create = createProjectCreator(runtime)
  const result = await create(ownerId, projectInput, { idempotencyKey: 'event-fail-key', undoContextId: 'tab-1' })

  assert.equal(result.created, true)
  assert.equal(result.project.user_id, ownerId)
  assert.equal(fake.rows.size, 1)
  assert.equal(fake.undo.length, 1)
})
