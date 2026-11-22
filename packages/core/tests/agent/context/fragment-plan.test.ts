import { expect, it, vi } from 'vitest'
import { assembleSubagentCatalog } from '../../../src/agent/context/modules/subagent-catalog.js'
import { createContextFragmentPlan } from '../../../src/agent/context/fragment-plan.js'
import type { ContextModule } from '../../../src/agent/context/fragments.js'
import { buildGreetingPrompt } from '../../../src/agent/greeting.js'
import { createGreetingScene, type GreetingSourceReaders } from '../../../src/agent/scenes/greeting/definition.js'

it('按选择和声明顺序加载并分区，完成顺序不影响预算与片段顺序', async () => {
  const skipped = vi.fn(() => '未选择')
  const modules: ContextModule<string, string>[] = [
    { id: 'profile', version: 1, region: 'snapshot', kind: 'data', async load(owner) { await Promise.resolve(); return owner }, budget: { measure: value => value.length, optional: true } },
    { id: 'summary', version: 1, region: 'snapshot', kind: 'data', load: () => '摘要', budget: { measure: value => value.length, optional: true } },
    { id: 'instructions', version: 1, region: 'system', kind: 'instruction', load: () => '任务', budget: { measure: value => value.length } },
    { id: 'input', version: 1, region: 'turn', kind: 'data', load: () => '输入', budget: { measure: value => value.length } },
    { id: 'unused', version: 1, region: 'turn', kind: 'data', load: skipped },
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
    { id: 'empty', version: 1, region: 'snapshot', kind: 'data', load: read },
    { id: 'broken', version: 1, region: 'snapshot', kind: 'data', load() { throw failure } },
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
    '优先委派。遇到多来源查证、跨多份文件比对、复杂排查或其他多步任务，先拆出可独立完成的部分。只要目录里有能力匹配的助手，就在自己开始这部分工作前派单。互不依赖的事项可以同时派出。单步任务或没有合适助手时直接处理。',
    '',
    '派单与分工。交代目标、范围、必要的已授权资料和预期结果。派单成功后，记下返回的 childId，简短告诉用户已交给助手，再推进未委派且不依赖结果的工作。',
    '',
    '自动续跑。派单后可以先告诉用户进度，再处理未委派的工作。当前 Run 准备结束时，系统会自动等待尚未返回的子任务，收到结果后继续执行。需要查看未读消息或报告时可调用 agent_inbox。信箱为空时立即返回，由系统负责等待和唤醒。',
    '',
    '核对与交付。收到结果后，核对关键结论、来源和影响用户判断的疑点。证据不足时优先请原助手补查；只有助手无法继续时，才接手必要部分。最后整合结果回复用户。',
  ].join('\n')
  expect(assembleSubagentCatalog(prefix, [])).toBe(prefix)
  expect(assembleSubagentCatalog(prefix, catalog)).toBe(expected)
  expect(assembleSubagentCatalog(prefix, [...catalog].reverse())).toBe(expected)
})
