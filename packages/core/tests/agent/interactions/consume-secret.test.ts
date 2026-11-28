import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createSecretInteractionConsumer } from '../../../src/agent/interactions/consume-secret.js'

const ownerId = '00000000-0000-4000-8000-000000000001'
const serverId = '00000000-0000-4000-8000-000000000002'

function storeFixture() {
  const state = {
    prompt: {
      id: 17, ownerId, sessionId: 9, kind: 'form', status: 'active',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      schema: { secret_fields: [{ name: 'key', label: 'Key', type: 'secret' }], context: { tool_call_id: 'call-1', secret_target: { kind: 'mcp_credentials', server_id: serverId } } },
    },
    slots: [{ id: 'key', target: 'header', prefix: 'Bearer ' }],
    writes: [] as Array<unknown>,
    committed: false,
  }
  const store = {
    async transaction<T>(run: (tx: any) => Promise<T>) {
      const staged: unknown[] = []
      const tx = {
        async getOwnedPrompt(owner: string, id: number) { return owner === ownerId && id === 17 ? structuredClone(state.prompt) : null },
        async getOwnedMcpServer(owner: string, id: string) { return owner === ownerId && id === serverId ? { id, scope: 'user', credentialSlots: state.slots } : null },
        async updateCredentials(...args: unknown[]) { staged.push(['credentials', ...args]) },
        async invalidateToolSnapshot(...args: unknown[]) { staged.push(['invalidate', ...args]) },
        async resolvePrompt(...args: unknown[]) { staged.push(['prompt', ...args]) },
        async clearSecretStaging(...args: unknown[]) { staged.push(['staging', ...args]) },
        async enqueueResume(...args: unknown[]) { staged.push(['resume', ...args]) },
      }
      const result = await run(tx)
      state.writes.push(...staged)
      state.committed = true
      return result
    },
  }
  return { state, store }
}

test('提交凭据时 owner、字段、server 槽位、密文、缓存失效和恢复记录原子绑定', async () => {
  const { state, store } = storeFixture()
  const captured: { sealed: Record<string, string> | null } = { sealed: null }
  const consume = createSecretInteractionConsumer({ store, now: () => new Date('2026-11-18T00:00:00Z'), async encrypt(values) { captured.sealed = values; return { ciphertext: 'sealed', nonce: 'nonce', encryptedDataKey: 'data-key', keyVersion: 1 } } })

  const result = await consume({ ownerId, promptId: 17, values: { key: ' synthetic-secret ' } })

  assert.deepEqual(result, { ok: true, prompt_id: 17 })
  assert.deepEqual(captured.sealed && { ...captured.sealed }, { key: 'synthetic-secret' })
  assert.equal(state.committed, true)
  assert.deepEqual(state.writes.map(write => (write as unknown[])[0]), ['credentials', 'invalidate', 'prompt', 'staging', 'resume'])
  assert.doesNotMatch(JSON.stringify(state.writes), /synthetic-secret/)
})

test('拒绝跨 owner、过期 prompt、字段不匹配和不安全 Header，失败不提交副作用', async () => {
  const cases: Array<{ ownerId: string; values: Record<string, string> | null; expected: string }> = [
    { ownerId: '00000000-0000-4000-8000-000000000099', values: { key: 'secret' }, expected: 'not_found' },
    { ownerId, values: { key: 'secret', other: 'extra' }, expected: 'invalid_request' },
    { ownerId, values: { key: '非 ASCII' }, expected: 'invalid_request' },
  ]
  for (const input of cases) {
    const { state, store } = storeFixture()
    const consume = createSecretInteractionConsumer({ store, now: () => new Date('2026-11-18T00:00:00Z'), async encrypt() { return { ciphertext: 'sealed', nonce: 'nonce', encryptedDataKey: 'data-key', keyVersion: 1 } } })
    await assert.rejects(consume({ promptId: 17, ...input }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === input.expected)
    assert.equal(state.committed, false)
    assert.deepEqual(state.writes, [])
  }
})

test('拒绝无效或超出协议上限的 secret 字段定义，失败不提交副作用', async () => {
  for (const fields of [
    [{ name: 'bad field', label: 'Bad', type: 'secret' }],
    Array.from({ length: 17 }, (_, index) => ({ name: `key-${index}`, label: `Key ${index}`, type: 'secret' })),
  ]) {
    const { state, store } = storeFixture()
    state.prompt.schema.secret_fields = fields
    const consume = createSecretInteractionConsumer({ store, now: () => new Date('2026-11-18T00:00:00Z'), async encrypt() { throw new Error('无效字段不能加密') } })
    await assert.rejects(consume({ ownerId, promptId: 17, values: { key: 'secret' } }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'conflict')
    assert.equal(state.committed, false)
    assert.deepEqual(state.writes, [])
  }
})

test('Web 取消凭据交互结束 prompt、清理暂存并恢复原 Run，不触碰 MCP 凭据', async () => {
  const { state, store } = storeFixture()
  const consume = createSecretInteractionConsumer({ store, now: () => new Date('2026-11-18T00:00:00Z'), async encrypt() { throw new Error('取消不得加密') } })

  const result = await consume({ ownerId, promptId: 17, values: null })

  assert.deepEqual(result, { ok: true, prompt_id: 17, status: 'cancelled' })
  assert.equal(state.committed, true)
  assert.deepEqual(state.writes.map(write => (write as unknown[])[0]), ['prompt', 'staging', 'resume'])
})

test('凭据请求不能通过另一会话的提示编号写入', async () => {
  const { state, store } = storeFixture()
  const consume = createSecretInteractionConsumer({
    store, now: () => new Date('2026-11-18T00:00:00Z'), encrypt() { throw new Error('不得加密') },
  })
  await assert.rejects(consume({ ownerId, sessionId: 10, promptId: 17, values: { key: 'synthetic-secret' } }), { code: 'not_found' })
  assert.deepEqual(state.writes, [])
})
