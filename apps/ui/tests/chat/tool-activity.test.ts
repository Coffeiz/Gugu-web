// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref } from 'vue'
import { i18n } from '@/i18n'
import { localizedToolStatusLabel } from '@/components/common/gugu-chat/messageDisplay'
import GuguChatToolActivity from '@/components/common/gugu-chat/GuguChatToolActivity.vue'
import { chatToolDetailsKey } from '@/components/common/gugu-chat/chatPresentationAccess'
import { formatToolDuration, projectChatRows, toolGroupElapsedMs, toolActivityLabel, toolHasNoMatches } from '@/components/common/gugu-chat/toolActivity'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'

function message(id: number, role: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: '', time: '', ...extra }
}

it('确认卡与助手正文按时序切开活动组，相邻工具仍合并', () => {
  const messages = [message(1, 'user'), message(2, 'tool'), message(3, 'interaction'),
    message(4, 'tool'), message(5, 'tool'), message(6, 'interaction'),
    message(7, 'tool'), message(8, 'ai', { text: '正文' }), message(9, 'tool')]
  const result = projectChatRows(messages)
  expect(result.rows.map(({ msg, tools }) => tools?.map(tool => tool.id) ?? msg.id)).toEqual([1, [2], 3, [4, 5], 6, [7], 8, [9]])
  expect(result.rowIndexByMessageIndex).toEqual([0, 1, 2, 3, 3, 4, 5, 6, 7])
  expect(result.openGroupIndex).toBe(7)
  expect(projectChatRows([...messages, message(10, 'ai', { streaming: true })]).openGroupIndex).toBe(7)
  expect(projectChatRows([...messages, message(10, 'ai', { text: '下一段' })]).openGroupIndex).toBeUndefined()
  expect(projectChatRows([message(1, 'tool', { runId: 'a' }), message(2, 'tool', { runId: 'b' })]).rows).toHaveLength(2)
})

it('并行活动共享摘要，逐项按需加载脱敏回执并保留展开状态', async () => {
  const tools = reactive([
    message(1, 'tool', { toolLabel: '检索甲', toolStatus: 'running', toolDurationMs: 400, toolDetailsAvailable: true,
      _toolDetailsSource: { kind: 'timeline', messageId: 10, index: 0 } }),
    message(2, 'tool', { toolLabel: '检索乙', toolStatus: 'running', toolDurationMs: 800 }),
  ])
  const expanded = ref(false)
  const expandedTools = reactive(new Set<string>())
  const readDetails = vi.fn(async () => ({ toolInput: '合成查询', toolResult: '合成结果' }))
  const host = document.createElement('div')
  const app = createApp({
    render: () => h(GuguChatToolActivity, { tools, expanded: expanded.value, expandedTools,
      sessionId: 10, awaitingReply: false, elapsedMs: 5400, onToggle: () => { expanded.value = !expanded.value },
      onDetail: (id, value) => value ? expandedTools.add(String(id)) : expandedTools.delete(String(id)) }),
  })
  app.use(i18n).provide(chatToolDetailsKey, readDetails).mount(host)
  try {
    expect(host.textContent).toContain('检索甲')
    expect(host.textContent).toContain(i18n.global.t('chatUi.toolActivityParallel', { count: 1 }))
    tools[0]!.toolStatus = 'success'
    await nextTick()
    expect(host.textContent).toContain('检索乙')
    tools[1]!.toolStatus = 'error'
    await nextTick()
    expect(host.textContent).toContain(i18n.global.t('chatUi.toolActivityTotal', { count: 2 }))
    expect(host.textContent).toContain(i18n.global.t('chatUi.toolActivityFailed', { count: 1 }))
    expect(host.querySelector('[title="' + i18n.global.t('chatUi.toolActivityDuration', { duration: '5.4s' }) + '"]')?.textContent?.trim()).toBe('5.4s')
    host.querySelector('button')!.click()
    await nextTick()
    expect(host.querySelectorAll('button')).toHaveLength(3)
    expect(readDetails).not.toHaveBeenCalled()
    host.querySelectorAll('button')[1]!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('合成结果'))
    expect(readDetails).toHaveBeenCalledExactlyOnceWith(10, { kind: 'timeline', messageId: 10, index: 0 })
  } finally {
    app.unmount()
  }
})

