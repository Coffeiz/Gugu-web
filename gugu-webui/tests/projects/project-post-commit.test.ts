import assert from 'node:assert/strict'
import test from 'node:test'
import { createProjectPostCommitPublisher } from '../../src/domains/projects/persistence/project-post-commit-postgres.js'

test('项目变更提交后 bump 对应资源、入队实体 RAG，再只发布一次 live event', async () => {
  const calls: Array<{ type: string; value?: unknown }> = []
  const publish = createProjectPostCommitPublisher({
    async query(sql: string, values: unknown[]) {
      calls.push({ type: 'rag', value: { sql, values } })
      return { rows: [], rowCount: 1 }
    },
  } as never, {
    async bumpContextRevision(ownerId, resource) {
      calls.push({ type: 'context', value: { ownerId, resource } })
      return true
    },
    async publishResourceChanged(event) {
      calls.push({ type: 'live', value: event })
      return true
    },
  })

  await publish({
    userId: 'owner-1', resource: 'projects', operation: 'update',
    entityId: 42, origin: 'tab-1', payload: { id: 42 },
  })

  assert.deepEqual(calls.map(({ type }) => type), ['context', 'rag', 'live'])
  assert.deepEqual(calls[0]?.value, { ownerId: 'owner-1', resource: 'projects' })
  assert.deepEqual((calls[1]?.value as { values: unknown[] }).values, ['owner-1', 'project', '42', 'update'])
  assert.match((calls[1]?.value as { sql: string }).sql, /INSERT INTO rag_index_jobs/)
  assert.deepEqual(calls[2]?.value, {
    userId: 'owner-1', resource: 'projects', operation: 'update',
    entityId: 42, origin: 'tab-1', payload: { id: 42 },
  })
})

test('回收项目引起的日历和定时任务变更分别写入对应来源，空文件实体不生成 RAG 工作', async () => {
  const calls: Array<{ type: string; value?: unknown }> = []
  const publish = createProjectPostCommitPublisher({
    async query(_sql: string, values: unknown[]) {
      calls.push({ type: 'rag', value: values })
      return { rows: [], rowCount: 1 }
    },
  } as never, {
    async bumpContextRevision(_ownerId, resource) { calls.push({ type: 'context', value: resource }) },
    async publishResourceChanged(event) { calls.push({ type: 'live', value: event.resource }) },
  })

  await publish({
    userId: 'owner-1', resource: 'calendar', operation: 'delete',
    entityIds: [7, 8], origin: null,
  })
  await publish({
    userId: 'owner-1', resource: 'scheduled_tasks', operation: 'update',
    entityIds: [13], origin: null,
  })
  await publish({
    userId: 'owner-1', resource: 'files', operation: 'delete',
    entityIds: [], origin: null,
  })

  assert.deepEqual(calls.filter(({ type }) => type === 'context').map(({ value }) => value), [
    'calendar', 'scheduled_tasks', 'files',
  ])
  assert.deepEqual(calls.filter(({ type }) => type === 'rag').map(({ value }) => value), [
    ['owner-1', 'calendar', '7', 'delete'],
    ['owner-1', 'calendar', '8', 'delete'],
    ['owner-1', 'scheduled_task', '13', 'update'],
  ])
  assert.deepEqual(calls.filter(({ type }) => type === 'live').map(({ value }) => value), [
    'calendar', 'scheduled_tasks', 'files',
  ])
})

test('提交后 context/RAG 副作用失败不会阻断 live event 或让已提交操作失败', async () => {
  const calls: string[] = []
  const failures: string[] = []
  const publish = createProjectPostCommitPublisher({
    async query() { calls.push('rag'); throw Object.assign(new Error('sensitive database detail'), { code: 'XX001' }) },
  } as never, {
    async bumpContextRevision() { calls.push('context'); throw new Error('redis detail') },
    async publishResourceChanged() { calls.push('live') },
  }, (operation, code) => failures.push(`${operation}:${code ?? ''}`))

  await assert.doesNotReject(() => publish({
    userId: 'owner-1', resource: 'projects', operation: 'delete', entityId: 42, origin: null,
  }))
  assert.deepEqual(calls, ['context', 'rag', 'live'])
  assert.deepEqual(failures, ['project context revision:', 'project RAG index enqueue:XX001'])
})
