import assert from 'node:assert/strict'
import test from 'node:test'
import { createAccountMemoryCleanupRuntime } from '../../src/modules/admin/memory-cleanup.js'

test('账号记忆维护通过注入的 Redis 端口完成空预览、确认应用并释放租约', async () => {
  const entries = new Map<string, string>()
  const stateKey = 'mem_cleanup:node:plan'
  const leaseKey = 'mem_cleanup:node:lock'
  const values = { async get(key: string) { return entries.get(key) ?? null } }
  const redis = {
    async exists(key: string) { return entries.has(key) ? '1' : '0' },
    async set(key: string, value: string) {
      if (entries.has(key)) return null
      entries.set(key, value)
      return 'OK'
    },
    async eval(script: string, _keyCount: number, ...args: string[]) {
      const [lock, state, token, value, _ttl, finish] = args
      if (script.includes("redis.call('EXPIRE'")) return entries.get(lock!) === state ? '1' : '0'
      if (script.includes("redis.call('SET'")) {
        if (entries.get(lock!) !== token) return '0'
        entries.set(state!, value!)
        if (finish === '1') entries.delete(lock!)
        return '1'
      }
      if (entries.get(lock!) === state) entries.delete(lock!)
      return '1'
    },
  }
  const runtime = createAccountMemoryCleanupRuntime({
    values, redis,
    listOwners: async () => [],
    available: () => true,
    storage: {
      async read() { throw new Error('空预览不得读取用户') },
      async apply() { throw new Error('空计划不得修改用户') },
    },
    model: () => ({ provider: 'synthetic' }) as never,
    async complete() { throw new Error('空预览不得调用模型') },
    now: () => 1_800_000_000,
  })
  try {
    assert.deepEqual(await runtime.preview(), { ok: true, message: '预览已启动，共 0 个用户', total: 0 })
    await runtime.close()
    assert.equal(entries.has(leaseKey), false)
    assert.equal(JSON.parse(entries.get(stateKey)!).plan_ready, true)
    const result = await runtime.apply()
    assert.equal(result.users_applied, 0)
    assert.equal(JSON.parse(entries.get(stateKey)!).status, 'idle')
    assert.equal(entries.has(leaseKey), false)
  } finally { await runtime.close() }
})
