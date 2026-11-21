import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveFileLibraryLimit, StorageQuotaScanBusy, reconcileAllStorageUsers, UNLIMITED_STORAGE_BYTES } from '../../../src/modules/admin/storage.js'

test('文件库额度遵循用户值优先、默认继承和 -1 不限额规则', () => {
  assert.equal(resolveFileLibraryLimit(12_000, 8_000), '12000')
  assert.equal(resolveFileLibraryLimit(null, 8_000), '8000')
  assert.equal(resolveFileLibraryLimit(-1, 8_000), UNLIMITED_STORAGE_BYTES)
  assert.equal(resolveFileLibraryLimit(null, null), UNLIMITED_STORAGE_BYTES)
  assert.throws(() => resolveFileLibraryLimit(-2, 8_000), RangeError)
})

test('全量配额对账包含所有用户且把并发扫描限制在配置上限', async () => {
  let active = 0
  let peak = 0
  const progress: Array<{ total: number; processed: number; completed: number; failed: number }> = []
  const result = await reconcileAllStorageUsers({
    async listUserIds() { return ['inactive-user', 'user-a', 'user-b', 'user-c'] },
    async reconcileUser(_userId, signal) {
      signal.throwIfAborted()
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 3))
      active -= 1
    },
  }, { concurrency: 2, retryDelayMs: 0, onProgress: async value => { progress.push(value) } })

  assert.deepEqual(result, { total: 4, processed: 4, completed: 4, failed: 0 })
  assert.equal(peak, 2)
  assert.deepEqual(progress.at(-1), result)
  assert.equal(progress[0]?.total, 4)
})

test('持续繁忙用户最多重试三次，单用户失败不会中断其余用户', async () => {
  const attempts = new Map<string, number>()
  const result = await reconcileAllStorageUsers({
    async listUserIds() { return ['busy-user', 'healthy-user'] },
    async reconcileUser(userId) {
      attempts.set(userId, (attempts.get(userId) ?? 0) + 1)
      if (userId === 'busy-user') throw new StorageQuotaScanBusy()
    },
  }, { concurrency: 1, retryDelayMs: 0 })

  assert.deepEqual(result, { total: 2, processed: 2, completed: 1, failed: 1 })
  assert.equal(attempts.get('busy-user'), 3)
  assert.equal(attempts.get('healthy-user'), 1)
})

test('失去租约时停止领取新用户并保留已完成进度', async () => {
  const controller = new AbortController()
  const visited: string[] = []
  const progress: Array<{ total: number; processed: number; completed: number; failed: number }> = []
  const result = await reconcileAllStorageUsers({
    async listUserIds() { return ['user-a', 'user-b', 'user-c'] },
    async reconcileUser(userId) { visited.push(userId) },
  }, { concurrency: 1, signal: controller.signal, retryDelayMs: 0, onProgress: async value => {
    progress.push(value)
    if (value.processed === 1) controller.abort()
  } })

  assert.deepEqual(visited, ['user-a'])
  assert.deepEqual(result, { total: 3, processed: 1, completed: 1, failed: 0 })
  assert.deepEqual(progress.at(-1), result)
})
