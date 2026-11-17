import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ProviderError } from '../../../src/agent/providers/errors.js'
import { previewImMaintenanceScope } from '../../../src/memory/im-maintenance-preview.js'

const scope = { owner_user_id: 'synthetic-owner', platform: 'qq', bot_id: 'synthetic-bot', scope_type: 'group' as const, scope_id: 'synthetic-group' }
const messages = [{ id: 1, created_at: '2026-01-01T00:00:00.000Z', platform_user_name: '小北', platform_user_id: 'member-1', content: '甲'.repeat(12) }, { id: 2, created_at: '2026-01-01T00:01:00.000Z', platform_user_name: '小北', platform_user_id: 'member-1', content: '乙'.repeat(12) }]

test('preview splits only on provider context overflow and keeps all source messages in the revision', async () => {
  const prompts: string[] = []
  const result = await previewImMaintenanceScope({
    scope, current: { summary: '已有摘要' }, messages,
    render: message => `[${message.created_at}] [${message.platform_user_name}，platform_user_id=${message.platform_user_id}] ${message.content}`,
    stableSystem: '合成群组反思提示', budget: { outputTokens: 256, batchChars: 1000, existingMemoryChars: 20 },
    async complete({ prompt }) {
      prompts.push(prompt)
      if (prompts.length === 1) throw new ProviderError('context_overflow')
      return { daily: [`批次${prompts.length}`] }
    },
  })
  assert.equal(result.failed, false)
  assert.equal(result.truncatedBatches, 0)
  assert.equal(result.totalBatches, 2)
  assert.equal(result.completedBatches, 2)
  assert.deepEqual(result.plan?.source_message_ids, ['1', '2'])
  assert.deepEqual(result.plan?.output, { daily: ['批次2', '批次3'] })
  assert.match(result.plan?.source_revision ?? '', /^[a-f0-9]{64}$/u)
  assert.equal(prompts.length, 3)
  assert.match(prompts[0]!, /甲{12}/u)
  assert.match(prompts[0]!, /乙{12}/u)
  assert.match(prompts[1]!, /甲{12}/u)
  assert.match(prompts[2]!, /乙{12}/u)
})

test('preview reports oversized and non-overflow provider failures without an applyable plan', async () => {
  const oversized = await previewImMaintenanceScope({
    scope, current: {}, messages: [messages[0]!], render: () => 'x'.repeat(24_001),
    stableSystem: '提示', budget: { outputTokens: 32, batchChars: 100, existingMemoryChars: 0 },
    async complete() { throw new Error('模型不可用') },
  })
  assert.equal(oversized.truncatedBatches, 1)
  assert.equal(oversized.failed, true)
  assert.equal(oversized.plan, undefined)

  const unavailable = await previewImMaintenanceScope({
    scope, current: {}, messages: [messages[0]!], render: message => message.content,
    stableSystem: '提示', budget: { outputTokens: 32, batchChars: 100, existingMemoryChars: 0 },
    async complete() { throw new Error('模型不可用') },
  })
  assert.equal(unavailable.failed, true)
  assert.equal(unavailable.totalBatches, 1)
  assert.equal(unavailable.completedBatches, 0)
  assert.equal(unavailable.plan, undefined)
})

test('single-message overflow retries once without existing memory and blocks destructive fields', async () => {
  const prompts: string[] = []
  const result = await previewImMaintenanceScope({
    scope, current: { summary: '旧摘要' }, messages: [messages[0]!], render: message => message.content,
    stableSystem: '提示', budget: { outputTokens: 32, batchChars: 100, existingMemoryChars: 100 },
    async complete({ prompt }) {
      prompts.push(prompt)
      if (prompts.length === 1) throw new ProviderError('context_overflow')
      return { facts: ['新增事实'], summary: '不允许覆盖', profile_remove: ['不允许删除'] }
    },
  })
  assert.equal(prompts.length, 2)
  assert.match(prompts[0]!, /旧摘要/u)
  assert.doesNotMatch(prompts[1]!, /旧摘要/u)
  assert.deepEqual(result.plan?.output, { facts: ['新增事实'] })
})
