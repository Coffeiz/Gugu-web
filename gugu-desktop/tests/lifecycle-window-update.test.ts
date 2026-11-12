import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { DesktopLifecycle } from '../src/main/lifecycle.js'
import { DesktopUpdater } from '../src/main/updater.js'
import {
  windowOptions,
  trustedCaller,
  secureWindow,
  uiResourcePath,
} from '../src/main/windows.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('桌面生命周期、窗口与更新边界', () => {
  it('界面协议只能读取随包 UI，拒绝其他来源和编码后的目录穿越', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-ui-resources-')),
      ui = join(root, 'ui')
    mkdirSync(ui)
    writeFileSync(join(ui, 'desktop.html'), '合成界面')
    writeFileSync(join(root, 'private.txt'), '合成私有资料')
    try {
      expect(await uiResourcePath('gugu-desktop://app/desktop.html', ui)).toBe(
        join(ui, 'desktop.html'),
      )
      for (const address of [
        'https://example.invalid/desktop.html',
        'gugu-desktop://other/desktop.html',
        'gugu-desktop://app/%2e%2e%2fprivate.txt',
        'gugu-desktop://app/%5cprivate.txt',
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
    expect(contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({
      action: 'deny',
    })
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