it('工具之间的短空档不闪状态，长空档显示处理中，确认和结束时停止', async () => {
  vi.useFakeTimers()
  const tools = reactive([message(1, 'tool', { toolLabel: '检索甲', toolStatus: 'running' })])
  const awaitingReply = ref(true)
  const host = document.createElement('div')
  const app = createApp({
    render: () => h(GuguChatToolActivity, { tools, expanded: false, expandedTools: new Set<string>(),
      sessionId: 10, awaitingReply: awaitingReply.value }),
  })
  app.use(i18n).mount(host)
  const preparing = i18n.global.t('chatUi.toolActivityPreparing')
  try {
    tools[0]!.toolStatus = 'success'
    await nextTick()
    await vi.advanceTimersByTimeAsync(299)
    expect(host.textContent).toContain('检索甲')
    expect(host.textContent).not.toContain(preparing)
    tools.push(message(2, 'tool', { toolLabel: '检索乙', toolStatus: 'running' }))
    await nextTick()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.textContent).toContain('检索乙')
    expect(host.textContent).not.toContain(preparing)

    tools[1]!.toolStatus = 'success'
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(host.textContent).toContain(preparing)
    tools.push(message(3, 'tool', { toolStatus: 'waiting' }))
    await nextTick()
    expect(host.textContent).toContain(i18n.global.t('chatUi.toolWaiting'))
    expect(host.textContent).not.toContain(preparing)

    tools[2]!.toolStatus = 'success'
    await nextTick()
    awaitingReply.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(host.textContent).toContain(i18n.global.t('chatUi.toolActivityTotal', { count: 3 }))
    expect(host.textContent).not.toContain(preparing)
  } finally {
    app.unmount()
    vi.useRealTimers()
  }
})


it('只在最后一个工具组显示同轮消息到回复完成的实际间隔', () => {
  const runId = 'sample-run'
  const user = message(1, 'user', { runId, _createdAt: '2026-11-22T00:00:00Z' })
  const firstTool = message(2, 'tool', { runId, toolDurationMs: 100 })
  const intermediate = message(3, 'ai', { runId, _updatedAt: '2026-11-22T00:00:02Z' })
  const secondTool = message(4, 'tool', { runId, toolDurationMs: 300 })
  const final = message(5, 'ai', { runId, _updatedAt: '2026-11-22T00:00:09Z' })
  const series = [user, firstTool, intermediate, secondTool]
  expect(projectChatRows([...series, final]).rows.filter(row => row.tools).map(row => row.elapsedMs))
    .toEqual([undefined, 9000])
  expect(projectChatRows([...series, { ...final, streaming: true }]).rows.some(row => row.elapsedMs !== undefined)).toBe(false)
  expect(projectChatRows([...series.slice(1), final]).rows.some(row => row.elapsedMs !== undefined)).toBe(false)
})


it('工具组耗时采用首开始到末结束的时间跨度', () => {
  const tool = (id: number, start: string, end: string) => message(id, 'tool', {
    _createdAt: `2026-11-22T00:00:${start}Z`, _updatedAt: `2026-11-22T00:00:${end}Z`,
  })
  expect(toolGroupElapsedMs([tool(1, '00', '02'), tool(2, '04', '06')])).toBe(6000)
  expect(toolGroupElapsedMs([tool(1, '00', '04'), tool(2, '01', '03')])).toBe(4000)
  expect(toolGroupElapsedMs([message(1, 'tool', { toolDurationMs: 120 })])).toBe(120)
})


it('历史 Shell 动作按当前语言显示，并将无匹配结果从失败中区分', () => {
  const tool = message(1, 'tool', { toolName: 'shell', toolStatus: 'error',
    shellActivity: { action: 'search', target: 'package.json', noMatches: true } })
  expect(toolHasNoMatches(tool)).toBe(true)
  expect(toolActivityLabel(tool, (key, values) => i18n.global.t(key, values ?? {}, { locale: 'en-US' }), key => i18n.global.te(key, 'en-US')))
    .toBe('Search in package.json')
  expect(toolActivityLabel(message(2, 'tool', { toolName: 'view_image' }),
    key => i18n.global.t(key, {}, { locale: 'ja-JP' }), key => i18n.global.te(key, 'ja-JP')))
    .toBe('画像を表示')
})

