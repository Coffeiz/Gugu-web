// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { chatHideSuccessfulShellResultKey, chatToolDetailsKey } from '@/components/common/gugu-chat/chatPresentationAccess'
import { readDesktopChatToolDetails } from '../../src/desktop/shell/agent-chat'
import GuguChatToolBubble from '@/components/common/gugu-chat/GuguChatToolBubble.vue'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'
import { agentApi } from '@/services/api'

vi.mock('@/services/api', () => ({ agentApi: { getToolEventDetails: vi.fn() } }))
vi.mock('vue-i18n', async importOriginal => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key, te: (key: string) => key === 'toolNames.list_projects' }) }))

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = []
function mountBubble(overrides: Partial<ChatMessage> = {}, readDetails?: typeof readDesktopChatToolDetails, hideSuccessfulShellResult = false) {
  const msg = reactive<ChatMessage>({ id: 1, role: 'tool', text: '', time: '', toolName: 'shell',
    toolStatus: 'success', toolDetailsAvailable: true,
    _toolDetailsSource: { kind: 'timeline', messageId: 11, index: 0 }, ...overrides })
  const expanded = ref(false)
  const changes = vi.fn((value: boolean) => { expanded.value = value })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({ setup: () => () => h(GuguChatToolBubble, {
    msg, sessionId: 7, expanded: expanded.value, 'onUpdate:expanded': changes,
  }) }))
  if (readDetails) app.provide(chatToolDetailsKey, readDetails)
  if (hideSuccessfulShellResult) app.provide(chatHideSuccessfulShellResultKey, true)
  app.mount(host)
  mounted.push({ app, host })
  return { app, host, msg, expanded, changes, click: () => host.querySelector<HTMLButtonElement>('.tool-event-head')!.click() }
}
function pendingDetails() {
  let resolve!: (value: { toolInput?: unknown; toolResult?: unknown }) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<{ toolInput?: unknown; toolResult?: unknown }>((yes, no) => { resolve = yes; reject = no })
  vi.mocked(agentApi.getToolEventDetails).mockReturnValueOnce(promise)
  return { resolve, reject }
}
async function settle() { await Promise.resolve(); await nextTick() }

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() }
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('桌面历史卡片展开时读取本机会话详情，并渲染参数和结果', async () => {
  const agentSessions = vi.fn().mockResolvedValue({
    ok: true, result: { toolInput: { query: '合成查询' }, toolResult: { text: '合成本机结果' } },
  })
  vi.stubGlobal('guguDesktop', { agentSessions })
  const bubble = mountBubble({ toolName: 'search_memory' }, readDesktopChatToolDetails)
  expect(agentSessions).not.toHaveBeenCalled()
  bubble.click()
  await vi.waitFor(() => expect(bubble.expanded.value).toBe(true))
  expect(agentSessions).toHaveBeenCalledExactlyOnceWith({ action: 'toolDetails', id: 7, messageId: 11, index: 0 })
  expect(agentApi.getToolEventDetails).not.toHaveBeenCalled()
  expect(bubble.host.querySelector('.tool-detail-shell')?.textContent).toContain('合成查询')
  expect(bubble.host.querySelector('.tool-detail-shell')?.textContent).toContain('合成本机结果')
})

it.each([
  ['success', false],
  ['error', true],
] as const)('桌面 Shell 状态为 %s 时仅在失败后展示结果', async (toolStatus, showsResult) => {
  const readDetails = vi.fn().mockResolvedValue({
    toolInput: { command: 'cat sample.txt' },
    toolResult: { stderr: '合成结果', cwd: '/example', exit_code: toolStatus === 'error' ? 1 : 0 },
  })
  const bubble = mountBubble({ toolStatus }, readDetails, true)
  bubble.click()
  await vi.waitFor(() => expect(bubble.expanded.value).toBe(true))
  const details = bubble.host.querySelector('.tool-detail-shell')?.textContent ?? ''
  expect(details).toContain('cat sample.txt')
  expect(details.includes('合成结果')).toBe(showsResult)
  expect(details.includes('/example')).toBe(showsResult)
})

it('运行中的卡片恢复计时，结束后显示持久化耗时', async () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-01-01T00:00:03Z'))
    const { host, msg } = mountBubble({ toolStatus: 'running', toolStartedAt: '2026-01-01T00:00:01Z' })
    const duration = () => host.querySelector('.tool-event-duration')?.textContent
    expect(duration()).toBe('2.0s')
    await vi.advanceTimersByTimeAsync(500)
    expect(duration()).toBe('2.5s')
    msg.toolStatus = 'success'
    msg.toolDurationMs = 2600
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(duration()).toBe('2.6s')
  } finally {
    vi.useRealTimers()
  }
})

it('历史中的未知工具结果显示未确认状态且不继续计时', () => {
  const { host } = mountBubble({ toolStatus: 'unknown', toolStartedAt: '2026-01-01T00:00:01Z' })
  expect(host.textContent).toContain('chatUi.toolResultUnknown')
  expect(host.textContent).not.toContain('chatUi.toolRunning')
  expect(host.querySelector('.tool-event-duration')).toBeNull()
})

it('管理员覆盖优先显示，只有历史默认标签时沿用当前语言', () => {
  const custom = mountBubble(Object.assign({ toolName: 'list_projects' }, { toolLabelOverride: '正在核对项目' }))
  expect(custom.host.querySelector('.tool-event-label')?.textContent).toBe('正在核对项目')
  const localized = mountBubble({ toolName: 'list_projects', toolLabel: '查询项目' })
  expect(localized.host.querySelector('.tool-event-label')?.textContent).toBe('toolNames.list_projects')
})

