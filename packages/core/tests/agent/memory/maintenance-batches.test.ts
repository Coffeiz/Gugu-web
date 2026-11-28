import assert from 'node:assert/strict'
import { test } from 'vitest'
import { boundedScopeMemory, messageBatches, resolveMaintenanceBudget, scopeRevision } from '../../../src/memory/maintenance-batches.js'
import { accountMemoryCleanupRevision, planAccountMemoryCleanup, readAccountMemoryCleanupSource } from '../../../src/memory/account-cleanup-preview.js'
import { prepareAccountMemoryCleanupChanges } from '../../../src/memory/account-cleanup-apply.js'
import { publishAccountMemoryCleanup, type AccountMemoryCleanupPublication } from '../../../src/memory/account-cleanup-publication.js'

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

const modelBudget = { context_tokens: 128000, max_tokens: 4000 }
const revision = 'synthetic-account-revision'

test('用户记忆预览只采用多数票，保护高置信条目并返回可确认的原文', async () => {
  const review = [{ remove: [0, 0, 1, 2, 80] }, { remove: [0, 2] }, { remove: [0, 2] }]
  const split = [{ move: [3] }, { move: [3] }, { move: [] }]
  const planned = await planAccountMemoryCleanup({
    revision, modelBudget,
    patterns: [
      { id: 'delete', text: '一次性事项', kind: 'inferred', conf: 0.6 },
      { id: 'keep', text: '只有一票', kind: 'inferred', conf: 0.6 },
      { id: 'protected', text: '确定的模式', kind: 'observed', conf: 0.8 },
      { id: 'move', text: '长期爱好', kind: 'inferred', conf: 0.4 },
    ],
    profile: [{ text: '近期开始跑步' }, { text: '喜欢看书' }],
    daily: '- 2026-11-12 合成日报\n- 2026-11-12 另一则',
    async complete(request) {
      assert.equal(request.maxTokens, 4000)
      assert.match(request.prompt, /^\[0\] \(inferred\) 一次性事项/u)
      return (request.system.includes('"move"') ? split : review).shift()
    },
  })
  assert.deepEqual(planned, {
    ready: true, totalBatches: 2, completedBatches: 2, plan: {
      removed_ids: ['delete'], removed_texts: ['一次性事项'], moved_ids: ['move'], moved_texts: ['长期爱好'],
      profile_event_migrated: 1, profile_event_texts: ['近期开始跑步'],
      daily_migrated: 2, daily_texts: ['2026-11-12 合成日报', '2026-11-12 另一则'],
      total: 4, source_revision: revision, batch_count: 2,
    },
  })
  assert.equal(review.length + split.length, 0)
})

test('用户记忆预览将局部索引映射回稳定 ID，搬迁沿用旧版跨批次票数门槛', async () => {
  const patterns = ['first', 'second', 'third'].map(id => ({ id, kind: 'inferred', text: id.repeat(1800) }))
  const planned = await planAccountMemoryCleanup({
    revision, modelBudget, patterns, profile: [], daily: '## 2026-11-12\n- 已分组',
    async complete({ system }) { return system.includes('"move"') ? { move: [0] } : { remove: [0], merge: [] } },
  })
  assert.equal(planned.ready, true)
  assert.equal(planned.totalBatches, 4)
  assert.deepEqual(planned.plan?.removed_ids, ['first', 'third'])
  assert.deepEqual(planned.plan?.moved_ids, [])
  assert.equal(planned.plan?.daily_migrated, 0)
})

test('无有效投票或单条超限时，用户记忆预览拒绝提供可应用计划', async () => {
  const input = { revision, modelBudget, profile: [{ text: '这周临时事件' }], daily: '', async complete() { return {} } }
  const wrong = await planAccountMemoryCleanup({ ...input, patterns: [{ id: 'a', text: '合成模式' }] })
  assert.equal(wrong.ready, false)
  assert.equal(wrong.plan, null)
  const oversized = await planAccountMemoryCleanup({
    ...input, patterns: [{ id: 'a', text: '甲'.repeat(24000) }],
    async complete() { assert.fail('超限条目不得发给模型') },
  })
  assert.equal(oversized.ready, false)
  assert.equal(oversized.plan, null)
})