it('Shell 运行状态使用当前调用协议和保留的动作摘要', () => {
  const translated = i18n.global.t('toolNames.shell_git_diff')
  expect(localizedToolStatusLabel({ name: 'call_tool', input: { tool_name: 'shell', arguments: { command: 'git diff' } } })).toBe(translated)
  expect(localizedToolStatusLabel({ name: 'shell', shellActivity: { action: 'git_diff' } })).toBe(translated)
})

it('折叠的单条 Shell 工具在完成后仍显示具体动作', () => {
  const host = document.createElement('div')
  const tool = message(1, 'tool', { toolName: 'shell', toolStatus: 'success', shellActivity: { action: 'git_diff' } })
  const app = createApp({ render: () => h(GuguChatToolActivity, {
    tools: [tool], expanded: false, expandedTools: new Set<string>(), sessionId: 10,
  }) })
  app.use(i18n).mount(host)
  try {
    expect(host.textContent).toContain(i18n.global.t('toolNames.shell_git_diff'))
  } finally {
    app.unmount()
  }
})

it('子 Agent 操作留在普通工具组，输出用群成员消息展示一次', () => {
  const childId = 'a1b2c3d4'
  const result = { childId, status: 'completed', finalMessage: '子任务原文' }
  const { rows, subagentNames } = projectChatRows([
    message(1, 'tool', { runId: 'earlier-parent', toolName: 'agent_message', toolResult: {
      action: 'spawn', run: { childId, agentId: 'builtin:searcher' },
    } }),
    message(2, 'tool', { runId: 'parent', toolName: 'agent_wait', toolResult: result }),
    message(3, 'tool', { runId: 'parent', toolName: 'subagent_result', toolResult: result }),
    message(4, 'ai', { runId: 'parent', text: '主 Agent 回复' }),
  ])
  expect(rows.map(row => row.tools?.map(tool => tool.toolName) ?? row.msg.text))
    .toEqual([['agent_message'], ['agent_wait'], '子任务原文', '主 Agent 回复'])
  for (const tool of [rows[0]!.tools![0]!, rows[1]!.tools![0]!])
    expect(toolActivityLabel(tool, i18n.global.t, i18n.global.te, subagentNames)).toBe(i18n.global.t(`toolNames.${tool.toolName}_target`, { target: 'Searcher' }))
  expect(rows[2]?.msg).toMatchObject({ role: 'member', subagentOutput: true, speakerLabel: 'Searcher' })
})

it('查看活动列表使用唯一的 Agent 名称，混合列表保留通用标题', () => {
  const label = (...agentIds: string[]) => toolActivityLabel(message(1, 'tool', {
    toolName: 'agent_inspect', toolResult: { view: 'list', runs: agentIds.map(agentId => ({ agentId })) },
  }), i18n.global.t, i18n.global.te)
  expect(label('builtin:searcher', 'builtin:searcher'))
    .toBe(i18n.global.t('toolNames.agent_inspect_target', { target: 'Searcher' }))
  expect(label('builtin:searcher', 'builtin:reporter')).toBe(i18n.global.t('toolNames.agent_inspect'))
})

it.each([
  [262, '262ms'], [7000, '7.0s'], [60_000, '1m00s'], [213_700, '3m34s'],
  [3_599_700, '1h00m00s'], [3_725_000, '1h02m05s'],
])('工具耗时 %i 毫秒显示为 %s', (elapsed, expected) => {
  expect(formatToolDuration(elapsed)).toBe(expected)
})

it('未匹配专用动作的 Shell 历史摘要显示命令名', () => {
  expect(localizedToolStatusLabel({
    name: 'shell', shellActivity: { action: 'command', target: 'rsync' },
  })).toBe(i18n.global.t('toolNames.shell_command_target', { target: 'rsync' }))
})

it('聊天标题用同一份命令摘要显示分类和条数', () => {
  const tool = message(1, 'tool', { toolName: 'shell', toolInput: { command: 'date; whoami; pwd' } })
  const translate = (key: string, values?: Record<string, string>) => i18n.global.t(key, values ?? {}, { locale: 'en-US' })
  expect(toolActivityLabel(tool, translate, key => i18n.global.te(key, 'en-US'))).toBe('View system information · 3 commands')
})
