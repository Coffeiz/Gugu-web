import { randomUUID } from 'node:crypto'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { desktopPreviewBounds } from './preview-window-bounds.js'
import { previewWindowChannels as channels, type DesktopPreviewFile, type DesktopPreviewMetadata, type DesktopPreviewRequest, type DesktopPreviewWindowFile } from '@gugu/desktop-contracts'
import { DesktopError, desktopReply } from './core-host.js'
import { desktopWindowMaterial, secureWindow, trustedCaller, windowOptions } from './windows.js'

export function registerPreviewWindows(options: {
  mainWindow: () => BrowserWindow | undefined
  uiUrl: string
  preload: string
  trustsProject: (event: IpcMainInvokeEvent, channel: string, argument: unknown) => Promise<boolean>
  reference: (request: unknown) => Promise<unknown>
  resolveLibraryPath?: (path: string) => Promise<{ preview: DesktopPreviewFile } | { error: string }>
  readAttachment?: (id: string) => Promise<{ displayName: string; ext: string; mime: string; data: Uint8Array }>
  reveal: (target: DesktopPreviewFile['workspaceFile']) => Promise<unknown>
}) {
  const url = new URL(options.uiUrl)
  url.searchParams.set('filePreview', '1')
  const windows = new Map<string, { window: BrowserWindow; file: DesktopPreviewWindowFile; reveal?: () => Promise<unknown> }>()
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

  function focusExisting(key: string) {
    const existing = windows.get(key)?.window
    if (!existing || existing.isDestroyed()) return false
    if (existing.isMinimized()) existing.restore()
    if (existing.isVisible()) existing.focus()
    return true
  }

  async function openWindow(key: string, file: DesktopPreviewWindowFile, reveal?: () => Promise<unknown>, onClose?: () => void) {
    if (focusExisting(key)) return null
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

  async function openExternal(file: DesktopPreviewMetadata, content: (range: string | null) => Promise<Response>,
    reveal?: () => Promise<void>, key?: string) {
    if (key && focusExisting(key)) return
    const token = randomUUID()
    externalContent.set(token, content)
    try {
      await openWindow(key ?? token, {
        ...file, contentUrl: `gugu-desktop://app/__local-files/preview/${token}`, ...(!reveal ? { canReveal: false } : {}),
      }, reveal, () => externalContent.delete(token))
    } catch (error) {
      externalContent.delete(token)
      throw error
    }
  }

  ipcMain.handle(channels.open, (event, file: DesktopPreviewRequest | undefined) => {
    const main = options.mainWindow()
    const mainTrusted = !!main && trustedCaller(event, [main], options.uiUrl)
    if (file && typeof file === 'object' && 'attachmentId' in file) return desktopReply(mainTrusted, async () => {
      if (!options.readAttachment || typeof file.attachmentId !== 'string' || !/^[0-9a-f]{32}$/u.test(file.attachmentId))
        throw new DesktopError('invalid_request', '预览附件无效')
      const key = `attachment:${file.attachmentId}`
      if (focusExisting(key)) return null
      const { displayName, ext, mime, data } = await options.readAttachment(file.attachmentId)
      await openExternal({ displayName, ext, mimeType: mime, sizeBytes: data.byteLength },
        async range => attachmentContent(data, mime, range), undefined, key)
      return null
    })
    if (file && typeof file === 'object' && 'libraryPath' in file) return desktopReply(mainTrusted, async () => {
      if (!options.resolveLibraryPath || typeof file.libraryPath !== 'string'
        || !/^\/(?:personal|project|workspace)\//u.test(file.libraryPath))
        throw new DesktopError('invalid_request', '文件库路径无效')
      const result = await options.resolveLibraryPath(file.libraryPath)
      if ('error' in result) throw new DesktopError('not_found', result.error)
      return open(result.preview)
    })
    const target = file?.workspaceFile
    const command = { action: 'reference', directoryId: target?.directoryId, path: target?.relativePath }
    return desktopReply(mainTrusted || options.trustsProject(event, DESKTOP_CHANNELS.files, command), () => open(file))
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
    return desktopReply(!!entry?.reveal, async () => { await entry?.reveal?.(); return null })
  })

  return {
    open,
    openExternal,
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

/** 附件正文已在宿主校验并限长，独立窗口只通过短期内容令牌读取。 */
function attachmentContent(data: Uint8Array, mime: string, range: string | null) {
  const size = data.byteLength
  const headers = new Headers({
    'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Accept-Ranges': 'bytes',
  })
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/u.exec(range)
    const start = match ? Number(match[1]) : NaN
    const end = match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1
    if (!Number.isSafeInteger(start) || start < 0 || start > end)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(new Uint8Array(data.subarray(start, end + 1)), { status: 206, headers })
  }
  headers.set('Content-Length', String(size))
  return new Response(new Uint8Array(data), { headers })
}