test('用户记忆版本区分缺失、空文件和原始字节变化，包含仍可回填的旧 facts', () => {
  const empty = new Uint8Array()
  const raw = Uint8Array.of(0xff)
  const unchanged = accountMemoryCleanupRevision({})
  assert.notEqual(accountMemoryCleanupRevision({ 'profile.json': empty }), unchanged)
  assert.notEqual(accountMemoryCleanupRevision({ 'facts.md': raw }), unchanged)
  assert.notEqual(accountMemoryCleanupRevision({ 'facts.md': Uint8Array.of(0xfe) }),
    accountMemoryCleanupRevision({ 'facts.md': raw }))
})

test('应用维护计划先核对版本，然后按已确认内容计算四类改写', async () => {
  const source = {
    revision, modelBudget,
    patterns: [
      { id: 'drop', text: '一次提醒', kind: 'inferred' },
      { id: 'move', text: '喜欢冷萃咖啡', kind: 'inferred' },
      { id: 'keep', text: '优先复核证据', kind: 'observed', conf: 0.9 },
    ],
    profile: [{ text: '最近开始跑步', type: 'note', ts: 1 }, { text: '居住在合成城市', type: 'address', ts: 2 }],
    memory: '# 合成记忆',
    daily: '- 2026-11-12 甲\n- 2026-11-12 乙\n- 2026-11-11 丙',
    async complete({ system }: { system: string }) { return system.includes('"move"') ? { move: [1] } : { remove: [0] } },
  }
  const { plan } = await planAccountMemoryCleanup(source)
  assert.ok(plan)
  assert.throws(() => prepareAccountMemoryCleanupChanges({ ...source, revision: 'changed' }, plan, 3),
    /源数据发生变化/u)
  const changes = prepareAccountMemoryCleanupChanges(source, plan, 3)
  assert.deepEqual(changes, {
    patterns: [source.patterns[2]], profile: [source.profile[1], { type: 'note', text: '喜欢冷萃咖啡', ts: 3 }],
    memory: '# 合成记忆\n\n## 画像迁移补记\n- 最近开始跑步',
    daily: '## 2026-11-12\n- 甲\n- 乙\n\n## 2026-11-11\n- 丙\n',
  })
  assert.equal(source.patterns.length, 3)
  assert.equal(source.profile.length, 2)
})

test('画像事件已经落进长期记忆时，只清理原画像条目', async () => {
  const source = {
    revision, modelBudget, patterns: [], profile: [{ text: '最近开始跑步' }, { text: '喜欢看书' }],
    memory: '既有记忆：最近开始跑步', daily: '',
    async complete() { assert.fail('无模式条目时不需要调用模型') },
  }
  const { plan } = await planAccountMemoryCleanup(source)
  assert.ok(plan)
  assert.deepEqual(prepareAccountMemoryCleanupChanges(source, plan, 1), { profile: [{ text: '喜欢看书' }] })
})

