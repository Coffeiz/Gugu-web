import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { applicationMenuChannels } from '@gugu/desktop-contracts'
import { nativeEditingChannel, type EditingFocus } from '../src/keyboard-editing.js'
import { DesktopLifecycle } from '../src/main/lifecycle.js'
import { DesktopUpdater } from '../src/main/updater/index.js'
import {
  createMainWindowSizeStore,
  createProjectWindowBoundsStore,
  fitProjectWindowBounds,
  dispatchWindowEdit,
  windowOptions,
  trustedCaller,
  secureWindow,
  uiResourcePath,
} from '../src/main/windows.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('桌面生命周期、窗口与更新边界', () => {
  it('项目窗口重开保留普通尺寸和负坐标，断开外接屏后移回可见区域', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gugu-project-bounds-'))
    try {
      const bounds = { x: -1050, y: 130, width: 1000, height: 700 }
      const minimum = { width: 800, height: 600 }
      createProjectWindowBoundsStore(directory).save(bounds)
      const restored = createProjectWindowBoundsStore(directory).read()!
      expect(restored).toEqual(bounds)
      expect(fitProjectWindowBounds(restored, { x: -1440, y: 24, width: 1440, height: 876 }, minimum))
        .toEqual(bounds)
      expect(fitProjectWindowBounds(restored, { x: 0, y: 24, width: 900, height: 650 }, minimum))
        .toEqual({ x: 0, y: 24, width: 900, height: 650 })
      writeFileSync(join(directory, 'project-window-bounds.json'), '{"x":0,"width":900,"height":650}')
      expect(createProjectWindowBoundsStore(directory).read()).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('重新打开主窗口时恢复最近保存的普通尺寸，并适应较小屏幕', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gugu-window-size-'))
    try {
      const store = createMainWindowSizeStore(directory)
      expect(store.read()).toBeUndefined()
      store.save({ width: 1300, height: 780 })
      store.save({ width: 1200, height: 740 })
      const size = createMainWindowSizeStore(directory).read()!
      expect(windowOptions('preload.cjs', false, { size, workArea: { width: 1600, height: 900 } }))
        .toMatchObject({ width: 1200, height: 740 })
      expect(windowOptions('preload.cjs', false, { size, workArea: { width: 1080, height: 700 } }))
        .toMatchObject({ width: 1080, height: 700 })
      writeFileSync(join(directory, 'main-window-size.json'), '{')
      const invalid = createMainWindowSizeStore(directory).read()
      expect(invalid).toBeUndefined()
      expect(windowOptions('preload.cjs')).toMatchObject({ width: 1440, height: 800 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('界面协议只能读取随包 UI，拒绝其他来源和编码后的目录穿越', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-ui-resources-')),
      ui = join(root, 'ui')
    mkdirSync(ui)
    writeFileSync(join(ui, 'desktop.html'), '合成界面')
    writeFileSync(join(root, 'private.txt'), '合成私有资料')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'private.txt'), '合成私有资料')
    symlinkSync(
      outside,
      join(ui, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    try {
      expect(await uiResourcePath('gugu-desktop://app/desktop.html', ui)).toBe(
        await realpath(join(ui, 'desktop.html')),
      )
      for (const address of [
        'https://example.invalid/desktop.html',
        'gugu-desktop://other/desktop.html',
        'gugu-desktop://app/%2e%2e%2fprivate.txt',
        'gugu-desktop://app/%5cprivate.txt',
        'gugu-desktop://app/link/private.txt',
      ])
        await expect(uiResourcePath(address, ui)).rejects.toThrow()
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
    }
  })
  it('并发启动共用一次装配，暂停立即拒绝请求，恢复后仍共用一个 Core', async () => {
    const host = {
      request: vi.fn(async () => ['合成持久结果']),
      close: vi.fn(async () => undefined),
    }
    const factory = vi.fn(async () => host)
    const lifecycle = new DesktopLifecycle(factory as never)
    await Promise.all([lifecycle.start(), lifecycle.start()])
    expect(factory).toHaveBeenCalledTimes(1)
    expect(await lifecycle.request('projects.list')).toEqual(['合成持久结果'])
    const closing = lifecycle.pause()
    await expect(
      lifecycle.request('projects.create', { name: '暂停后写入' }),
    ).rejects.toMatchObject({ code: 'closed' })
    await closing
    await lifecycle.start()
    expect(factory).toHaveBeenCalledTimes(2)
    await Promise.all([lifecycle.close(), lifecycle.close()])
    expect(host.close).toHaveBeenCalledTimes(2)
    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'closed' })
  })
  it('开发重载等待执行中的任务，且重新检查空闲探测期间入队的请求', async () => {
    let releaseCheck!: (idle: boolean) => void
    const host = {
      request: vi.fn(async (method: string) => method === 'core.devReloadIdle'),
      close: vi.fn(async () => undefined),
    }
    host.request.mockImplementationOnce(() => new Promise(resolve => { releaseCheck = resolve }))
    host.request.mockImplementationOnce(async () => true)
    host.request.mockImplementationOnce(async () => false)
    const lifecycle = new DesktopLifecycle(async () => host as never)
    await lifecycle.start()

    const reload = lifecycle.whenIdle(() => lifecycle.pause())
    await expect(lifecycle.request('agent.sessions.runModel')).resolves.toBe(true)
    releaseCheck(true)

    await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(3))
    expect(host.close).not.toHaveBeenCalled()
    await reload
    expect(host.close).toHaveBeenCalledOnce()
  })

  it('关闭发生在启动期间仍回收晚到的 Host，不能重新进入运行态', async () => {
    let ready!: (value: { close(): Promise<void>; request(): Promise<unknown> }) => void
    const host = {
      close: vi.fn(async () => undefined),
      request: vi.fn(async () => null),
    }
    const lifecycle = new DesktopLifecycle(
      () =>
        new Promise((resolve) => {
          ready = resolve
        }) as never,
    )
    const opening = lifecycle.start(),
      closing = lifecycle.close()
    ready(host)
    await opening
    await closing
    expect(host.close).toHaveBeenCalledTimes(1)
    await expect(lifecycle.request('projects.list')).rejects.toMatchObject({
      code: 'closed',
    })
  })
  it('窗口启用隔离，来源必须同时匹配已登记窗口、主 frame 和本地页面', () => {
    const frame = { url: 'file:///synthetic/ui/desktop.html' },
      sender = { mainFrame: frame }
    const window = {
      isDestroyed: () => false,
      webContents: sender,
    } as unknown as BrowserWindow
    const event = {
      sender,
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent
    expect(windowOptions('preload.cjs').webPreferences).toMatchObject({
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
    })
    expect(trustedCaller(event, [window], frame.url)).toBe(true)
    expect(
      trustedCaller(
        { ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent,
        [window],
        frame.url,
      ),
    ).toBe(false)
    expect(trustedCaller(event, [window], 'https://example.invalid/')).toBe(false)
    expect(
      trustedCaller({ ...event, sender: {} } as IpcMainInvokeEvent, [window], frame.url),
    ).toBe(false)
    const hooks = new Map<string, (...args: unknown[]) => unknown>(),
      requests: ((...args: unknown[]) => unknown)[] = []
    const contents = {
      on: (name: string, handler: (...args: unknown[]) => unknown) =>
        hooks.set(name, handler),
      setWindowOpenHandler: vi.fn(),
      ipc: { on: vi.fn() },
      session: {
        on: (name: string, handler: (...args: unknown[]) => unknown) =>
          hooks.set(name, handler),
        setPermissionRequestHandler: (handler: (...args: unknown[]) => unknown) =>
          requests.push(handler),
        setPermissionCheckHandler: vi.fn(),
      },
    }
    secureWindow({ webContents: contents } as unknown as BrowserWindow)
    const preventDefault = vi.fn()
    hooks.get('will-navigate')!({ preventDefault })
    hooks.get('will-download')!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
    const permission = vi.fn()
    requests[0]!(null, 'camera', permission)
    expect(permission).toHaveBeenCalledWith(false)
    expect(contents.setWindowOpenHandler.mock.calls[0]![0]({ url: 'https://example.test/' })).toEqual({
      action: 'deny',
    })
    const openExternal = vi.fn()
    secureWindow({ webContents: contents } as unknown as BrowserWindow, openExternal)
    const open = contents.setWindowOpenHandler.mock.calls[1]![0]
    const webLink = 'https://example.test/docs?q=chat#link'
    expect(open({ url: webLink })).toEqual({ action: 'deny' })
    expect(open({ url: 'http://example.test/' })).toEqual({ action: 'deny' })
    for (const url of ['file:///tmp/synthetic', 'gugu://action', 'javascript:alert(1)', 'https://user:password@example.test/', '无效地址']) {
      expect(open({ url })).toEqual({ action: 'deny' })
    }
    expect(open({ url: webLink, postBody: {} })).toEqual({ action: 'deny' })
    expect(openExternal.mock.calls).toEqual([[webLink], ['http://example.test/']])
  })
  it('共享会话只允许已登记主窗口的麦克风，并保留系统授权', async () => {
    const session = { on: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    const uiUrl = 'gugu-desktop://app/desktop.html'
    function makeWindow(url: string) {
      const contents = { session, getURL: vi.fn(() => url), isDestroyed: () => false,
        on: vi.fn(), setWindowOpenHandler: vi.fn(), ipc: { on: vi.fn() } }
      return { contents, window: { webContents: contents } as unknown as BrowserWindow }
    }
    const main = makeWindow(uiUrl)
    const preview = makeWindow(uiUrl)
    const isGranted = vi.fn(() => false)
    const request = vi.fn(async () => true)
    secureWindow(main.window, undefined, { uiUrl, isGranted, request })
    secureWindow(preview.window)
    const check = session.setPermissionCheckHandler.mock.lastCall![0]
    const ask = session.setPermissionRequestHandler.mock.lastCall![0]
    const frame = { requestingUrl: uiUrl, isMainFrame: true }
    const origin = 'gugu-desktop://app'
    expect(check(main.contents, 'media', origin, { ...frame, mediaType: 'audio' })).toBe(false)
    const reply = vi.fn()
    ask(main.contents, 'media', reply, { ...frame, mediaTypes: ['audio'] })
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(true))
    expect(request).toHaveBeenCalledTimes(1)
    isGranted.mockReturnValue(true)
    expect(check(main.contents, 'media', origin, { ...frame, mediaType: 'audio' })).toBe(true)
    expect(check(main.contents, 'media', 'https://example.invalid', { ...frame, mediaType: 'audio' })).toBe(false)
    for (const [contents, permission, details] of [
      [preview.contents, 'media', { ...frame, mediaTypes: ['audio'] }],
      [main.contents, 'media', { ...frame, isMainFrame: false, mediaTypes: ['audio'] }],
      [main.contents, 'media', { ...frame, mediaTypes: ['audio', 'video'] }],
      [main.contents, 'display-capture', { ...frame, mediaTypes: ['audio'] }],
      [main.contents, 'media', { ...frame, requestingUrl: 'https://example.invalid/', mediaTypes: ['audio'] }],
    ] as const) {
      const denied = vi.fn()
      ask(contents, permission, denied, details)
      expect(denied).toHaveBeenCalledWith(false)
    }
    request.mockResolvedValue(false)
    const systemDenied = vi.fn()
    ask(main.contents, 'media', systemDenied, { ...frame, mediaTypes: ['audio'] })
    await vi.waitFor(() => expect(systemDenied).toHaveBeenCalledWith(false))
  })
  it('编辑菜单随当前窗口的文本焦点切换，子 frame 不能改变路由', () => {
    const listeners = new Map<string, (event: { senderFrame: object }, focus: EditingFocus) => void>()
    const mainFrame = {}
    const contents = {
      mainFrame, isDestroyed: () => false,
      on: vi.fn(), send: vi.fn(), copy: vi.fn(),
      ipc: { on: (name: string, listener: (event: { senderFrame: object }, focus: EditingFocus) => void) => {
        listeners.set(name, listener)
      } },
      setWindowOpenHandler: vi.fn(),
      session: { on: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
    }
    const window = { webContents: contents } as unknown as BrowserWindow
    secureWindow(window)
    const selectText = listeners.get(nativeEditingChannel)!
    selectText({ senderFrame: {} }, 'native')
    dispatchWindowEdit(window.webContents, 'copy')
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(applicationMenuChannels.edit, 'copy')
    expect(contents.copy).not.toHaveBeenCalled()

    selectText({ senderFrame: mainFrame }, 'native')
    dispatchWindowEdit(window.webContents, 'copy')
    expect(contents.copy).toHaveBeenCalledOnce()
    expect(contents.send).toHaveBeenCalledOnce()

    selectText({ senderFrame: mainFrame }, 'editor')
    dispatchWindowEdit(window.webContents, 'undo')
    expect(contents.send).toHaveBeenLastCalledWith(applicationMenuChannels.edit, 'undo')
    dispatchWindowEdit(window.webContents, 'copy')
    expect(contents.copy).toHaveBeenCalledTimes(2)
  })

  it('未确认或未校验的更新不安装，确认后先停写再交给安装器', async () => {
    const events: string[] = [],
      backend = {
        check: vi.fn(async () => '0.3.0'),
        download: vi.fn(async () => {
          events.push('verified')
        }),
        install: vi.fn(() => {
          events.push('install')
        }),
      }
    const updater = new DesktopUpdater(backend, async () => {
      events.push('stopped')
    })
    await expect(updater.install(true)).rejects.toMatchObject({
      code: 'update_unavailable',
    })
    await Promise.all([updater.check(), updater.check()])
    expect(backend.check).toHaveBeenCalledTimes(1)
    await updater.download()
    await expect(updater.install(false)).rejects.toMatchObject({
      code: 'update_unavailable',
    })
    expect(events).toEqual(['verified'])
    await updater.install(true)
    expect(events).toEqual(['verified', 'stopped', 'install'])
  })
  it('下载或停写失败保持当前制品，原始异常不暴露；验证版无更新通道', async () => {
    const install = vi.fn(),
      updater = new DesktopUpdater(
        {
          check: async () => '0.3.0',
          download: async () => {
            throw new Error('合成私有凭据')
          },
          install,
        },
        async () => undefined,
      )
    await updater.check()
    await expect(updater.download()).rejects.toThrow('更新下载或校验失败')
    await expect(updater.install(true)).rejects.toMatchObject({
      code: 'update_unavailable',
    })
    expect(install).not.toHaveBeenCalled()
    const stopped = new DesktopUpdater(
      { check: async () => '0.3.0', download: async () => undefined, install },
      async () => {
        throw new Error('合成停写失败')
      },
    )
    await stopped.check()
    await stopped.download()
    await expect(stopped.install(true)).rejects.toMatchObject({
      code: 'update_failed',
    })
    expect(install).not.toHaveBeenCalled()
    const disabled = new DesktopUpdater(null, async () => undefined)
    expect(disabled.status().state).toBe('disabled')
    await expect(disabled.check()).rejects.toMatchObject({
      code: 'update_unavailable',
    })
  })
})
