// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref } from 'vue'
import { i18n } from '@/i18n'
import GuguChatToolActivity from '@/components/common/gugu-chat/GuguChatToolActivity.vue'
import { chatToolDetailsKey } from '@/components/common/gugu-chat/chatPresentationAccess'
import { projectChatRows } from '@/components/common/gugu-chat/toolActivity'
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
      sessionId: 10, awaitingReply: false, onToggle: () => { expanded.value = !expanded.value },
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
    expect(host.querySelector('[title="' + i18n.global.t('chatUi.toolActivityDuration', { duration: '1.2s' }) + '"]')?.textContent?.trim()).toBe('1.2s')
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