test('只读快照以主档案为准，旧 Markdown 条目重读后仍可按同一 ID 应用', async () => {
  const bytes = (value: string) => new TextEncoder().encode(value)
  const files = {
    'facts.md': bytes('- 某个合成项目的进度\n- 保留的旧条目'),
    'profile.json': bytes('["目前正在搬家",{"type":"custom","text":"合成长久属性"}]'),
  }
  const preview = readAccountMemoryCleanupSource(files, 100)
  const current = readAccountMemoryCleanupSource(files, 101)
  assert.deepEqual(preview.patterns.map(row => row.id), current.patterns.map(row => row.id))
  assert.notEqual(preview.patterns[0]?.id, preview.patterns[1]?.id)
  assert.deepEqual(preview.profile, [
    { type: 'note', text: '目前正在搬家', ts: null },
    { type: 'note', text: '合成长久属性', ts: null },
  ])
  const result = await planAccountMemoryCleanup({
    ...preview, modelBudget,
    async complete({ system }) { return system.includes('"move"') ? { move: [] } : { remove: [0] } },
  })
  assert.ok(result.plan)
  const applied = prepareAccountMemoryCleanupChanges(current, result.plan, 101)
  assert.deepEqual(applied.patterns?.map(row => row.text), ['保留的旧条目'])
  assert.deepEqual(readAccountMemoryCleanupSource({ ...files, 'pattern.json': bytes('[]') }, 101).patterns, [])
  assert.throws(() => readAccountMemoryCleanupSource({ ...files, 'pattern.json': bytes('{坏数据') }, 101), /档案无效/u)
  assert.throws(() => readAccountMemoryCleanupSource({ ...files, 'profile.json': bytes('{坏数据') }, 101), /档案无效/u)
})

test('维护多文件发布从中断处继续，保留已发布内容并拒绝覆盖中断期间的编辑', async () => {
  const encode = (value: string) => new TextEncoder().encode(value)
  const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)
  const files = new Map<string, Uint8Array>([
    ['pattern.json', encode('[{"id":"stable","text":"确认搬迁的稳定偏好"}]')],
    ['profile.json', encode('[{"text":"既有画像"}]')],
    ['pattern_vec.json', encode('{"stable":{"v":[0.2],"t":"synthetic-model"}}')],
  ])
  const revision = accountMemoryCleanupRevision(Object.fromEntries(files))
  const { plan } = await planAccountMemoryCleanup({
    ...readAccountMemoryCleanupSource(Object.fromEntries(files), 1),
    modelBudget, async complete({ system }) { return system.includes('"move"') ? { move: [0] } : { remove: [] } },
  })
  assert.ok(plan)
  let publication: AccountMemoryCleanupPublication | null = null
  let interrupted = true
  const writes: string[] = []
  const ports = {
    async read(name: string) { return files.get(name) ?? null },
    async write(name: string, content: string) {
      assert.ok(publication)
      if (name === 'pattern.json' && interrupted) throw new Error('合成发布中断')
      writes.push(name)
      files.set(name, encode(content))
    },
    async loadPublication() { return publication },
    async savePublication(value: AccountMemoryCleanupPublication) { publication = structuredClone(value) },
  }
  await assert.rejects(publishAccountMemoryCleanup('operation', plan, ports, 1), /合成发布中断/u)
  assert.match(decode(files.get('profile.json')), /确认搬迁的稳定偏好/u)
  assert.match(decode(files.get('pattern.json')), /确认搬迁的稳定偏好/u)
  const beforeEdit = files.get('pattern.json')!
  files.set('pattern.json', encode('[{"id":"new","text":"中断后并行写入"}]'))
  const beforeRetry = [...writes]
  await assert.rejects(publishAccountMemoryCleanup('operation', plan, ports, 2), /源数据发生变化/u)
  assert.deepEqual(writes, beforeRetry)
  assert.match(decode(files.get('pattern.json')), /中断后并行写入/u)
  files.set('pattern.json', beforeEdit)
  interrupted = false
  const completed = await publishAccountMemoryCleanup('operation', plan, ports, 3)
  assert.deepEqual(completed, { touched: true, removed: 0, moved: 1, profileEvents: 0, daily: 0 })
  assert.equal(writes.filter(name => name === 'profile.json').length, 1)
  assert.equal(decode(files.get('pattern_vec.json')), '{}')
  assert.match(decode(files.get('profile.json')), /确认搬迁的稳定偏好/u)
  const lastWrites = [...writes]
  assert.deepEqual(await publishAccountMemoryCleanup('operation', plan, ports, 4), completed)
  assert.deepEqual(writes, lastWrites)
  assert.equal(plan.source_revision, revision)
})
