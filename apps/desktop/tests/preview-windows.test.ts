import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  windows: [] as Array<{ options: unknown; loaded?: string; visible: boolean; focusCount: number; sender?: unknown }>,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly row = { options: {}, visible: false, focusCount: 0 } as typeof state.windows[number]
    readonly webContents = { send: vi.fn() }
    private readonly listeners = new Map<string, () => void>()
    private fullscreen = false
    private pinned = false
    destroyed = false
    constructor(options: unknown) {
      this.row.options = options
      this.row.sender = this.webContents
      state.windows.push(this.row)
    }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    isVisible() { return this.row.visible }
    restore() {}
    focus() { this.row.focusCount++ }
    once() {}
    on(event: string, listener: () => void) { this.listeners.set(event, listener) }
    isFullScreen() { return this.fullscreen }
    isAlwaysOnTop() { return this.pinned }
    setFullScreen(enabled: boolean) {
      this.fullscreen = enabled
      this.listeners.get(enabled ? 'enter-full-screen' : 'leave-full-screen')?.()
    }
    setAlwaysOnTop(enabled: boolean) {
      this.pinned = enabled
      this.listeners.get('always-on-top-changed')?.()
    }
    async loadURL(url: string) { this.row.loaded = url }
    show() { this.row.visible = true }
    destroy() { this.destroyed = true }
  },
  ipcMain: { handle(channel: string, handler: (...args: unknown[]) => unknown) { state.handlers.set(channel, handler) } },
  screen: {
    getCursorScreenPoint: () => ({ x: -500, y: 250 }),
    getDisplayNearestPoint: () => ({ workArea: { x: -900, y: 40, width: 900, height: 760 } }),
  },
}))

vi.mock('../src/main/windows.js', () => ({
  desktopWindowMaterial: () => ({}), secureWindow: () => {},
  trustedCaller: (event: { sender: unknown }, windows: Array<{ webContents: unknown }>) =>
    windows.some(window => window.webContents === event.sender),
  windowOptions: () => ({ webPreferences: {} }),
}))

import { registerPreviewWindows } from '../src/main/preview-windows.js'
import { previewWindowChannels } from '@gugu/desktop-contracts'

beforeEach(() => { state.windows.length = 0; state.handlers.clear() })

it('Agent 可复用现有预览窗口并在重复调用时聚焦同一文件', async () => {
  const reference = vi.fn(async () => null)
  const preview = registerPreviewWindows({ mainWindow: () => undefined, uiUrl: 'gugu-desktop://app/desktop.html',
    preload: '/synthetic/preload.cjs', trustsProject: () => false, reference, reveal: async () => {} })
  const file = { workspaceFile: { directoryId: 'personal' as const, relativePath: '资料/预览.png', identity: '1.2.3' },
    displayName: '预览.png', ext: 'png', mimeType: 'image/png', sizeBytes: 8 }

  await expect(preview.open(file)).resolves.toBeNull()
  expect(reference).toHaveBeenCalledWith({ action: 'reference', directoryId: 'personal', path: '资料/预览.png' })
  expect(state.windows).toHaveLength(1)
  expect(state.windows[0]?.loaded).toBe('gugu-desktop://app/desktop.html?filePreview=1')
  expect(state.windows[0]?.visible).toBe(true)

  await expect(preview.open(file)).resolves.toBeNull()
  expect(state.windows).toHaveLength(1)
  expect(state.windows[0]?.focusCount).toBe(1)
})