it('历史退役工具卡片使用通用标签', () => {
  const { host } = mountBubble({ toolName: 'read_file', toolLabel: '读取文件' })
  expect(host.querySelector('.tool-event-label')?.textContent).toBe('chatUi.toolCall')
  expect(host.textContent).not.toContain('read_file')
})

it('详情返回前保持折叠，完整输入和结果就绪后只展开一次', async () => {
  vi.useFakeTimers()
  const request = pendingDetails()
  const bubble = mountBubble()
  bubble.click()
  await nextTick()
  expect(bubble.host.querySelector('.tool-detail-shell')).toBeNull()
  expect(bubble.host.textContent).toContain('chatUi.toolDone')
  expect(bubble.host.textContent).not.toContain('chatUi.loadingToolDetails')
  expect(bubble.host.querySelector('button')?.getAttribute('aria-busy')).toBe('true')
  await vi.advanceTimersByTimeAsync(100)
  expect(bubble.host.textContent).not.toContain('chatUi.loadingToolDetails')
  expect(bubble.changes).not.toHaveBeenCalled()
  request.resolve({ toolInput: { cmd: 'pwd' }, toolResult: '合成结果' })
  await settle()
  expect(bubble.changes.mock.calls).toEqual([[true]])
  await vi.advanceTimersByTimeAsync(150)
  expect(bubble.host.textContent).not.toContain('chatUi.loadingToolDetails')
  expect(bubble.host.querySelector('.tool-detail-shell')?.textContent).toContain('合成结果')
  expect(bubble.host.querySelector('.tool-detail-shell')?.textContent).toContain('pwd')
})

it('已有详情直接展开，不重复请求', async () => {
  const bubble = mountBubble({ toolInput: {}, toolResult: '缓存结果', _toolDetailsLoaded: true })
  bubble.click()
  await nextTick()
  expect(bubble.expanded.value).toBe(true)
  expect(agentApi.getToolEventDetails).not.toHaveBeenCalled()
})

it('已展开卡片接管到历史投影时自动加载详情并避免空白', async () => {
  vi.useFakeTimers()
  let resolveDetails!: (value: { toolInput?: unknown; toolResult?: unknown }) => void
  vi.mocked(agentApi.getToolEventDetails).mockReturnValueOnce(new Promise(resolve => {
    resolveDetails = resolve
  }))
  const current = ref<ChatMessage>({
    id: 1, role: 'tool', text: '', time: '', toolName: 'shell', toolStatus: 'cancelled',
    toolInput: { command: 'pwd' }, toolResult: '已取消',
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({ setup: () => () => h(GuguChatToolBubble, {
    msg: current.value, sessionId: 7, expanded: true,
  }) }))
  app.mount(host)
  await nextTick()

  current.value = {
    ...current.value, toolInput: undefined, toolResult: undefined,
    toolDetailsAvailable: true,
    _toolDetailsSource: { kind: 'timeline', messageId: 11, index: 0 },
  }
  await nextTick()
  expect(agentApi.getToolEventDetails).toHaveBeenCalledWith(7, { kind: 'timeline', messageId: 11, index: 0 })
  expect(host.textContent).not.toContain('chatUi.loadingToolDetails')
  await vi.advanceTimersByTimeAsync(151)
  expect(host.textContent).toContain('chatUi.loadingToolDetails')

  resolveDetails({ toolInput: { command: 'pwd' }, toolResult: '已取消' })
  await settle()
  expect(host.querySelector('.tool-detail-shell')?.textContent).toContain('pwd')
  expect(host.querySelector('.tool-detail-shell')?.textContent).toContain('已取消')

  app.unmount()
  host.remove()
})

it('等待时取消不会被晚到响应打开，再次点击使用已缓存详情', async () => {
  const request = pendingDetails()
  const bubble = mountBubble()
  bubble.click()
  bubble.click()
  await nextTick()
  expect(bubble.host.querySelector('button')?.getAttribute('aria-busy')).toBe('false')
  request.resolve({ toolResult: '缓存结果' })
  await settle()
  expect(bubble.changes).not.toHaveBeenCalled()
  expect(bubble.msg._toolDetailsLoaded).toBe(true)
  bubble.click()
  await nextTick()
  expect(bubble.expanded.value).toBe(true)
  expect(agentApi.getToolEventDetails).toHaveBeenCalledTimes(1)
})

it('等待中取消后重新请求展开复用同一个在途请求', async () => {
  const request = pendingDetails()
  const bubble = mountBubble()
  bubble.click(); bubble.click(); bubble.click()
  expect(agentApi.getToolEventDetails).toHaveBeenCalledTimes(1)
  request.resolve({ toolResult: '完成' })
  await settle()
  expect(bubble.changes.mock.calls).toEqual([[true]])
})

it('失败保持折叠，点击标题重试成功后才展开', async () => {
  const first = pendingDetails()
  const bubble = mountBubble()
  bubble.click()
  first.reject(new Error('合成网络错误'))
  await settle()
  expect(bubble.expanded.value).toBe(false)
  expect(bubble.host.textContent).toContain('chatUi.retryToolDetails')
  const second = pendingDetails()
  bubble.click()
  second.resolve({ toolResult: '重试结果' })
  await settle()
  expect(bubble.expanded.value).toBe(true)
  expect(agentApi.getToolEventDetails).toHaveBeenCalledTimes(2)
})

it('虚拟滚动卸载后不再请求展开，也不写入旧组件的详情状态', async () => {
  const request = pendingDetails()
  const bubble = mountBubble()
  bubble.click()
  mounted.pop()
  bubble.app.unmount(); bubble.host.remove()
  request.resolve({ toolResult: '晚到结果' })
  await settle()
  expect(bubble.changes).not.toHaveBeenCalled()
  expect(bubble.msg._toolDetailsLoaded).toBeUndefined()
})
