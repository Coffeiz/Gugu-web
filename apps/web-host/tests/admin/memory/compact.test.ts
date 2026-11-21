import assert from 'node:assert/strict'
import test from 'node:test'
import { createImMemoryGroupDailyCompactor } from '../../../src/modules/admin/memory.js'

test('group daily compaction moves oldest batches first and persists only date-preserving model output', async () => {
  const writes: Array<[string, string]> = [], prompts: string[] = []
  const scope = { owner_user_id: 'synthetic-owner', platform: 'qq', bot_id: 'synthetic-bot', scope_type: 'group' as const, scope_id: 'synthetic-group' }
  const compactor = createImMemoryGroupDailyCompactor({
    storage: { async read() { return null }, async write(key, value) { writes.push([key, value]) } },
    async isTombstoned() { return false },
    async readPrompt() { return '群日报压缩提示' },
    readModelSettings() { return { provider: 'synthetic', model: 'synthetic', context_tokens: 4096, max_tokens: 1000 } },
    async complete(request) { prompts.push(request.prompt); return { memory: '## 记录长期记忆：主题\n\n2026-01-01 已整理' } },
  })
  const daily = `## 2026-01-01\n${Array.from({ length: 101 }, (_, index) => `- 记录${index + 1}`).join('\n')}\n`
  await compactor(scope, '', daily)
  assert.equal(prompts.length, 2)
  assert.match(prompts[0]!, /记录2/u)
  assert.match(prompts[0]!, /记录101/u)
  assert.doesNotMatch(prompts[0]!, /记录1\n/u)
  assert.deepEqual(writes.map(([key]) => key.slice(key.lastIndexOf('/') + 1)), ['memory.md', 'daily.md', 'memory.md', 'daily.md'])
  assert.equal(writes.at(-1)?.[1], '')
})

test('group daily compaction leaves pending entries untouched when output loses a date anchor', async () => {
  const writes: string[] = []
  const scope = { owner_user_id: 'synthetic-owner', platform: 'qq', bot_id: 'synthetic-bot', scope_type: 'group' as const, scope_id: 'synthetic-group' }
  const compactor = createImMemoryGroupDailyCompactor({
    storage: { async read() { return null }, async write(key) { writes.push(key) } },
    async isTombstoned() { return false }, async readPrompt() { return '提示' },
    readModelSettings() { return { provider: 'synthetic', model: 'synthetic', context_tokens: 4096, max_tokens: 1000 } },
    async complete() { return { memory: '无日期的长期记忆' } },
  })
  await compactor(scope, '', '## 2026-01-01\n- 记录\n')
  assert.deepEqual(writes, [])
})

test('group daily below Python trigger does not load prompt or call the model', async () => {
  let prompts = 0, completions = 0
  const scope = { owner_user_id: 'synthetic-owner', platform: 'qq', bot_id: 'synthetic-bot', scope_type: 'group' as const, scope_id: 'synthetic-group' }
  const compactor = createImMemoryGroupDailyCompactor({
    storage: { async read() { return null }, async write() {} }, async isTombstoned() { return false },
    async readPrompt() { prompts++; return '提示' },
    readModelSettings() { return { provider: 'synthetic', model: 'synthetic', context_tokens: 4096, max_tokens: 1000 } },
    async complete() { completions++; return { memory: '记忆' } },
  })
  await compactor(scope, '', `## 2026-01-01\n${Array.from({ length: 99 }, (_, index) => `- 记录${index}`).join('\n')}`)
  assert.equal(prompts, 0)
  assert.equal(completions, 0)
})
