import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { buildDocuments } from '../../../../packages/core/src/agent/rag/adapters/base.js'
import { createSqlRagPersistentIndexReader } from '../../../../packages/core/src/agent/rag/persistent-index.js'
import { createSqlRagRebuildWorker } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { startRagIndexWorker } from '../../src/domains/agent-sessions/rag-index-worker.js'

const tick = async (count = 1) => {
  for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve))
}

test('RAG 调度器立即运行并串行排空 ready 任务，空队列后按间隔轮询', async () => {
  const results = ['ready', 'superseded', 'idle', 'idle'] as const
  const calls: number[] = []
  const worker = startRagIndexWorker({
    enabled: true,
    intervalMs: 10,
    onError: error => { throw error },
    work: async () => {
      calls.push(calls.length + 1)
      return results[calls.length - 1] ?? 'idle'
    },
  })
  try {
    await tick()
    assert.deepEqual(calls, [1, 2, 3])
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(calls.length >= 4, true)
    assert.deepEqual(calls, calls.map((_, index) => index + 1))
  } finally {
    await worker.stop()
  }
})

test('RAG 调度器处理失败后继续轮询且停止会取消并等待当前调用', async () => {
  const controllerSignals: AbortSignal[] = []
  const failures: unknown[] = []
  let calls = 0
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const worker = startRagIndexWorker({
    enabled: true,
    intervalMs: 10,
    onError: error => failures.push(error),
    work: async signal => {
      calls++
      controllerSignals.push(signal)
      if (calls === 1) throw new Error('synthetic worker failure')
      await current
      signal.throwIfAborted()
      return 'idle'
    },
  })
  await tick(2)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(calls, 2)
  assert.equal(failures.length, 1)
  const stopped = worker.stop()
  await tick()
  assert.equal(controllerSignals[1]?.aborted, true)
  release()
  await stopped
  assert.equal(calls, 2)
})

test('未启用的 RAG 调度器不触发 Worker', async () => {
  let calls = 0
  const worker = startRagIndexWorker({ enabled: false, work: async () => { calls++; return 'ready' }, onError: () => {} })
  await worker.stop()
  assert.equal(calls, 0)
})

test('ready 时排空任务不会并发调用底层 RAG Worker', async () => {
  let active = 0
  let maximum = 0
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const worker = startRagIndexWorker({
    enabled: true,
    intervalMs: 1000,
    onError: error => { throw error },
    work: async () => {
      active++
      maximum = Math.max(maximum, active)
      calls++
      if (calls === 1) await gate
      active--
      return calls <= 2 ? 'ready' : 'idle'
    },
  })
  await tick()
  assert.equal(calls, 1)
  release()
  await tick(2)
  assert.equal(calls, 3)
  assert.equal(maximum, 1)
  await worker.stop()
})

test('Host 调度器经持久 Worker 消费真实 SQLite 队列并写入正式索引表', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-scheduler-'))
  const path = join(directory, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId.replaceAll('-', '')
    const now = '2026-01-01 00:00:00.000000'
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'rag_index_jobs'): { values(row: Record<string, unknown>): { execute(): Promise<unknown> } }
    }
    await fixtureDb.insertInto('rag_index_jobs').values({
      user_id: owner, source_type: 'project', source_id: '17', pending_source_ids: '["17"]', version: '', operation: 'upsert',
      status: 'queued', generation: 1, completed_generation: 0, attempts: 0, next_attempt_at: now, created_at: now, updated_at: now,
    }).execute()
    const source = async (_sourceOwner: string, sourceId: string | null) => sourceId === '17' ? buildDocuments({
      source_type: 'project', id: '17', source_id: '17', title: '合成项目', content: '调度器测试正文',
      version_parts: ['project', '17'],
      scope: { scope_type: 'owner', scope_id: '' },
    }) : []
    const rebuild = createSqlRagRebuildWorker(runtime.db, 'sqlite', { project: source })
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite')
    const scheduler = startRagIndexWorker({ enabled: true, intervalMs: 1000, work: rebuild, onError: error => { throw error } })
    try {
      for (let attempt = 0; attempt < 50 && (await reader.snapshot(opened.ownerId)).documents.length === 0; attempt++)
        await new Promise(resolve => setTimeout(resolve, 2))
      const snapshot = await reader.snapshot(opened.ownerId)
      assert.equal(snapshot.documents.length, 1)
      assert.equal(snapshot.documents[0]?.content, '调度器测试正文')
    } finally {
      await scheduler.stop()
    }
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