it('在当前屏幕上按文档类型打开竖版和横版窗口，并保持窗口完全可见', async () => {
  const preview = registerPreviewWindows({ mainWindow: () => undefined, uiUrl: 'gugu-desktop://app/desktop.html',
    preload: '/synthetic/preload.cjs', trustsProject: () => false, reference: async () => null, reveal: async () => {} })
  await preview.open({ workspaceFile: { directoryId: 'personal', relativePath: '说明.md' },
    displayName: '说明', ext: 'md' })
  await preview.openExternal({ displayName: '数据', ext: 'xlsx' }, async () => new Response(null), async () => {})
  await preview.openExternal({ displayName: '幻灯片', ext: 'pptx' }, async () => new Response(null), async () => {})
  expect(state.windows.map(({ options }) => options)).toEqual([
    expect.objectContaining({ width: 608, height: 760, x: -754, y: 40 }),
    expect.objectContaining({ width: 900, height: 550, x: -900, y: 145 }),
    expect.objectContaining({ width: 900, height: 558, x: -900, y: 141 }),
  ])
})

it('仅预览窗口可切换自己的全屏和置顶状态，并收到系统状态更新', async () => {
  const preview = registerPreviewWindows({ mainWindow: () => undefined, uiUrl: 'gugu-desktop://app/desktop.html',
    preload: '/synthetic/preload.cjs', trustsProject: () => false, reference: async () => null, reveal: async () => {} })
  for (const displayName of ['说明', '另一份说明']) {
    await preview.openExternal({ displayName, ext: 'md' }, async () => new Response(null), async () => {})
  }
  const control = state.handlers.get(previewWindowChannels.state)!
  const sender = state.windows[0]!.sender as { send: ReturnType<typeof vi.fn> }
  const event = { sender }
  await expect(control({ sender: {} }, 'pin', true)).resolves.toMatchObject({ ok: false })
  await expect(control(event, 'invalid', true)).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  await expect(control(event, 'fullscreen', true)).resolves.toEqual({ ok: true, result: { fullscreen: true, pinned: false } })
  await expect(control(event, 'pin', true)).resolves.toEqual({ ok: true, result: { fullscreen: true, pinned: true } })
  await expect(control(event, 'fullscreen', false)).resolves.toEqual({ ok: true, result: { fullscreen: false, pinned: true } })
  await expect(control(event, 'pin', false)).resolves.toEqual({ ok: true, result: { fullscreen: false, pinned: false } })
  expect(sender.send.mock.calls).toEqual([
    [previewWindowChannels.stateChanged, { fullscreen: true, pinned: false }],
    [previewWindowChannels.stateChanged, { fullscreen: true, pinned: true }],
    [previewWindowChannels.stateChanged, { fullscreen: false, pinned: true }],
    [previewWindowChannels.stateChanged, { fullscreen: false, pinned: false }],
  ])
  await expect(control({ sender: state.windows[1]!.sender }, 'read')).resolves.toEqual({
    ok: true, result: { fullscreen: false, pinned: false },
  })
})

it('预览窗口只能在文件管理器中定位自身绑定的文件', async () => {
  const revealWorkspace = vi.fn(async () => {})
  const revealExternal = vi.fn(async () => {})
  const preview = registerPreviewWindows({ mainWindow: () => undefined, uiUrl: 'gugu-desktop://app/desktop.html',
    preload: '/synthetic/preload.cjs', trustsProject: () => false, reference: async () => null, reveal: revealWorkspace })
  const target = { directoryId: 'personal' as const, relativePath: '资料/说明.md', identity: '1.2.3' }
  await preview.open({ workspaceFile: target, displayName: '说明', ext: 'md' })
  await preview.openExternal({ displayName: '库外资料', ext: 'md' }, async () => new Response(null), revealExternal)
  const reveal = state.handlers.get(previewWindowChannels.reveal)!
  await expect(reveal({ sender: {} })).resolves.toMatchObject({ ok: false })
  await expect(reveal({ sender: state.windows[0]!.sender }, '另一个文件')).resolves.toEqual({ ok: true, result: null })
  expect(revealWorkspace).toHaveBeenCalledExactlyOnceWith(target)
  expect(revealExternal).not.toHaveBeenCalled()
  await expect(reveal({ sender: state.windows[1]!.sender })).resolves.toEqual({ ok: true, result: null })
  expect(revealExternal).toHaveBeenCalledOnce()
})
