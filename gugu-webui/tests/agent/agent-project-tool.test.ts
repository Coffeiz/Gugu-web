import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentProjectTool } from '../../src/domains/agent-sessions/tools/agent-project-tool.js'
import type { ProjectCreateRecord } from '../../src/domains/projects/application/project-create.js'

const ownerA = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const ownerB = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

function fakeRuntime() {
  const rows = new Map<string, ProjectCreateRecord>()
  const undo: unknown[] = []
  const events: unknown[] = []
  let nextId = 1
  const runtime = {
    async transaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        async findIdempotent(owner: string, keyHash: string) {
          return rows.get(`${owner}:${keyHash}`) ?? null
        },
        async insertProject(owner: string, fields: Record<string, unknown>, idem: { keyHash: string; fingerprint: string } | null): Promise<ProjectCreateRecord> {
          const now = '2026-11-13T00:00:00.000Z'
          const row: ProjectCreateRecord = {
            id: nextId++, user_id: owner, name: String(fields.name),
            summary: fields.summary as string | null,
            client: fields.client as string | null, status: String(fields.status),
            start_date: fields.start_date as string | null, deadline: fields.deadline as string | null,
            color: String(fields.color), progress: Number(fields.progress),
            stages_json: fields.stages_json as string, current_stage: fields.current_stage as string | null,
            priority: fields.priority as string | null, version: 1, archived: false, done_at: null,
            created_at: now, updated_at: now, deleted_at: null,
            idempotency_fingerprint: idem?.fingerprint ?? null,
          }
          if (idem) rows.set(`${owner}:${idem.keyHash}`, row)
          return row
        },
        async recordUndo(entry: unknown) { undo.push(entry) },
      }
      return work(tx)
    },
    async publishProjectCreated(event: unknown) { events.push(event) },
  }
  return { runtime, rows, undo, events }
}

const dispatch = { sessionId: 42, toolCallId: 'provider-call-a' }
const args = {
  project_name: 'Agent 项目',
  summary: '先实现一版',
  priority: 'HIGH',
  client: '联系人甲',
  start_date: '2026-11-01',
  deadline: '2026-12-01',
  color: 'sage',
  stages: [{ label: '准备', todos: ['整理需求'] }, '交付'],
}

test('同一 Agent dispatch key 重放同一项目，不重复写入、Web Undo 或项目事件', async () => {
  const fake = fakeRuntime()
  const create = createAgentProjectTool(fake.runtime)
  const first = await create(ownerA, args, dispatch)
  const replay = await create(ownerA, { ...args }, dispatch)

  assert.equal(first.success, true)
  assert.equal(replay.project_id, first.project_id)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(fake.rows.size, 1)
  assert.equal(fake.undo.length, 0)
  assert.equal(fake.events.length, 0)
  const row = [...fake.rows.values()][0]!
  assert.equal(row.summary, '先实现一版')
  assert.equal(row.priority, 'high')
  assert.equal(row.current_stage, 's0')
})

test('不同 Agent 会话的相同 tool call id 不共享创建幂等键', async () => {
  const fake = fakeRuntime()
  const create = createAgentProjectTool(fake.runtime)
  const first = await create(ownerA, args, dispatch)
  const second = await create(ownerA, args, { ...dispatch, sessionId: 43 })

  assert.notEqual(first.project_id, second.project_id)
  assert.equal(fake.rows.size, 2)
  assert.equal(fake.events.length, 0)
})

test('相同 dispatch key 的不同参数报告冲突而不创建第二个项目', async () => {
  const fake = fakeRuntime()
  const create = createAgentProjectTool(fake.runtime)
  const first = await create(ownerA, args, dispatch)
  const conflict = await create(ownerA, { ...args, project_name: '另一个项目' }, dispatch)

  assert.equal(first.success, true)
  assert.equal(conflict.success, false)
  assert.equal(conflict.error_code, 'conflict')
  assert.equal(fake.rows.size, 1)
  assert.equal(fake.events.length, 0)
})

test('不同 owner 的相同 Agent dispatch key 各自创建并隔离项目', async () => {
  const fake = fakeRuntime()
  const create = createAgentProjectTool(fake.runtime)
  const first = await create(ownerA, args, dispatch)
  const second = await create(ownerB, args, dispatch)

  assert.notEqual(first.project_id, second.project_id)
  assert.equal([...fake.rows.values()].filter(row => row.user_id === ownerA).length, 1)
  assert.equal([...fake.rows.values()].filter(row => row.user_id === ownerB).length, 1)
})
