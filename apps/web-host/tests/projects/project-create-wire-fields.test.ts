import assert from 'node:assert/strict'
import test from 'node:test'
import { createProjectCreator } from '../../src/domains/projects/application/project-create.js'
import type { ProjectCreateRecord, ProjectCreateRuntime, ProjectCreateTransaction } from '../../src/domains/projects/application/project-create.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const stages = [
  { key: 's0', label: '准备', todos: [] },
  { key: 's1', label: '交付', todos: [] },
]

function captureCreate() {
  let inserted: ProjectCreateRecord | null = null
  const runtime: ProjectCreateRuntime = {
    async transaction<T>(work: (tx: ProjectCreateTransaction) => Promise<T>): Promise<T> {
      return work({
        async findIdempotent() { return null },
        async insertProject(userId, fields, idempotency) {
          inserted = {
            id: 17,
            user_id: userId,
            name: String(fields.name),
            summary: null,
            client: fields.client as string | null,
            status: String(fields.status),
            start_date: fields.start_date as string | null,
            deadline: fields.deadline as string | null,
            color: String(fields.color),
            progress: Number(fields.progress),
            stages_json: String(fields.stages_json),
            current_stage: fields.current_stage as string | null,
            priority: null,
            version: 1,
            archived: false,
            done_at: null,
            created_at: '2026-11-13T00:00:00.000Z',
            updated_at: '2026-11-13T00:00:00.000Z',
            deleted_at: null,
            idempotency_fingerprint: idempotency?.fingerprint ?? null,
          }
          return inserted
        },
        async recordUndo() {},
      })
    },
    async publishProjectCreated() {},
  }
  return {
    async create(input: Record<string, unknown>) {
      const result = await createProjectCreator(runtime)(ownerId, input)
      return { result, inserted }
    },
  }
}

test('项目创建读取 API camelCase 的 startDate/currentStage', async () => {
  const capture = captureCreate()
  const { result, inserted } = await capture.create({
    name: 'camelCase 项目',
    stages,
    startDate: '2026-11-01',
    currentStage: 's1',
  })

  assert.equal(inserted?.start_date, '2026-11-01')
  assert.equal(inserted?.current_stage, 's1')
  assert.equal(result.project.start_date, '2026-11-01')
  assert.equal(result.project.current_stage, 's1')
})

test('项目创建继续兼容内部 snake_case start_date/current_stage', async () => {
  const capture = captureCreate()
  const { inserted } = await capture.create({
    name: 'snake_case 项目',
    stages,
    start_date: '2026-11-02',
    current_stage: 's0',
  })

  assert.equal(inserted?.start_date, '2026-11-02')
  assert.equal(inserted?.current_stage, 's0')
})

test('camelCase 字段与 snake_case 同时出现时以 API camelCase 为准', async () => {
  const capture = captureCreate()
  const { inserted } = await capture.create({
    name: '混合字段项目',
    stages,
    startDate: '2026-11-03',
    start_date: '2026-11-04',
    currentStage: 's1',
    current_stage: 's0',
  })

  assert.equal(inserted?.start_date, '2026-11-03')
  assert.equal(inserted?.current_stage, 's1')
})
