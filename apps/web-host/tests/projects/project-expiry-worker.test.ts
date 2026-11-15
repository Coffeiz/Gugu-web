import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { startProjectExpiryWorker } from '../../src/domains/projects/project-expiry-worker.js'

test('未显式启用时不连接数据库，避免与 Python 清理器并行消费', async () => {
  let calls = 0
  const pool = { connect: async () => { calls++; throw new Error('不应连接') } } as unknown as Pool
  const worker = startProjectExpiryWorker({ enabled: false, pool, storageRoot: '/unused', defaultLimitBytes: null, onError: () => {} })
  await worker.stop()
  assert.equal(calls, 0)
})

test('停止时等待正在执行的恢复完成并不启动下一轮', async () => {
  let resolveQuery!: (value: unknown) => void
  let calls = 0
  const client = { query: async (sql: string) => {
    calls++
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
    if (sql.includes('FROM project_expiry_journals')) return new Promise(resolve => { resolveQuery = resolve })
    return { rows: [] }
  }, release() {} }
  const pool = { connect: async () => client } as unknown as Pool
  const worker = startProjectExpiryWorker({ enabled: true, pool, storageRoot: '/unused', defaultLimitBytes: null, intervalMs: 10, onError: () => {} })
  while (!resolveQuery) await new Promise(resolve => setTimeout(resolve, 0))
  let stopped = false
  const stopping = worker.stop().then(() => { stopped = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(stopped, false)
  resolveQuery({ rows: [] })
  await stopping
  const atStop = calls
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls, atStop)
})

test('启动时恢复锁被占用后短间隔重试，锁释放后完成恢复', async () => {
  let attempts = 0
  let found = false
  const client = { query: async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: ++attempts > 1 }] }
    if (sql.includes('FROM project_expiry_journals')) { found = true; return { rows: [] } }
    return { rows: [] }
  }, release() {} }
  const pool = { connect: async () => client } as unknown as Pool
  const worker = startProjectExpiryWorker({ enabled: true, pool, storageRoot: '/unused', defaultLimitBytes: null, recoveryRetryMs: 10, onError: () => {} })
  try {
    for (let i = 0; i < 100 && !found; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(found, true)
    assert.ok(attempts >= 2)
  } finally { await worker.stop() }
})
