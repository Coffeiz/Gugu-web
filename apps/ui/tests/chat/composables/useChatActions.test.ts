// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { i18n } from '@/i18n'
import GuguChatMessageRow from '@/components/common/gugu-chat/GuguChatMessageRow.vue'

const fetchProjects = vi.fn()
const fetchUpcomingCalEvents = vi.fn()
const bump = vi.fn()
const { showAppError } = vi.hoisted(() => ({ showAppError: vi.fn() }))
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

vi.mock('@/stores/projects', () => ({
  useProjectStore: () => ({ fetchProjects, fetchUpcomingCalEvents }),
}))
vi.mock('@/stores/live', () => ({
  useLiveStore: () => ({ bump }),
}))
vi.mock('@/stores/ui', () => ({
  useUiStore: () => ({ pendingFileTarget: null }),
}))
vi.mock('@/stores/preview', () => ({
  usePreviewStore: () => ({ open: vi.fn() }),
  isPreviewable: () => false,
}))
vi.mock('@/stores/filesCache', () => ({
  useFilesCacheStore: () => ({ loaded: true, allFiles: [], load: vi.fn() }),
}))
vi.mock('@/composables/mind/useMindRefActions', () => ({ useMindRefActions: () => ({ openMindRef: vi.fn() }) }))
vi.mock('@/composables/core/useAppToast', () => ({ showAppError }))

afterEach(() => {
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand)
  else Reflect.deleteProperty(document, 'execCommand')
  document.body.replaceChildren()
  vi.useRealTimers()
})

import { useChatActions } from '@/components/common/gugu-chat/composables/useChatActions'

it('链接按钮点击走应用内项目和画布导航，外站链接保留浏览器默认行为', () => {
  const push = vi.fn()
  const onOpenObject = vi.fn()
  const { onChatActionClick } = useChatActions({
    router: { push } as never, onOpenObject, onBindPlatform: vi.fn(), onOpenSkill: vi.fn(),
  })
  const buttons = [
    { id: 'project', label: '示例项目', url: 'GUGU://open-object/project/21' },
    { id: 'canvas', label: '示例画布节点', url: 'gugu://focus-canvas/2/3' },
    { id: 'external', label: '外部网站', url: 'https://example.test/' },
  ]
  const host = document.createElement('div')
  const app = createApp(GuguChatMessageRow, {
    msg: { id: 1, role: 'ai', text: '', time: '', linkButtons: { message: '入口', buttons } },
    sessionId: 1, isGroupSession: false, interactionAnswerMode: 'composer',
    copiedId: null, voicePlayingId: null, voiceBars: [], onActionClick: onChatActionClick,
  }).use(i18n)
  app.mount(host)
  try {
    const click = (label: string) => {
      const anchor = host.querySelector<HTMLAnchorElement>(`a[aria-label="${label}"]`)!
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      anchor.firstElementChild!.dispatchEvent(event)
      return { prevented: event.defaultPrevented, target: anchor.target }
    }
    expect(click('示例项目')).toEqual({ prevented: true, target: '' })
    expect(onOpenObject).toHaveBeenCalledExactlyOnceWith('project', 21)
    expect(click('示例画布节点')).toEqual({ prevented: true, target: '' })
    expect(push).toHaveBeenCalledExactlyOnceWith('/canvases')
    expect(click('外部网站')).toEqual({ prevented: false, target: '_blank' })
  } finally {
    app.unmount()
  }
})

it('群聊图片附件使用新版卡片，打开与下载分别触发', () => {
  const file = { attach_id: 'synthetic', name: '示例长文件名.jpg', ext: 'jpg', size_bytes: 1024, _thumbUrl: '/thumbnail.jpg' }
  const onOpenFile = vi.fn(), onDownload = vi.fn()
  const host = document.createElement('div')
  const app = createApp(GuguChatMessageRow, {
    msg: { id: 1, role: 'member', text: '', time: '', files: [file] },
    sessionId: 1, isGroupSession: true, interactionAnswerMode: 'composer',
    copiedId: null, voicePlayingId: null, voiceBars: [], onOpenFile, onDownload,
  }).use(i18n)
  app.mount(host)
  try {
    const card = host.querySelector<HTMLButtonElement>('button.chat-object-card')!
    expect(card.textContent).toContain(file.name)
    expect(card.textContent).not.toContain('.jpg.jpg')
    expect(card.querySelector('img')?.getAttribute('src')).toBe('/thumbnail.jpg')
    card.click()
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(file)
    expect(onDownload).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>('button.chat-file-card-download')!.click()
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(file)
    expect(onOpenFile).toHaveBeenCalledTimes(1)
  } finally {
    app.unmount()
  }
})

describe('useChatActions 工具完成后的资源刷新', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('咕咕编辑定时任务后 bump scheduled_tasks，当前面板无需手动刷新', async () => {
    const { refreshAfterTools } = useChatActions({
      router: { push: vi.fn() } as never,
      onBindPlatform: vi.fn(),
      onOpenObject: vi.fn(),
      onOpenSkill: vi.fn(),
    })

    await refreshAfterTools(new Set(['update_scheduled_task']))

    expect(bump).toHaveBeenCalledWith('scheduled_tasks')
    expect(fetchProjects).not.toHaveBeenCalled()
    expect(fetchUpcomingCalEvents).not.toHaveBeenCalled()
  })

  it('咕咕创建技能或 MCP 后通知对应管理页重新加载', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    const { refreshAfterTools } = useChatActions({
      router: { push: vi.fn() } as never,
      onBindPlatform: vi.fn(),
      onOpenObject: vi.fn(),
      onOpenSkill: vi.fn(),
    })

    await refreshAfterTools(new Set(['create_skill', 'manage_mcp_servers']))

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'gugu:skills-changed' }))
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'gugu:mcp-changed' }))
  })

  it('代码块回退复制失败时不显示成功并提示用户', async () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    const button = document.createElement('button')
    button.className = 'md-copy-btn'
    button.textContent = '复制'
    const code = document.createElement('code')
    code.textContent = '示例代码'
    const block = document.createElement('div')
    block.className = 'md-code-block'
    block.append(button, code)
    document.body.append(block)

    const { onChatActionClick } = useChatActions({
      router: { push: vi.fn() } as never,
      onBindPlatform: vi.fn(),
      onOpenObject: vi.fn(),
      onOpenSkill: vi.fn(),
    })
    const preventDefault = vi.fn()
    await onChatActionClick({ target: button, preventDefault } as unknown as MouseEvent)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(button.textContent).toBe('复制')
    expect(showAppError).toHaveBeenCalledOnce()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('代码块回退复制成功后才显示成功状态', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
    const button = document.createElement('button')
    button.className = 'md-copy-btn'
    button.textContent = '复制'
    const code = document.createElement('code')
    code.textContent = '示例代码'
    const block = document.createElement('div')
    block.className = 'md-code-block'
    block.append(button, code)
    document.body.append(block)

    const { onChatActionClick } = useChatActions({
      router: { push: vi.fn() } as never,
      onBindPlatform: vi.fn(),
      onOpenObject: vi.fn(),
      onOpenSkill: vi.fn(),
    })
    await onChatActionClick({ target: button, preventDefault: vi.fn() } as unknown as MouseEvent)

    expect(button.textContent).toContain('✓')
    expect(showAppError).not.toHaveBeenCalled()
  })
})
