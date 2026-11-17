import assert from 'node:assert/strict'
import { test } from 'vitest'
import { boundedScopeMemory, messageBatches, resolveMaintenanceBudget, scopeRevision } from '../../../src/memory/maintenance-batches.js'

test('maintenance batching keeps full messages and stable source ids within the budget', () => {
  const messages = [['one', '甲'.repeat(4)], ['two', '乙'.repeat(4)], ['three', '丙'.repeat(4)]]
  const batches = messageBatches(messages, item => item[1], item => item[0], { maxChars: 9 })
  assert.deepEqual(batches.map(batch => batch.sourceIds), [['one', 'two'], ['three']])
  assert.deepEqual(batches.flatMap(batch => batch.items), messages)
  assert.ok(batches.every(batch => batch.inputChars <= 9 && !batch.hasOversizedItem))
})

test('oversized messages remain whole and are explicitly marked', () => {
  const messages = [{ id: 'oversize', text: 'x'.repeat(5) }]
  const [batch] = messageBatches(messages, item => item.text, item => item.id, { maxChars: 4 })
  assert.deepEqual(batch?.items, messages)
  assert.deepEqual(batch?.sourceIds, ['oversize'])
  assert.equal(batch?.inputChars, 5)
  assert.equal(batch?.hasOversizedItem, true)
})

test('maintenance budget uses Python-compatible model context tiers', () => {
  assert.deepEqual(resolveMaintenanceBudget({ context_tokens: 4096, max_tokens: 8000 }), {
    outputTokens: 1024, batchChars: 1000, existingMemoryChars: 400,
  })
  assert.deepEqual(resolveMaintenanceBudget({ ai: { context_tokens: 8192, max_tokens: 1200 } }), {
    outputTokens: 1200, batchChars: 2500, existingMemoryChars: 1000,
  })
  assert.throws(() => resolveMaintenanceBudget({ context_tokens: 1, max_tokens: 10 }))
})

test('scope revision changes with exact source ids or source content and is stable for same input', () => {
  const first = scopeRevision({ summary: '合成记忆' }, [1, 2], '合成消息')
  assert.equal(scopeRevision({ summary: '合成记忆' }, ['1', '2'], '合成消息'), first)
  assert.notEqual(scopeRevision({ summary: '合成记忆' }, [1, 3], '合成消息'), first)
  assert.notEqual(scopeRevision({ summary: '合成记忆' }, [1, 2], '变更消息'), first)
  assert.equal(first, '3a0b541a6f6ce592a7c2cef055ff9fb545b7fd28cf152481e3362097f28295cc')
  assert.match(first, /^[a-f0-9]{64}$/)
})

test('existing scope memory is bounded without returning complete source data', () => {
  const value = boundedScopeMemory({ summary: '要保留的摘要', profile: 'x'.repeat(20) }, { maxChars: 14 })
  assert.equal(value.length, 14)
  assert.match(value, /^summary:/)
  assert.doesNotMatch(value, /profile/)
})

test('structured scope memory uses Python JSON spacing before applying the character budget', () => {
  assert.equal(
    boundedScopeMemory({ summary: { a: 1, b: [2, 3] } }),
    'summary: {"a": 1, "b": [2, 3]}',
  )
})
