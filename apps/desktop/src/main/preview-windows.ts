import { randomUUID } from 'node:crypto'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { desktopPreviewBounds, previewWindowChannels as channels, type DesktopPreviewFile, type DesktopPreviewMetadata, type DesktopPreviewWindowFile } from '../shared/preview-window.js'
import { DesktopError, desktopReply } from './core-host.js'
import { desktopWindowMaterial, secureWindow, trustedCaller, windowOptions } from './windows.js'

export function registerPreviewWindows(options: {
  mainWindow: () => BrowserWindow | undefined
  uiUrl: string
  preload: string
  trustsProject: (event: IpcMainInvokeEvent, channel: string, argument: unknown) => boolean
  reference: (request: unknown) => Promise<unknown>
  reveal: (target: DesktopPreviewFile['workspaceFile']) => Promise<unknown>
}) {
  const url = new URL(options.uiUrl)
  url.searchParams.set('filePreview', '1')
  const windows = new Map<string, { window: BrowserWindow; file: DesktopPreviewWindowFile; reveal: () => Promise<unknown> }>()
  const externalContent = new Map<string, (range: string | null) => Promise<Response>>()
  const find = (event: IpcMainInvokeEvent) =>
    [...windows.values()].find(({ window }) => trustedCaller(event, [window], url.href))
  const readState = (window: BrowserWindow) => ({
    fullscreen: window.isFullScreen(), pinned: window.isAlwaysOnTop(),
  })

  async function open(file: DesktopPreviewFile | undefined) {
    const target = file?.workspaceFile
    const command = { action: 'reference', directoryId: target?.directoryId, path: target?.relativePath }
    if (!file || !target || typeof target.directoryId !== 'string' || typeof target.relativePath !== 'string'
      || typeof file.displayName !== 'string' || typeof file.ext !== 'string'
      || (file.mimeType != null && typeof file.mimeType !== 'string')
      || (file.sizeBytes !== undefined && (typeof file.sizeBytes !== 'number' || !Number.isFinite(file.sizeBytes)))
      || (target.identity !== undefined && typeof target.identity !== 'string'))
      throw new DesktopError('invalid_request', '预览文件无效')
    await options.reference(command)
    return openWindow(JSON.stringify([target.directoryId, target.relativePath, target.identity ?? null]), file, () => options.reveal(target))
  }

  async function openWindow(key: string, file: DesktopPreviewWindowFile, reveal: () => Promise<unknown>, onClose?: () => void) {
    const existing = windows.get(key)?.window
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      if (existing.isVisible()) existing.focus()
      return null
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const window = new BrowserWindow({
      ...desktopWindowMaterial(),
      ...desktopPreviewBounds(file, area),
      title: '咕咕 · 文件预览',
      frame: false,
      show: false,
      webPreferences: windowOptions(options.preload).webPreferences,
    })
    secureWindow(window)
    const publishState = () => {
      if (!window.isDestroyed()) window.webContents.send(channels.stateChanged, readState(window))
    }
    window.on('enter-full-screen', publishState)
    window.on('leave-full-screen', publishState)
    window.on('always-on-top-changed', publishState)
    windows.set(key, { window, file, reveal })
    window.once('closed', () => { windows.delete(key); onClose?.() })
    try {
      await window.loadURL(url.href)
      window.show()
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
    return null
  }

  ipcMain.handle(channels.open, (event, file: DesktopPreviewFile | undefined) => {
    const target = file?.workspaceFile
    const command = { action: 'reference', directoryId: target?.directoryId, path: target?.relativePath }
    const main = options.mainWindow()
    const trusted = (main && trustedCaller(event, [main], options.uiUrl))
      || options.trustsProject(event, DESKTOP_CHANNELS.files, command)
    return desktopReply(trusted === true, () => open(file))
  })

  ipcMain.handle(channels.read, event => {
    const entry = find(event)
    return desktopReply(!!entry, async () => entry!.file)
  })
  ipcMain.handle(channels.state, (event, action: unknown, enabled: unknown) => {
    const entry = find(event)
    return desktopReply(!!entry, async () => {
      const window = entry!.window
      if (action === 'read' && enabled === undefined) return readState(window)
      if (typeof enabled !== 'boolean') throw new DesktopError('invalid_request', '预览窗口操作无效')
      if (action === 'fullscreen') window.setFullScreen(enabled)
      else if (action === 'pin') window.setAlwaysOnTop(enabled)
      else throw new DesktopError('invalid_request', '预览窗口操作无效')
      return readState(window)
    })
  })
  ipcMain.handle(channels.close, event => {
    const entry = find(event)
    return desktopReply(!!entry, async () => {
      if (entry) setImmediate(() => { if (!entry.window.isDestroyed()) entry.window.close() })
      return null
    })
  })
  ipcMain.handle(channels.reveal, event => {
    const entry = find(event)
    return desktopReply(!!entry, async () => { await entry!.reveal(); return null })
  })

  return {
    open,
    async openExternal(file: DesktopPreviewMetadata, content: (range: string | null) => Promise<Response>, reveal: () => Promise<void>) {
      const token = randomUUID()
      externalContent.set(token, content)
      try {
        await openWindow(token, { ...file, contentUrl: `gugu-desktop://app/__local-files/preview/${token}` }, reveal,
          () => externalContent.delete(token))
      } catch (error) {
        externalContent.delete(token)
        throw error
      }
    },
    content(token: string, range: string | null) {
      return externalContent.get(token)?.(range) ?? Promise.resolve(new Response(null, { status: 404 }))
    },
    trusts(event: IpcMainInvokeEvent, channel: string, argument: unknown) {
      if (channel !== DESKTOP_CHANNELS.files || !argument || typeof argument !== 'object') return false
      const file = find(event)?.file
      const target = file && 'workspaceFile' in file ? file.workspaceFile : undefined
      if (!target) return false
      const command = argument as Record<string, unknown>
      return command.directoryId === target.directoryId && command.path === target.relativePath
        && (command.action === 'download' || command.action === 'open' || command.action === 'upload')
    },
  }
}
