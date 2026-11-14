import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CoreError, dataContext } from '@gugu/core'
import type { ProjectRecord, Stage } from '@gugu/core'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentProjectUpdateTool } from '../../src/domains/agent-sessions/tools/agent-project-update-tool.js'

const ownerA = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const ownerB = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

type StoredProject = ProjectRecord

function fakeCore(seed: StoredProject[], updateFailure?: CoreError) {
  const rows = seed.map(row => ({ ...row }))
  const owners: string[] = []
  const updates: Array<{ ownerId: string; projectId: number; version: number; fields: Record<string, unknown> }> = []
  const runtime = {
    async transaction(context: { ownerId: string }, work: (data: unknown) => Promise<unknown>) {
      owners.push(context.ownerId)
      const owned = () => rows.filter(row => row.user_id === context.ownerId && row.deleted_at === null)
      const data = {
        projects: {
          async list(archived = false) { return owned().filter(row => row.archived === archived) },
          async get(id: number) { return owned().find(row => row.id === id) ?? null },
          async update(id: number, version: number, fields: Record<string, unknown>) {
            if (updateFailure) throw updateFailure
            const row = owned().find(item => item.id === id)
            if (!row) throw new Error('项目不存在')
            if (row.version !== version) throw new Error('项目已变化，请重新读取后再修改')
            updates.push({ ownerId: context.ownerId, projectId: id, version, fields: structuredClone(fields) })
            const { stages, ...plainFields } = fields
            Object.assign(row, plainFields)
            if (stages !== undefined) row.stages_json = JSON.stringify(stages)
            if (fields.status === 'done' && row.done_at === null) row.done_at = '2026-11-13T00:00:00.000Z'
            else if (fields.status !== undefined && fields.status !== 'done') row.done_at = null
            row.version += 1
            return row
          },
        },
      }
      return work(data)
    },
  }
  return { runtime: runtime as unknown as SqlDataRuntime, rows, owners, updates }
}

function project(
  id: number,
  user_id = ownerA,
  name = `项目${id}`,
  overrides: Partial<StoredProject> = {},
): StoredProject {
  return {
    id, user_id, name, summary: '旧摘要', client: '原联系人', status: 'active',
    start_date: '2026-11-01', deadline: '2026-12-01', color: 'sage', progress: 35,
    stages_json: JSON.stringify([
      { key: 's0', label: '计划', todos: [{ id: 't1', text: '已完成', done: true }] },
      { key: 's1', label: '交付', todos: [{ id: 't2', text: '待完成', done: false }] },
    ]),
    current_stage: 's0', priority: null, version: 2, archived: false, done_at: null,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', deleted_at: null,
    ...overrides,
  }
}

test('按 ID 更新只传入显式字段，并归一化优先级', async () => {
  const fake = fakeCore([project(1)])
  const update = createAgentProjectUpdateTool(fake.runtime)

  const result = await update(ownerA, {
    project_id: 1,
    project_name: '新名称',
    summary: '新摘要',
    priority: ' HIGH ',
    client: '新联系人',
  })

  assert.deepEqual(result, { success: true, project_id: 1, name: '新名称', priority: 'high' })
  assert.deepEqual(fake.owners, [ownerA])
  assert.deepEqual(fake.updates, [{
    ownerId: ownerA, projectId: 1, version: 2,
    fields: { name: '新名称', summary: '新摘要', priority: 'high', client: '新联系人' },
  }])
})

test('首次标记完成时自动勾选未完成待办并保存恢复标记', async () => {
  const fake = fakeCore([project(1)])
  const update = createAgentProjectUpdateTool(fake.runtime)

  const result = await update(ownerA, { project_id: 1, status: 'done' })
  const fields = fake.updates[0]!.fields
  const stages = fields.stages as Array<{ key: string; todos: Array<Record<string, unknown>> }>

  if (typeof result === 'string') assert.fail(result)
  assert.equal(result.success, true)
  assert.equal(fields.status, 'done')
  assert.equal(fields.progress, 100)
  assert.equal(fields.current_stage, 's1')
  assert.deepEqual(stages[0]!.todos, [{ id: 't1', text: '已完成', done: true }])
  assert.deepEqual(stages[1]!.todos, [{
    id: 't2', text: '待完成', done: true, _savedDone: false, autoCompleted: true,
  }])
})

