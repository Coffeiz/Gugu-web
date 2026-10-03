// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@/composables/core/useAppToast', () => ({ showAppError }))

afterEach(() => {
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand)
  else Reflect.deleteProperty(document, 'execCommand')
  document.body.replaceChildren()
  vi.useRealTimers()
})

import { useChatActions } from './useChatActions'

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
