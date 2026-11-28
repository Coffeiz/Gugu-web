import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { createAgentSessionDeleter } from '../../../src/agent/sessions/delete.js'

test('会话删除只有提交成功后清理未引用附件，并继续处理其他附件', async () => {
  const owner = randomUUID()
  const calls: string[] = []
  const remove = createAgentSessionDeleter({
    async delete(ownerId, sessionId) {
      calls.push(`db:${ownerId}:${sessionId}`)
      return ownerId === owner && sessionId === 7 ? { storageKeys: ['shared-key', 'orphan-key', 'orphan-key'] } : null
    },
  }, {
    async removeIfUnreferenced(ownerId, storageKey) {
      calls.push(`storage:${ownerId}:${storageKey}`)
      if (storageKey === 'shared-key') return false
      throw new Error('storage unavailable')
    },
    async clearReflection(ownerId, sessionId) { calls.push(`reflection:${ownerId}:${sessionId}`) },
  })

  assert.equal(await remove(owner, 7), true)
  assert.deepEqual(calls, [
    `db:${owner}:7`,
    `storage:${owner}:shared-key`,
    `storage:${owner}:orphan-key`,
    `reflection:${owner}:7`,
  ])
  assert.equal(await remove(randomUUID(), 7), false)
})

test('数据库删除失败时不触碰附件或会话反思缓存', async () => {
  const owner = randomUUID()
  const calls: string[] = []
  const remove = createAgentSessionDeleter({
    async delete() { throw new Error('transaction failed') },
  }, {
    async removeIfUnreferenced() { calls.push('storage'); return true },
    async clearReflection() { calls.push('reflection') },
  })
  await assert.rejects(remove(owner, 7), /transaction failed/)
  assert.deepEqual(calls, [])
})

test('无效会话 ID 在访问仓储前拒绝', async () => {
  const owner = randomUUID()
  let accessed = false
  const remove = createAgentSessionDeleter({
    async delete() { accessed = true; return null },
  }, {
    async removeIfUnreferenced() { return true },
    async clearReflection() {},
  })
  await assert.rejects(remove(owner, 0), /会话 ID 无效/)
  assert.equal(accessed, false)
})