test('从完成状态恢复时只更新状态字段并保留 Python 持久化的恢复标记', async () => {
  const completed = project(1, ownerA, '项目1', {
    status: 'done', progress: 100, done_at: '2026-11-12T00:00:00.000Z',
    stages_json: JSON.stringify([
      { key: 's0', label: '计划', todos: [{ id: 't1', text: '待完成', done: true, _savedDone: false, autoCompleted: true }] },
    ]),
  })
  const fake = fakeCore([completed])
  const update = createAgentProjectUpdateTool(fake.runtime)

  const result = await update(ownerA, { project_id: 1, status: 'active' })

  if (typeof result === 'string') assert.fail(result)
  assert.equal(result.success, true)
  assert.deepEqual(fake.updates[0]!.fields, { status: 'active' })
  assert.equal(JSON.parse(fake.rows[0]!.stages_json)[0].todos[0].autoCompleted, true)
})

test('项目名精确匹配优先于模糊项，跨 owner ID 返回不存在', async () => {
  const fake = fakeCore([project(1, ownerA, '小北'), project(2, ownerA, '小北工作室'), project(3, ownerB, '他人的项目')])
  const update = createAgentProjectUpdateTool(fake.runtime)

  const exact = await update(ownerA, { project: '小北', summary: '命中精确项' })
  const foreign = await update(ownerA, { project_id: 3, summary: '不得越权' })

  assert.deepEqual(exact, { success: true, project_id: 1, name: '小北', priority: null })
  assert.deepEqual(JSON.parse(foreign as string), { error: '项目不存在' })
  assert.equal(fake.updates.length, 1)
})

test('姓名模糊匹配有歧义时返回候选，不更新；空更新被拒绝', async () => {
  const fake = fakeCore([project(1, ownerA, '北方工作室'), project(2, ownerA, '南北计划')])
  const update = createAgentProjectUpdateTool(fake.runtime)

  const ambiguous = await update(ownerA, { project: '北', status: 'done' })
  const empty = await update(ownerA, { project_id: 1 })

  assert.deepEqual(JSON.parse(ambiguous as string), {
    error: '有多个匹配「北」的项目，请指明是哪个',
    candidates: [
      { id: 1, name: '北方工作室', status: 'active' },
      { id: 2, name: '南北计划', status: 'active' },
    ],
  })
  assert.match(JSON.parse(empty as string).error, /未提供可更新的项目内容/)
  assert.equal(fake.updates.length, 0)
})

test('Core 的版本 CAS 冲突按 Python Agent 工具语义返回且不提交写入', async () => {
  const fake = fakeCore([project(1)], new CoreError('conflict', '项目已变化，请重新读取后再修改'))
  const update = createAgentProjectUpdateTool(fake.runtime)

  const result = await update(ownerA, { project_id: 1, project_name: '并发更新' })

  assert.deepEqual(JSON.parse(result as string), { error: '项目刚被其他端修改，请重试' })
  assert.equal(fake.updates.length, 0)
})

test('真实 SQLite Core 事务持久化完成待办标记并按版本更新 done_at', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-project-update-'))
  const path = join(directory, 'project.db')
  await initializeSqlite(path)
  const { runtime } = await openSqliteRuntime(path)
  const ownerId = randomUUID()
  try {
    const created = await runtime.transaction(dataContext(ownerId), data => data.projects.create({
      name: '真实 Core 项目',
      status: 'active',
      stages: [
        { key: 's0', label: '计划', todos: [{ id: 't1', text: '完成内容', done: false }] },
        { key: 's1', label: '交付', todos: [] },
      ],
      current_stage: 's0',
    }))
    const update = createAgentProjectUpdateTool(runtime)

    const completed = await update(ownerId, { project_id: created.id, status: 'done' })
    const doneRecord = await runtime.transaction(dataContext(ownerId), data => data.projects.get(created.id))
    const doneStages = JSON.parse(doneRecord!.stages_json) as Stage[]
    assert.notEqual(typeof completed, 'string')
    assert.equal(doneRecord!.version, 2)
    assert.notEqual(doneRecord!.done_at, null)
    assert.deepEqual(doneStages[0]!.todos![0], {
      id: 't1', text: '完成内容', done: true, _savedDone: false, autoCompleted: true,
    })

    const reopened = await update(ownerId, { project_id: created.id, status: 'active' })
    const activeRecord = await runtime.transaction(dataContext(ownerId), data => data.projects.get(created.id))
    assert.notEqual(typeof reopened, 'string')
    assert.equal(activeRecord!.version, 3)
    assert.equal(activeRecord!.done_at, null)
    assert.equal(JSON.parse(activeRecord!.stages_json)[0].todos[0].autoCompleted, true)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
