import { expect, it, vi } from 'vitest'
import { assembleSubagentCatalog } from '../../../src/agent/context/modules/subagent-catalog.js'
import { createContextFragmentPlan } from '../../../src/agent/context/fragment-plan.js'
import type { ContextModule } from '../../../src/agent/context/fragments.js'
import { buildGreetingPrompt } from '../../../src/agent/scenes/greeting/index.js'
import { createGreetingScene, type GreetingSourceReaders } from '../../../src/agent/scenes/greeting/index.js'

it('按选择和声明顺序加载并分区，完成顺序不影响预算与片段顺序', async () => {
  const skipped = vi.fn(() => '未选择')
  const modules: ContextModule<string, string>[] = [
    { id: 'profile', region: 'snapshot', kind: 'data', async load(owner) { await Promise.resolve(); return owner }, budget: { measure: value => value.length, optional: true } },
    { id: 'summary', region: 'snapshot', kind: 'data', load: () => '摘要', budget: { measure: value => value.length, optional: true } },
    { id: 'instructions', region: 'system', kind: 'instruction', load: () => '任务', budget: { measure: value => value.length } },
    { id: 'input', region: 'turn', kind: 'data', load: () => '输入', budget: { measure: value => value.length } },
    { id: 'unused', region: 'turn', kind: 'data', load: skipped },
  ]
  const assemble = createContextFragmentPlan(modules, ['instructions', 'profile', 'summary', 'input'])
  const signal = new AbortController().signal
  const fragments = await assemble('小北', signal)
  expect(fragments.snapshot.map(part => part.value)).toEqual(['小北', '摘要'])
  expect(fragments.system.map(part => part.value)).toEqual(['任务'])
  expect(fragments.turn.map(part => part.value)).toEqual(['输入'])
  expect((await assemble('小北', signal, 6)).ordered.map(part => part.id)).toEqual(['instructions', 'profile', 'input'])
  await expect(assemble('小北', signal, 3)).rejects.toThrow('必需上下文超出预算')
  expect(skipped).not.toHaveBeenCalled()
})

it('区分空来源、读取失败与取消，非法来源在读取前拒绝', async () => {
  const read = vi.fn(() => undefined)
  const failure = new Error('读取失败')
  const modules: ContextModule<string, string>[] = [
    { id: 'empty', region: 'snapshot', kind: 'data', load: read },
    { id: 'broken', region: 'snapshot', kind: 'data', load() { throw failure } },
  ]
  expect(() => createContextFragmentPlan(modules, ['missing'])).toThrow('未知上下文来源')
  expect(() => createContextFragmentPlan(modules, ['empty', 'empty'])).toThrow('上下文来源重复')
  const controller = new AbortController()
  controller.abort()
  await expect(createContextFragmentPlan(modules, ['empty'])('小北', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(read).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  await expect(createContextFragmentPlan(modules, ['empty'])('小北', signal)).resolves.toMatchObject({ snapshot: [] })
  await expect(createContextFragmentPlan(modules, ['broken'])('小北', signal)).rejects.toBe(failure)
})

it('问候只加载所选画像与摘要，并保持完整场景的原模板投影', async () => {
  const readers = {
    'clock.now': vi.fn(async () => ({ timeZone: 'Asia/Tokyo' })),
    'greeting.last-seen': vi.fn(async () => ({ lastMessageAt: new Date('2026-11-16T07:00:00Z') })),
    'greeting.recent-stance': vi.fn(async () => ({ stance: { value: '闲聊', updatedAt: new Date('2026-11-16T07:30:00Z') } })),
    'overview.projects': vi.fn(async () => ({ projects: [{ id: 1, name: '做面包', status: 'active' as const, progress: 10 }] })),
    'memory.summary': vi.fn(async () => ({ memory: { summary: '学习烘焙' } })),
    'memory.daily': vi.fn(async () => ({ memory: { daily: [{ date: '2026-11-15', note: '烤了面包' }] } })),
    'user.profile': vi.fn(async () => ({ memory: { profile: '喜欢散步' } })),
  } satisfies GreetingSourceReaders
  const signal = new AbortController().signal
  const now = () => new Date('2026-11-16T08:00:00Z')
  const selected = createGreetingScene(readers, 'UTC', ['user.profile', 'memory.summary'])
  const prompt = await selected.preparePrompt('owner-a', 'ja-JP', now, signal)
  expect(prompt).toBe(buildGreetingPrompt({ now: now(), locale: 'ja-JP', timeZone: 'UTC',
    memory: { profile: '喜欢散步', summary: '学习烘焙' } }, { includeTime: false, includeLastSeen: false }))
  for (const [id, read] of Object.entries(readers))
    expect(read).toHaveBeenCalledTimes(id === 'user.profile' || id === 'memory.summary' ? 1 : 0)

  const instructionsOnly = await createGreetingScene(readers, 'UTC', []).preparePrompt('owner-a', 'ja-JP', now, signal)
  expect(instructionsOnly).toContain('自然な日本語')
  expect(instructionsOnly).not.toMatch(/【当前日期和时间】|【上次和你说话】|近期上下文（仅供/)
  for (const [id, read] of Object.entries(readers))
    expect(read).toHaveBeenCalledTimes(id === 'user.profile' || id === 'memory.summary' ? 1 : 0)

  const full = createGreetingScene(readers, 'UTC')
  expect(await full.preparePrompt('owner-a', 'ja-JP', now, signal)).toBe(buildGreetingPrompt({
    now: now(), locale: 'ja-JP', timeZone: 'Asia/Tokyo', lastMessageAt: new Date('2026-11-16T07:00:00Z'),
    stance: { value: '闲聊', updatedAt: new Date('2026-11-16T07:30:00Z') },
    projects: [{ id: 1, name: '做面包', status: 'active', progress: 10 }],
    memory: { profile: '喜欢散步', summary: '学习烘焙', daily: [{ date: '2026-11-15', note: '烤了面包' }] },
  }))
})

it('已授权子 Agent 目录保持稳定顺序，空目录不改主提示词', () => {
  const prefix = '合成主指令'
  const catalog = [
    { id: 'builtin:searcher', description: '查找合成资料' },
    { id: 'builtin:reporter', description: '汇总合成资料' },
  ]
  const expected = [
    '合成主指令',
    '',
    '可委派的子 Agent',
    'builtin:reporter：汇总合成资料',
    'builtin:searcher：查找合成资料',
    '',
    '复杂任务可以委派独立的部分。派单前先判断能否复用同一会话已有的子 Agent：已有报告足以回答时直接用；同一目标的追问、补查、纠错，或能沿用已查资料时，优先用 agent_message 的 send，把新增要求发给原 childId。子 Agent 已完成也可以继续交办；仍在做同一件事时等待回传。',
    '需要复用但不确定 childId 或状态时，可以用 agent_inspect 查一次同会话的子 Agent。只有没有合适的已有子 Agent，或任务目标独立且确实需要并行、隔离上下文时，才用 spawn。交办时说明目标、范围、已授权资料和预期结果。',
    '派单后记下 childId，简短告知用户进度，再做不依赖结果的工作。系统会自动等待、回传并续跑。需要找历史未读报告时查信箱；不要轮询。',
    '收到报告后核对关键结论和来源。证据不足时请原助手补查，最后整合回复。',
  ].join('\n')
  expect(assembleSubagentCatalog(prefix, [])).toBe(prefix)
  expect(assembleSubagentCatalog(prefix, catalog)).toBe(expected)
  expect(assembleSubagentCatalog(prefix, [...catalog].reverse())).toBe(expected)
})
