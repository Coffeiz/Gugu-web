import { DESKTOP_CHANNELS, type DesktopProjectDetails } from '@gugu/core/desktop'
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { projectWindowChannels as channels } from '@gugu/desktop-contracts'
import { DesktopError, desktopReply } from './core-host.js'
import { desktopWindowMaterial, secureWindow, trustedCaller, windowOptions } from './windows.js'

const projectFileActions = new Set(['list', 'reference', 'mkdir', 'upload', 'copy', 'move', 'trash', 'download', 'reveal', 'open', 'search'])

const projectChannels = new Set<string>([
  DESKTOP_CHANNELS.appearance, DESKTOP_CHANNELS.projects, DESKTOP_CHANNELS.projectBoard,
  DESKTOP_CHANNELS.projectDetails, DESKTOP_CHANNELS.updateBoardProject,
  DESKTOP_CHANNELS.deleteBoardProject, DESKTOP_CHANNELS.clients,
])

export function registerProjectWindows(options: {
  mainWindow: () => BrowserWindow | undefined
  uiUrl: string
  preload: string
  quitting: () => boolean
  readProject: (id: number) => Promise<unknown>
}) {
  const windows = new Map<number, { window: BrowserWindow; url: string }>()
  const mainIsTrusted = (event: IpcMainInvokeEvent) => {
    const main = options.mainWindow()
    return !!main && trustedCaller(event, [main], options.uiUrl)
  }

  function projectId(value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw new DesktopError('invalid_request', '项目标识无效')
    return value
  }

  function focus(id: number) {
    const window = windows.get(id)?.window
    if (!window || window.isDestroyed()) return false
    if (window.isMinimized()) window.restore()
    if (window.isVisible()) window.focus()
    return true
  }

  ipcMain.handle(channels.open, (event, value: unknown) => desktopReply(mainIsTrusted(event), async () => {
    const id = projectId(value)
    if (focus(id)) return null
    await options.readProject(id)
    if (focus(id)) return null
    const url = new URL(options.uiUrl)
    url.searchParams.set('projectWindow', String(id))
    url.hash = 'project-boot'
    const mainBounds = options.mainWindow()?.getBounds()
    const point = mainBounds ? { x: mainBounds.x + 150, y: mainBounds.y + 80 } : screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    const minWidth = 800, minHeight = 600
    // 默认 960 × 720，空间不足时按 4:3 收到最小尺寸。
    const sizeUnit = Math.max(minWidth / 4, Math.floor(Math.min(240, area.width / 4, area.height / 3)))
    const width = sizeUnit * 4, height = sizeUnit * 3
    const position = {
      x: Math.min(Math.max(area.x, point.x - 80), area.x + Math.max(0, area.width - width)),
      y: Math.min(Math.max(area.y, point.y - 16), area.y + Math.max(0, area.height - height)),
    }
    const window = new BrowserWindow({
      ...desktopWindowMaterial(),
      ...position,
      title: '咕咕 · 项目',
      frame: false,
      width, height, minWidth, minHeight,
      show: false,
      webPreferences: windowOptions(options.preload).webPreferences,
    })
    secureWindow(window)
    windows.set(id, { window, url: url.href })
    let ready = false
    window.on('close', event => {
      if (!ready || options.quitting() || window.webContents.isCrashed()) return
      event.preventDefault()
      window.webContents.send(channels.prepareClose)
    })
    window.once('closed', () => {
      windows.delete(id)
      const main = options.mainWindow()
      if (main && !main.isDestroyed()) main.webContents.send(channels.closed)
    })
    try {
      await window.loadURL(url.href)
      ready = true
      window.show()
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
    return null
  }))
  ipcMain.handle(channels.close, event => {
    const match = [...windows.values()].find(({ window, url }) => trustedCaller(event, [window], url))
    return desktopReply(!!match, async () => {
      if (match) setImmediate(() => { if (!match.window.isDestroyed()) match.window.destroy() })
      return null
    })
  })

  return {
    publishUpdate(sender: Electron.WebContents, project: DesktopProjectDetails) {
      const recipients = [options.mainWindow(), windows.get(project.id)?.window]
      for (const window of recipients) {
        if (window && !window.isDestroyed() && window.webContents !== sender)
          window.webContents.send(channels.updated, project)
      }
    },
    trusts(event: IpcMainInvokeEvent, channel: string, argument: unknown) {
      for (const [id, { window, url }] of windows) {
        if (!trustedCaller(event, [window], url)) continue
        if (channel === DESKTOP_CHANNELS.startFileDrag) return argument === `project:${id}`
        if (channel !== DESKTOP_CHANNELS.files) return projectChannels.has(channel)
        if (!argument || typeof argument !== 'object' || !('directoryId' in argument) || !('action' in argument)) return false
        return argument.directoryId === `project:${id}`
          && typeof argument.action === 'string' && projectFileActions.has(argument.action)
      }
      return false
    },
  }
}
