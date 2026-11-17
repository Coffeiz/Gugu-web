import assert from 'node:assert/strict'
import test from 'node:test'
import { createManualStorageQuotaReconcile, storageQuotaLockKey } from '../../src/modules/admin/storage-quota-reconcile.js'

function memoryRedis() {
  let lock: string | null = null
  let state: string | null = null
  return {
    commands: {
      async set(key: string, value: string) { if (key !== storageQuotaLockKey || lock !== null) return null; lock = value; return 'OK' },
      async eval(script: string, _keyCount: number, ...args: string[]) {
        if (script.includes("redis.call('EXPIRE'")) return lock === args[1] ? '1' : '0'
        if (script.includes("redis.call('DEL'")) { if (lock === args[1]) lock = null; return '1' }
        if (lock !== args[2]) return '0'
        state = args[3] ?? null
        return '1'
      },
    },
    read: async () => state,
    get state() { return state === null ? null : JSON.parse(state) as Record<string, unknown> },
  }
}

test('管理员任务用共享租约拒绝重复启动，汇报全量进度并释放锁', async () => {
  const redis = memoryRedis()
  let enterWork!: () => void
  let finishWork!: (value: { total: number; processed: number; completed: number; failed: number }) => void
  const entered = new Promise<void>(resolve => { enterWork = resolve })
  const result = new Promise<{ total: number; processed: number; completed: number; failed: number }>(resolve => { finishWork = resolve })
  const runtime = createManualStorageQuotaReconcile({
    commands: redis.commands,
    state: { read: redis.read },
    work: async (_signal, progress) => { enterWork(); await progress({ total: 2, processed: 1, completed: 1, failed: 0 }); return result },
    now: () => '2026-11-16T00:00:00.000Z',
    renewIntervalMs: 60_000,
  })

  assert.deepEqual(await runtime.start(), { started: true, state: { status: 'queued', total: 0, processed: 0, completed: 0, failed: 0, started_at: null } })
  await entered
  const repeated = await runtime.start()
  assert.equal(repeated.started, false)
  assert.equal(repeated.state.status, 'running')
  assert.equal(redis.state?.processed, 1)
  finishWork({ total: 2, processed: 2, completed: 2, failed: 0 })
  while (redis.state?.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 0))
  await runtime.close()
  assert.equal(redis.state?.status, 'completed')
})

test('Host 关闭时取消正在扫描的用户并写入 interrupted 终态', async () => {
  const redis = memoryRedis()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const runtime = createManualStorageQuotaReconcile({
    commands: redis.commands,
    state: { read: redis.read },
    work: async signal => {
      entered()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
      return { total: 1, processed: 0, completed: 0, failed: 0 }
    },
    renewIntervalMs: 60_000,
  })
  await runtime.start()
  await started
  await runtime.close()
  assert.equal(redis.state?.status, 'interrupted')
})
