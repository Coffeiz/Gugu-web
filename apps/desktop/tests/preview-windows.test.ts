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

it('聊天附件由主窗口打开独立预览，重复打开聚焦，内容令牌支持 Range', async () => {
  const sender = {}
  const attachmentId = 'a'.repeat(32)
  const readAttachment = vi.fn(async () => ({
    displayName: '聊天图片', ext: 'png', mime: 'image/png', data: Uint8Array.of(1, 2, 3),
  }))
  const preview = registerPreviewWindows({
    mainWindow: () => ({ webContents: sender }) as never,
    uiUrl: 'gugu-desktop://app/desktop.html', preload: '/synthetic/preload.cjs',
    trustsProject: async () => true, reference: async () => null, reveal: async () => {}, readAttachment,
  })
  const open = state.handlers.get(previewWindowChannels.open)!
  const read = state.handlers.get(previewWindowChannels.read)!
  const reveal = state.handlers.get(previewWindowChannels.reveal)!
  await expect(open({ sender: {} }, { attachmentId })).resolves.toMatchObject({ ok: false })
  await expect(open({ sender }, { attachmentId: '../文件' })).resolves.toMatchObject({ ok: false })
  expect(readAttachment).not.toHaveBeenCalled()

  await expect(open({ sender }, { attachmentId })).resolves.toMatchObject({ ok: true })
  expect(state.windows[0]?.loaded).toContain('filePreview=1')
  expect(readAttachment).toHaveBeenCalledExactlyOnceWith(attachmentId)
  const event = { sender: state.windows[0]!.sender }
  const reply = await read(event) as { result: { contentUrl: string; canReveal: boolean } }
  expect(reply.result.canReveal).toBe(false)
  await expect(reveal(event)).resolves.toMatchObject({ ok: false })
  const token = new URL(reply.result.contentUrl).pathname.split('/').at(-1)!
  const content = await preview.content(token, 'bytes=1-2')
  expect(content.status).toBe(206)
  expect(content.headers.get('Content-Range')).toBe('bytes 1-2/3')
  expect(Array.from(new Uint8Array(await content.arrayBuffer()))).toEqual([2, 3])

  await expect(open({ sender }, { attachmentId })).resolves.toMatchObject({ ok: true })
  expect(readAttachment).toHaveBeenCalledTimes(1)
  expect(state.windows).toHaveLength(1)
  expect(state.windows[0]?.focusCount).toBe(1)
})

it('聊天里的文件库路径解析到与文件库相同的独立预览窗口', async () => {
  const sender = {}
  const file = { workspaceFile: { directoryId: 'personal' as const, relativePath: '说明.md' }, displayName: '说明', ext: 'md' }
  const resolveLibraryPath = vi.fn(async () => ({ preview: file }))
  const preview = registerPreviewWindows({
    mainWindow: () => ({ webContents: sender }) as never,
    uiUrl: 'gugu-desktop://app/desktop.html', preload: '/synthetic/preload.cjs',
    trustsProject: async () => false, reference: async () => null, reveal: async () => {}, resolveLibraryPath,
  })
  const open = state.handlers.get(previewWindowChannels.open)!
  await expect(open({ sender }, { libraryPath: '/外部目录/说明.md' })).resolves.toMatchObject({ ok: false })
  expect(resolveLibraryPath).not.toHaveBeenCalled()
  await expect(open({ sender }, { libraryPath: '/personal/说明.md' })).resolves.toMatchObject({ ok: true })
  expect(resolveLibraryPath).toHaveBeenCalledExactlyOnceWith('/personal/说明.md')
  await preview.open(file)
  expect(state.windows).toHaveLength(1)
  expect(state.windows[0]?.focusCount).toBe(1)
})
